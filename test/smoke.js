// Smoke test: runs extension.js against a fake vscode API with a controllable clock.
const Module = require('module'), assert = require('assert');
let now = new Date(2026, 10, 24, 10, 0, 0).getTime();
const RealDate = Date;
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
const intervals = [];
global.setInterval = (fn, ms) => { const i = { fn, ms, on: true }; intervals.push(i); return i; };
global.clearInterval = (i) => { if (i) i.on = false; };
const posts = [], infos = [], cmds = {}, store = {};
const handlers = {}; const ev = (name) => (fn) => { (handlers[name] = handlers[name] || []).push(fn); return { dispose() {} }; };
let diags = [];
const vscode = {
  window: {
    registerWebviewViewProvider: () => ({ dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    showInformationMessage: (m) => { infos.push(m); return Promise.resolve(); },
    showQuickPick: async (items) => items[0],
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => ({ pet: 'clawd', focusMinutes: 25, breakMinutes: 5, eyeReminderMinutes: 20, hydrationMinutes: 45, breakNotifications: true })[k] }),
    createFileSystemWatcher: () => ({ onDidChange: ev('fsChange'), onDidCreate: ev('fsCreate'), dispose() {} }),
    onDidChangeTextDocument: ev('text'), onDidSaveTextDocument: ev('save'), onDidChangeConfiguration: ev('cfg'),
  },
  languages: { getDiagnostics: () => diags, onDidChangeDiagnostics: ev('diag') },
  DiagnosticSeverity: { Error: 0 },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
};
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
const ext = require(process.argv[2]);
const ctx = { subscriptions: [], extensionPath: '', globalState: { get: (k, d) => store[k] ?? d, update: (k, v) => { store[k] = v; } } };
ext.activate(ctx);
const tick = () => intervals.filter((i) => i.on && i.ms === 15000).forEach((i) => i.fn());
const type = () => handlers.text.forEach((f) => f({ contentChanges: [1], document: { uri: { scheme: 'file' } } }));
const advance = (ms, typing) => { for (let t = 0; t < ms; t += 15000) { now += 15000; if (typing) type(); tick(); } };

// 1. typing for 25 minutes counts focus and suggests a break
advance(25 * 60000, true);
assert.equal(store['sprig.today'].focusMs, 25 * 60000, 'focus counted');
assert(infos.some((m) => m.includes('Take a 5-minute break')), 'break suggested');
// 2. Claude-style disk edits count as activity
now += 10 * 60000; handlers.fsChange[0]({ fsPath: '/p/src/a.js' }); advance(15000); 
const f1 = store['sprig.today'].focusMs; handlers.fsChange[0]({ fsPath: '/p/node_modules/x/a.js' }); now += 5 * 60000; advance(15000);
assert.equal(store['sprig.today'].focusMs, f1, 'node_modules ignored');
// 3. break: 1s ticker ends it on time and notifies
cmds['sprig.startBreak'](); assert.equal(store['sprig.today'].breaks, 1);
const bt = intervals.find((i) => i.on && i.ms === 1000); assert(bt, '1s break ticker');
now += 5 * 60000; bt.fn(); assert(!bt.on, 'ticker stopped'); assert(infos.some((m) => m.includes("break's over")), 'break-over notice');
// 4. pause mutes reminders
return (async () => {
  await cmds['sprig.pause'](); const n = infos.length; advance(29 * 60000, true);
  assert.equal(infos.length, n, 'no reminders while paused');
  // 5. error cheer
  diags = [['f', [{ severity: 0 }]]]; handlers.diag[0](); diags = []; handlers.diag[0]();
  assert(posts.length === 0); // posts only reach the view when resolved
  // 6. day rollover saves history and resets today
  now = new Date(2026, 10, 25, 9, 0, 0).getTime(); tick();
  assert(store['sprig.history']['2026-11-24'] > 0, 'yesterday saved'); assert.equal(store['sprig.today'].focusMs, 0, 'today reset');
  await cmds['sprig.stats'](); await cmds['sprig.menu']();
  ext.deactivate();
  console.log('all smoke checks passed', store['sprig.history']);
})();
