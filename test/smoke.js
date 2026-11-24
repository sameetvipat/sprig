// Smoke test: runs extension.js against a fake vscode API with a controllable clock.
// Usage: node test/smoke.js
const Module = require('module'), assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..');

let now = new Date(2026, 10, 24, 10, 0, 0).getTime();
const RealDate = Date;
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
const intervals = [];
global.setInterval = (fn, ms) => { const i = { fn, ms, on: true }; intervals.push(i); return i; };
global.clearInterval = (i) => { if (i) i.on = false; };

const posts = [], infos = [], cmds = {}, store = {}, docs = [], handlers = {};
const ev = (name) => (fn) => { (handlers[name] = handlers[name] || []).push(fn); return { dispose() {} }; };
const inputs = []; // queued answers for showInputBox
let diags = [], viewProvider;
const vscode = {
  window: {
    registerWebviewViewProvider: (_id, p) => { viewProvider = p; return { dispose() {} }; },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    showInformationMessage: (m) => { infos.push(m); return Promise.resolve(); },
    showQuickPick: async (items) => items[0],
    showInputBox: async () => inputs.shift(),
    showTextDocument: async () => {},
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => ({ pet: 'clawd', focusMinutes: 25, breakMinutes: 5, eyeReminderMinutes: 20, hydrationMinutes: 45, breakNotifications: true })[k] }),
    createFileSystemWatcher: () => ({ onDidChange: ev('fsChange'), onDidCreate: ev('fsCreate'), dispose() {} }),
    onDidChangeTextDocument: ev('text'), onDidSaveTextDocument: ev('save'), onDidChangeConfiguration: ev('cfg'),
    openTextDocument: async (o) => { docs.push(o.content); return {}; },
  },
  languages: { getDiagnostics: () => diags, onDidChangeDiagnostics: ev('diag') },
  DiagnosticSeverity: { Error: 0 },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };

const ext = require(path.join(root, 'extension.js'));
const ctx = { subscriptions: [], extensionPath: root, globalState: { get: (k, d) => store[k] ?? d, update: (k, v) => { store[k] = v; } } };
ext.activate(ctx);
viewProvider.resolveWebviewView({ webview: { options: {}, html: '', postMessage: (m) => posts.push(m), onDidReceiveMessage() {} }, onDidDispose() {}, visible: true });

const said = (re) => posts.some((m) => m.type === 'say' && re.test(m.text));
const tick = () => intervals.filter((i) => i.on && i.ms === 15000).forEach((i) => i.fn());
const type = () => handlers.text.forEach((f) => f({ contentChanges: [1], document: { uri: { scheme: 'file' } } }));
const advance = (ms, typing) => { for (let t = 0; t < ms; t += 15000) { now += 15000; if (typing) type(); tick(); } };

(async () => {
  // 1. start a session with an intention
  inputs.push('Fix the login bug');
  await cmds['sprig.startSession']();
  assert.equal(store['sprig.session'].intention, 'Fix the login bug');
  assert(posts.some((m) => m.type === 'breathe' && m.cycles === 1), 'settling breath');
  assert(posts.some((m) => m.type === 'stats' && m.intention === 'Fix the login bug'), 'panel shows intention');

  // 2. typing for 25 minutes counts focus (today + session) and suggests a break
  advance(25 * 60000, true);
  assert.equal(store['sprig.today'].focusMs, 25 * 60000);
  assert.equal(store['sprig.session'].focusMs, 25 * 60000);
  assert(infos.some((m) => m.includes('Take a 5-minute break')), 'break suggested');

  // 3. a burst of disk edits you didn't type → breathe nudge; node_modules ignored
  now += 60000;
  const fs = handlers.fsChange[0];
  for (let i = 0; i < 4; i++) { now += 1000; fs({ fsPath: '/p/src/a.js' }); }
  assert(said(/slow breath/), 'Claude-working nudge');
  const f1 = store['sprig.today'].focusMs;
  now += 5 * 60000; fs({ fsPath: '/p/node_modules/x/a.js' }); advance(15000);
  assert.equal(store['sprig.today'].focusMs, f1, 'node_modules ignored');

  // 4. break: counted in session, 1s ticker ends it on time, check-in names the intention
  cmds['sprig.startBreak']();
  assert.equal(store['sprig.today'].breaks, 1);
  assert.equal(store['sprig.session'].breaks, 1);
  const bt = intervals.find((i) => i.on && i.ms === 1000);
  now += 5 * 60000; bt.fn();
  assert(!bt.on, 'break ticker stopped');
  assert(infos.some((m) => m.includes('Still working on “Fix the login bug”')), 'post-break check-in');

  // 5. pause mutes reminders
  await cmds['sprig.pause']();
  const n = infos.length; advance(29 * 60000, true);
  assert.equal(infos.length, n, 'no reminders while paused');

  // 6. clearing the last error cheers (pause is over now)
  now += 60000;
  diags = [['f', [{ severity: 0 }]]]; handlers.diag[0]();
  diags = []; handlers.diag[0]();
  assert(said(/No errors left/), 'error cheer');

  // 7. end & reflect → journal entry, session cleared, journal renders
  inputs.push('Writing a failing test first helped');
  await cmds['sprig.endSession']();
  const j = store['sprig.journal'];
  assert.equal(j.length, 1);
  assert.deepEqual([j[0].intention, j[0].done, j[0].feeling, j[0].note], ['Fix the login bug', 'yes', 'calm', 'Writing a failing test first helped']);
  assert.equal(store['sprig.session'], null);
  await cmds['sprig.journal']();
  assert(docs[0].includes('✅ Fix the login bug') && docs[0].includes('> Writing a failing test first helped'), 'journal markdown');

  // 8. day rollover saves history and resets today
  now = new Date(2026, 10, 25, 9, 0, 0).getTime(); tick();
  assert(store['sprig.history']['2026-11-24'] > 0, 'yesterday saved');
  assert.equal(store['sprig.today'].focusMs, 0, 'today reset');
  await cmds['sprig.stats'](); await cmds['sprig.menu']();
  ext.deactivate();
  console.log('all smoke checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
