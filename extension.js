const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const ACTIVE_WINDOW_MS = 2 * 60 * 1000; // a minute counts as "focused" if you typed in the last 2 min
const TICK_MS = 15000;
const HISTORY_DAYS = 7;

let provider;
let statusItem;
let tick;
let breakTick;
let extContext;

const state = {
  focusMs: 0,          // active coding time since last break
  eyeMs: 0,
  waterMs: 0,
  lastTyping: 0,
  onBreakUntil: 0,
  snoozeUntil: 0,
  pausedUntil: 0,      // reminders muted until this time
  day: '',
  todayFocusMs: 0,
  breaksTaken: 0,
  errors: 0,
  lastCheer: 0
};

function cfg(key) {
  return vscode.workspace.getConfiguration('sprig').get(key);
}
function minutes(key, min) {
  const v = Number(cfg(key));
  return Number.isFinite(v) ? Math.max(min, v) : min;
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

class PetViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.queue = [];
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    const html = fs.readFileSync(path.join(this.context.extensionPath, 'media', 'pet.html'), 'utf8');
    view.webview.html = html.replace(/\{\{nonce\}\}/g, nonce()).replace(/\{\{csp\}\}/g, view.webview.cspSource);

    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready') {
        view.webview.postMessage({ type: 'pet', id: cfg('pet') });
        this.queue.forEach((m) => view.webview.postMessage(m));
        this.queue = [];
        pushStats();
      } else if (msg.type === 'startBreak') {
        startBreak();
      } else if (msg.type === 'choosePet') {
        choosePet();
      } else if (msg.type === 'endBreak') {
        endBreak(true);
      }
    });
    view.onDidDispose(() => { this.view = undefined; });
  }

  post(msg) {
    if (this.view) return void this.view.webview.postMessage(msg);
    // Only queue messages worth replaying; 'ready' re-sends the pet and stats anyway.
    if (msg.type === 'say' || msg.type === 'mood' || msg.type === 'breathe') {
      this.queue.push(msg);
      if (this.queue.length > 5) this.queue.shift();
    }
  }
}

function nonce() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function say(text, mood) {
  provider.post({ type: 'say', text, mood });
}

function fmt(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

const isPaused = () => Date.now() < state.pausedUntil;

function pushStats() {
  const onBreak = Date.now() < state.onBreakUntil;
  provider.post({
    type: 'stats',
    focus: fmt(state.focusMs),
    today: fmt(state.todayFocusMs),
    breaks: state.breaksTaken,
    onBreak,
    breakLeft: onBreak ? Math.ceil((state.onBreakUntil - Date.now()) / 1000) : 0
  });
  updateStatus();
}

function updateStatus() {
  const now = Date.now();
  if (now < state.onBreakUntil) {
    const s = Math.ceil((state.onBreakUntil - now) / 1000);
    statusItem.text = `$(heart) break ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    statusItem.tooltip = 'Sprig: enjoy your break (click for options)';
  } else {
    const left = Math.max(0, minutes('focusMinutes', 1) * 60000 - state.focusMs);
    statusItem.text = `🌱 ${fmt(state.focusMs)}${isPaused() ? ' $(bell-slash)' : ''}`;
    statusItem.tooltip = isPaused()
      ? `Sprig: reminders paused until ${new Date(state.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : `Sprig: ${fmt(state.focusMs)} focused · break in ~${Math.ceil(left / 60000)}m (click for options)`;
  }
}

function startBreak() {
  if (Date.now() < state.onBreakUntil) return;
  state.onBreakUntil = Date.now() + minutes('breakMinutes', 1) * 60000;
  state.breaksTaken++;
  saveDay();
  provider.post({ type: 'mood', mood: 'stretch' });
  say('Stand up, roll your shoulders, look out a window. I\'ll keep your code warm. 🌿', 'stretch');
  // Tick every second during a break so the countdown is smooth and the break ends on time.
  clearInterval(breakTick);
  breakTick = setInterval(() => (Date.now() >= state.onBreakUntil ? endBreak(false) : pushStats()), 1000);
  pushStats();
}

function endBreak(early) {
  clearInterval(breakTick);
  if (!state.onBreakUntil) return;
  state.onBreakUntil = 0;
  state.focusMs = 0;
  state.eyeMs = 0;
  state.snoozeUntil = 0;
  say(early ? 'Welcome back! Set one small intention for this next stretch.' : 'Break\'s over — welcome back. One small intention for the next session?', 'happy');
  if (!early && cfg('breakNotifications')) vscode.window.showInformationMessage('🌱 Sprig: break\'s over — welcome back!');
  pushStats();
}

function suggestBreak() {
  if (Date.now() < state.snoozeUntil) return;
  state.snoozeUntil = Date.now() + 10 * 60000; // don't nag every tick
  provider.post({ type: 'mood', mood: 'stretch' });
  say(`${fmt(state.focusMs)} of focus — lovely. Time for a ${minutes('breakMinutes', 1)}-minute break?`, 'stretch');
  if (cfg('breakNotifications')) {
    vscode.window
      .showInformationMessage(`🌱 Sprig: you've focused for ${fmt(state.focusMs)}. Take a ${minutes('breakMinutes', 1)}-minute break?`, 'Take break', 'Breathe 1 min', 'Snooze 10 min')
      .then((choice) => {
        if (choice === 'Take break') startBreak();
        else if (choice === 'Breathe 1 min') breathe();
      });
  }
}

const PETS = [
  { id: 'sprout', label: '🌱 Sprig the Sprout' },
  { id: 'cat', label: '🐱 Miso the Cat' },
  { id: 'ghost', label: '👻 Boo the Ghost' },
  { id: 'robot', label: '🤖 Bolt the Robot' },
  { id: 'frog', label: '🐸 Pip the Frog' },
  { id: 'penguin', label: '🐧 Waddle the Penguin' },
  { id: 'mug', label: '☕ Bean the Coffee Mug' },
  { id: 'alien', label: '👽 Zib the Alien' },
  { id: 'computer', label: '🖥️ Byte the Computer' },
  { id: 'bunny', label: '🐰 Mochi the Bunny' },
  { id: 'fox', label: '🦊 Ember the Fox' },
  { id: 'axolotl', label: '🩷 Lumi the Axolotl' },
  { id: 'panda', label: '🐼 Bao the Panda' },
  { id: 'duck', label: '🐥 Puddle the Duckling' },
  { id: 'octopus', label: '🐙 Inky the Octopus' },
  { id: 'dragon', label: '🐉 Cinder the Dragon' },
  { id: 'mushroom', label: '🍄 Morel the Mushroom' },
  { id: 'hamster', label: '🐹 Nugget the Hamster' },
  { id: 'owl', label: '🦉 Hoot the Owl' },
  { id: 'slime', label: '💧 Gloop the Slime' },
  { id: 'bee', label: '🐝 Buzz the Bee' },
  { id: 'clawd', label: '🧡 Clawd' }
];

async function choosePet() {
  const current = cfg('pet');
  if (!provider.view || !provider.view.visible) await vscode.commands.executeCommand('sprig.petView.focus');
  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Choose your coding companion (use ↑/↓ to preview)';
  qp.items = PETS.map((p) => ({ label: p.label, description: p.id === current ? 'current' : '', id: p.id }));
  qp.activeItems = qp.items.filter((i) => i.id === current);
  let chosen;
  qp.onDidChangeActive(([item]) => item && provider.post({ type: 'pet', id: item.id }));
  qp.onDidAccept(() => { chosen = qp.activeItems[0]; qp.hide(); });
  qp.onDidHide(async () => {
    qp.dispose();
    if (!chosen || chosen.id === current) return provider.post({ type: 'pet', id: current }); // cancelled: put the old pet back
    await vscode.workspace.getConfiguration('sprig').update('pet', chosen.id, vscode.ConfigurationTarget.Global);
  });
  qp.show();
}

function breathe() {
  vscode.commands.executeCommand('sprig.petView.focus');
  provider.post({ type: 'breathe', cycles: 4 });
}

async function pause() {
  const tomorrow = new Date(); tomorrow.setHours(24, 0, 0, 0);
  const items = [
    { label: '30 minutes', until: Date.now() + 30 * 60000 },
    { label: '1 hour', until: Date.now() + 60 * 60000 },
    { label: '2 hours', until: Date.now() + 120 * 60000 },
    { label: 'Until tomorrow', until: tomorrow.getTime() }
  ];
  if (isPaused()) items.unshift({ label: '$(bell) Resume reminders now', until: 0 });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pause Sprig\'s reminders for…' });
  if (!pick) return;
  state.pausedUntil = pick.until;
  say(pick.until ? 'Got it — I\'ll stay quiet for a while. 🤫' : 'Reminders are back on. 🌱', 'calm');
  updateStatus();
}

function history() {
  return extContext.globalState.get('sprig.history', {});
}

async function showStats() {
  const h = history();
  const days = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push({ d, ms: i === 0 ? state.todayFocusMs : h[dayKey(d)] || 0 });
  }
  const max = Math.max(...days.map((x) => x.ms), 1);
  const total = days.reduce((a, x) => a + x.ms, 0);
  await vscode.window.showQuickPick(
    days.map(({ d, ms }) => ({
      label: d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
      description: fmt(ms),
      detail: '█'.repeat(Math.round((ms / max) * 20)) || '·'
    })),
    { placeHolder: `Focus over the last ${HISTORY_DAYS} days: ${fmt(total)} total · ${state.breaksTaken} breaks today` }
  );
}

async function menu() {
  const onBreak = Date.now() < state.onBreakUntil;
  const items = [
    { label: '$(eye) Show pet', run: () => vscode.commands.executeCommand('sprig.petView.focus') },
    { label: '$(pulse) Breathe with me (1 min)', run: breathe },
    onBreak ? { label: '$(debug-stop) End break', run: () => endBreak(true) } : { label: '$(coffee) Take a break now', run: startBreak },
    { label: isPaused() ? '$(bell) Resume reminders' : '$(bell-slash) Pause reminders…', run: pause },
    { label: '$(graph) This week\'s focus', run: showStats },
    { label: '$(refresh) Reset focus timer', run: resetFocus },
    { label: '$(smiley) Choose pet…', run: choosePet }
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Sprig · ${fmt(state.focusMs)} focused · ${fmt(state.todayFocusMs)} today` });
  if (pick) pick.run();
}

function resetFocus() {
  state.focusMs = 0; state.eyeMs = 0; state.snoozeUntil = 0;
  pushStats();
  say('Fresh start. 🌱', 'happy');
}

function saveDay() {
  // shortcut: each VS Code window keeps its own counts and the last one to save wins; merge them if you use several windows.
  extContext.globalState.update('sprig.today', { day: state.day, focusMs: state.todayFocusMs, breaks: state.breaksTaken });
  const h = history();
  h[state.day] = state.todayFocusMs;
  const keep = Object.keys(h).sort().slice(-HISTORY_DAYS * 2);
  extContext.globalState.update('sprig.history', Object.fromEntries(keep.map((k) => [k, h[k]])));
}

function rollDay() {
  const day = dayKey();
  if (day === state.day) return;
  if (state.day) saveDay(); // close out yesterday before resetting
  state.day = day; state.todayFocusMs = 0; state.breaksTaken = 0;
}

function onTick() {
  const now = Date.now();
  rollDay();

  if (now < state.onBreakUntil) return;
  if (state.onBreakUntil) endBreak(false);

  const active = now - state.lastTyping < ACTIVE_WINDOW_MS;
  if (active) {
    state.focusMs += TICK_MS;
    state.todayFocusMs += TICK_MS;
    state.eyeMs += TICK_MS;
  }
  state.waterMs += TICK_MS;
  saveDay();

  if (!isPaused()) {
    const eye = Number(cfg('eyeReminderMinutes')) || 0;
    if (eye > 0 && state.eyeMs >= eye * 60000) {
      state.eyeMs = 0;
      say('👀 20-20-20: look at something ~20 feet away for 20 seconds.', 'calm');
    }
    const water = Number(cfg('hydrationMinutes')) || 0;
    if (water > 0 && state.waterMs >= water * 60000 && active) {
      state.waterMs = 0;
      say('💧 Sip of water? Little and often.', 'happy');
    }
    if (state.focusMs >= minutes('focusMinutes', 1) * 60000) suggestBreak();

    const hour = new Date().getHours();
    if (active && hour >= 1 && hour < 5 && Math.random() < 0.02) {
      say('🌙 It\'s late. Future-you will debug better after some sleep.', 'sleepy');
    }
  }
  pushStats();
}

function countErrors() {
  let n = 0;
  for (const [, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) if (d.severity === vscode.DiagnosticSeverity.Error) n++;
  }
  return n;
}

function activate(context) {
  extContext = context;
  state.day = dayKey();
  const saved = context.globalState.get('sprig.today');
  if (saved && saved.day === state.day) { state.todayFocusMs = saved.focusMs || 0; state.breaksTaken = saved.breaks || 0; }
  state.errors = countErrors();

  provider = new PetViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sprig.petView', provider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'sprig.menu';
  statusItem.show();
  context.subscriptions.push(statusItem);

  let lastPost = 0;
  const markActive = () => {
    state.lastTyping = Date.now();
    if (state.lastTyping - lastPost > 400) {
      lastPost = state.lastTyping;
      provider.post({ type: 'typing' });
    }
  };
  // Edits made outside the editor (e.g. by Claude Code) only show up on disk. Only works with a folder open.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onDisk = (uri) => { if (!/[\\/](\.git|node_modules|dist|out|build)[\\/]/.test(uri.fsPath)) markActive(); };
  context.subscriptions.push(
    watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return; // dirty-state flips, not edits
      if (e.document.uri.scheme !== 'file' && e.document.uri.scheme !== 'untitled') return;
      markActive();
    }),
    vscode.workspace.onDidSaveTextDocument(() => provider.post({ type: 'saved' })),
    vscode.languages.onDidChangeDiagnostics(() => {
      const n = countErrors();
      // Cheer when the last error goes away, at most every 2 minutes.
      if (state.errors > 0 && n === 0 && Date.now() - state.lastCheer > 120000 && !isPaused()) {
        state.lastCheer = Date.now();
        say('No errors left. Nice work! ✨', 'happy');
      }
      state.errors = n;
    }),
    vscode.commands.registerCommand('sprig.show', () => vscode.commands.executeCommand('sprig.petView.focus')),
    vscode.commands.registerCommand('sprig.menu', menu),
    vscode.commands.registerCommand('sprig.breathe', breathe),
    vscode.commands.registerCommand('sprig.choosePet', choosePet),
    vscode.commands.registerCommand('sprig.pause', pause),
    vscode.commands.registerCommand('sprig.stats', showStats),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('sprig.pet')) {
        provider.post({ type: 'pet', id: cfg('pet') });
        say('Hi! Nice to meet you. 👋', 'happy');
      }
      if (ev.affectsConfiguration('sprig')) updateStatus();
    }),
    vscode.commands.registerCommand('sprig.startBreak', startBreak),
    vscode.commands.registerCommand('sprig.resetFocus', resetFocus)
  );

  tick = setInterval(onTick, TICK_MS);
  context.subscriptions.push({ dispose: () => { clearInterval(tick); clearInterval(breakTick); } });

  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning!' : h < 17 ? 'Good afternoon!' : 'Good evening!';
  say(`${greet} Take one slow breath before you start. 🌱`, 'happy');
  updateStatus();
}

function deactivate() {
  clearInterval(tick);
  clearInterval(breakTick);
  if (extContext && state.day) saveDay();
}

module.exports = { activate, deactivate };
