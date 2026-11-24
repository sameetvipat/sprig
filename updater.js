// Self-update from GitHub Releases. Sprig isn't in a store, so VS Code can't update it.
// Once a day it asks GitHub for the latest release; the user decides whether to install it.
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'sameetvipat/sprig';
const ASSET = 'sprig.vsix';
const DAY_MS = 24 * 3600 * 1000;
const MAX_VSIX_BYTES = 10 * 1024 * 1024;
const ALLOWED_HOSTS = /^(api\.github\.com|github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)$/;

// '1.2.10' > '1.2.9'; ignores a leading 'v'. Returns true when `a` is newer than `b`.
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// HTTPS GET that follows redirects, only to GitHub hosts, and caps the size.
function get(url, { json = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) return reject(new Error(`Refusing to fetch ${u.hostname}`));
    const req = https.get(u, { headers: { 'User-Agent': 'sprig-vscode-extension', Accept: json ? 'application/vnd.github+json' : '*/*' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(get(new URL(res.headers.location, u).toString(), { json, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub answered ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_VSIX_BYTES) { req.destroy(); reject(new Error('Download too large')); } else chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!json) return resolve(buf);
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub took too long to answer')));
    req.on('error', reject);
  });
}

// { version, url, notesUrl } for the latest release that ships sprig.vsix, or null.
async function latestRelease() {
  const r = await get(`https://api.github.com/repos/${REPO}/releases/latest`, { json: true });
  const asset = (r.assets || []).find((a) => a.name === ASSET);
  if (!asset || !r.tag_name) return null;
  return { version: r.tag_name.replace(/^v/, ''), url: asset.browser_download_url, notesUrl: r.html_url };
}

// Downloads the .vsix to a temp file and checks it looks like one (a zip with an extension manifest).
async function download(release) {
  const buf = await get(release.url);
  if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50 || !buf.includes('extension.vsixmanifest')) {
    throw new Error('The downloaded file is not a valid extension package');
  }
  const file = path.join(os.tmpdir(), `sprig-${release.version}.vsix`);
  fs.writeFileSync(file, buf);
  return file;
}

async function check(context, { manual = false } = {}) {
  const vscode = require('vscode');
  const cfg = vscode.workspace.getConfiguration('sprig');
  if (!manual) {
    if (cfg.get('checkForUpdates') === false) return;
    if (Date.now() - context.globalState.get('sprig.lastUpdateCheck', 0) < DAY_MS) return;
  }
  const current = context.extension.packageJSON.version;
  let release;
  try {
    release = await latestRelease();
    context.globalState.update('sprig.lastUpdateCheck', Date.now());
  } catch (e) {
    if (manual) vscode.window.showWarningMessage(`Sprig: couldn't check for updates (${e.message}).`);
    return; // offline or GitHub unavailable: try again next time, quietly
  }
  if (!release || !newer(release.version, current)) {
    if (manual) vscode.window.showInformationMessage(`🌱 Sprig is up to date (${current}).`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `🌱 Sprig ${release.version} is available (you have ${current}).`, 'Update', 'What\'s new', 'Later');
  if (choice === 'What\'s new') return vscode.env.openExternal(vscode.Uri.parse(release.notesUrl));
  if (choice !== 'Update') return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating Sprig to ${release.version}…` },
      async () => {
        const file = await download(release);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        fs.unlink(file, () => {});
      });
  } catch (e) {
    vscode.window.showErrorMessage(`Sprig: the update failed (${e.message}). You can download it from GitHub instead.`, 'Open releases')
      .then((c) => c && vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${REPO}/releases/latest`)));
    return;
  }
  const reload = await vscode.window.showInformationMessage(`🌱 Sprig ${release.version} is installed. Reload to start using it.`, 'Reload now');
  if (reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

module.exports = { check, newer, latestRelease, download };
