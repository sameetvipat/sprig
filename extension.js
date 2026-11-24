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
  lastCheer: 0,
  session: null,       // { intention, start, focusMs, breaks } while a mindful session runs
  diskEdits: [],       // recent on-disk edit times, to notice Claude (or a tool) working
  lastWaitNudge: 0
};

const BREAK_IDEAS = [
  'Stand up, roll your shoulders, and look out a window. 🌿',
  'Walk to the kitchen and back, slowly. Notice your feet. 🚶',
  'Close your eyes and listen: name three sounds you can hear. 👂',
  'Stretch your arms overhead, then let them fall. Twice. 🙆',
  'Get a glass of water and drink it away from the screen. 💧',
  'Look at something far away for 20 seconds. Let your eyes soften. 👀',
  'Unclench your jaw, drop your shoulders, breathe out slowly. 🍃'
];
const FEELINGS = [
  { label: '😌 Calm and clear', key: 'calm' },
  { label: '🙂 Good', key: 'good' },
  { label: '😐 Okay', key: 'okay' },
  { label: '😮‍💨 Tired', key: 'tired' },
  { label: '😣 Stressed', key: 'stressed' }
];

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
      } else if (msg.type === 'intent') {
        state.session ? sessionMenu() : startSession();
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
    breakLeft: onBreak ? Math.ceil((state.onBreakUntil - Date.now()) / 1000) : 0,
    intention: state.session ? state.session.intention : ''
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
    const intent = state.session ? `\n🎯 ${state.session.intention}` : '\nNo session yet: click to set an intention';
    statusItem.tooltip = (isPaused()
      ? `Sprig: reminders paused until ${new Date(state.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : `Sprig: ${fmt(state.focusMs)} focused · break in ~${Math.ceil(left / 60000)}m (click for options)`) + intent;
  }
}

function startBreak() {
  if (Date.now() < state.onBreakUntil) return;
  state.onBreakUntil = Date.now() + minutes('breakMinutes', 1) * 60000;
  state.breaksTaken++;
  if (state.session) { state.session.breaks++; saveSession(); }
  saveDay();
  provider.post({ type: 'mood', mood: 'stretch' });
  say(BREAK_IDEAS[Math.floor(Math.random() * BREAK_IDEAS.length)], 'stretch');
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
  pushStats();
  const s = state.session;
  say(s ? `Welcome back. Still on: “${s.intention}”?` : 'Welcome back. What would you like to focus on next?', 'happy');
  if (early && !s) return;
  // Coming back is a good moment to re-check the intention.
  const msg = s ? `🌱 Welcome back. Still working on “${s.intention}”?` : '🌱 Break\'s over. Set an intention for the next stretch?';
  const buttons = s ? ['Yes, continue', 'New intention', 'End & reflect'] : ['Set intention'];
  if (!early && !cfg('breakNotifications')) return;
  vscode.window.showInformationMessage(msg, ...buttons).then((c) => {
    if (c === 'New intention') changeIntention();
    else if (c === 'End & reflect') endSession();
    else if (c === 'Set intention') startSession();
  });
}

// ----- Mindful sessions: intention → focus → breaks → reflection -----

function saveSession() {
  extContext.globalState.update('sprig.session', state.session);
}

async function askIntention(value) {
  const text = await vscode.window.showInputBox({
    title: 'Sprig: set an intention',
    prompt: 'One small, clear thing you want to do in this session.',
    placeHolder: 'e.g. Fix the login bug · Write tests for the parser · Read the API docs',
    value,
    validateInput: (v) => (v.trim().length > 80 ? 'Keep it short: 80 characters or less.' : undefined)
  });
  return text && text.trim();
}

async function startSession() {
  if (state.session) return sessionMenu();
  const intention = await askIntention();
  if (!intention) return;
  state.session = { intention, start: Date.now(), focusMs: 0, breaks: 0 };
  state.focusMs = 0; state.eyeMs = 0; state.snoozeUntil = 0;
  saveSession();
  pushStats();
  provider.post({ type: 'breathe', cycles: 1 }); // one settling breath to begin
  say(`Let's begin. One breath first, then: “${intention}”. 🌱`, 'calm');
}

async function changeIntention() {
  if (!state.session) return startSession();
  const intention = await askIntention(state.session.intention);
  if (!intention) return;
  state.session.intention = intention;
  saveSession();
  pushStats();
  say(`New focus: “${intention}”.`, 'calm');
}

async function endSession() {
  const s = state.session;
  if (!s) return;
  const done = await vscode.window.showQuickPick(
    [{ label: '✅ Yes', key: 'yes' }, { label: '🌗 Partly', key: 'partly' }, { label: '🌱 Not yet, and that\'s okay', key: 'no' }],
    { title: 'Sprig: reflect', placeHolder: `Did you do what you set out to do? “${s.intention}”`, ignoreFocusOut: true }
  );
  if (!done) return; // cancelled: the session keeps going
  const feeling = await vscode.window.showQuickPick(FEELINGS, { title: 'Sprig: reflect', placeHolder: 'How do you feel right now?', ignoreFocusOut: true });
  const note = await vscode.window.showInputBox({ title: 'Sprig: reflect', prompt: 'One note for future you (optional). What helped, what got in the way?', ignoreFocusOut: true });
  archiveSession({ done: done.key, feeling: feeling ? feeling.key : null, note: (note || '').trim() });
  const reply = {
    yes: 'You did what you set out to do. Let that land for a second. 🌿',
    partly: 'Progress counts. Tomorrow-you will pick it up from here. 🌗',
    no: 'Some sessions are for learning what\'s hard. Be kind to yourself. 🌱'
  }[done.key];
  say(feeling && (feeling.key === 'tired' || feeling.key === 'stressed') ? `${reply} Maybe a proper rest before the next one.` : reply, 'happy');
}

function archiveSession(reflection) {
  const s = state.session;
  const journal = extContext.globalState.get('sprig.journal', []);
  journal.push({ ...s, end: Date.now(), ...reflection });
  extContext.globalState.update('sprig.journal', journal.slice(-200));
  state.session = null;
  saveSession();
  pushStats();
}

async function sessionMenu() {
  const s = state.session;
  if (!s) return startSession();
  const pick = await vscode.window.showQuickPick(
    [{ label: '$(edit) Change intention', run: changeIntention }, { label: '$(check) End session & reflect', run: endSession }],
    { placeHolder: `🎯 ${s.intention} · ${fmt(s.focusMs)} focused · ${s.breaks} breaks` }
  );
  if (pick) pick.run();
}

async function openJournal() {
  const journal = extContext.globalState.get('sprig.journal', []);
  const icon = { yes: '✅', partly: '🌗', no: '🌱' };
  const feel = Object.fromEntries(FEELINGS.map((f) => [f.key, f.label]));
  const lines = ['# Sprig: mindful coding journal', ''];
  if (!journal.length) lines.push('_No sessions yet. Start one from the Sprig menu: set an intention, focus, take breaks, then reflect._');
  let lastDay = '';
  for (const e of journal.slice().reverse()) {
    const d = new Date(e.start);
    const day = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (day !== lastDay) { lines.push(`## ${day}`, ''); lastDay = day; }
    const t = (x) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lines.push(`### ${icon[e.done] || '·'} ${e.intention}`);
    lines.push(`${t(e.start)}–${t(e.end)} · ${fmt(e.focusMs)} focused · ${e.breaks} break${e.breaks === 1 ? '' : 's'}${e.feeling ? ` · felt ${feel[e.feeling]}` : ''}`);
    if (e.note) lines.push('', `> ${e.note}`);
    lines.push('');
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
  await vscode.window.showTextDocument(doc, { preview: true });
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
  { id: 'clawd', label: '🧡 Clawd' },
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
  { id: 'bee', label: '🐝 Buzz the Bee' }
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
  const s = state.session;
  const items = [
    s ? { label: '$(check) End session & reflect', description: `🎯 ${s.intention}`, run: endSession }
      : { label: '$(target) Start a mindful session…', description: 'set an intention', run: startSession },
    ...(s ? [{ label: '$(edit) Change intention', run: changeIntention }] : []),
    { label: '$(pulse) Breathe with me (1 min)', run: breathe },
    onBreak ? { label: '$(debug-stop) End break', run: () => endBreak(true) } : { label: '$(coffee) Take a break now', run: startBreak },
    { label: isPaused() ? '$(bell) Resume reminders' : '$(bell-slash) Pause reminders…', run: pause },
    { label: '$(book) Mindful journal', run: openJournal },
    { label: '$(graph) This week\'s focus', run: showStats },
    { label: '$(refresh) Reset focus timer', run: resetFocus },
    { label: '$(smiley) Choose pet…', run: choosePet },
    { label: '$(eye) Show pet', run: () => vscode.commands.executeCommand('sprig.petView.focus') }
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
    if (state.session) { state.session.focusMs += TICK_MS; saveSession(); }
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

  let lastPost = 0, lastKeystroke = 0;
  const markActive = () => {
    state.lastTyping = Date.now();
    if (state.lastTyping - lastPost > 400) {
      lastPost = state.lastTyping;
      provider.post({ type: 'typing' });
    }
  };
  // Edits made outside the editor (e.g. by Claude Code) only show up on disk. Only works with a folder open.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onDisk = (uri) => {
    if (/[\\/](\.git|node_modules|dist|out|build)[\\/]/.test(uri.fsPath)) return;
    markActive();
    // A burst of edits you didn't type means Claude (or a tool) is working: a good moment to breathe instead of watching.
    const now = Date.now();
    state.diskEdits = state.diskEdits.filter((t) => now - t < 20000).concat(now);
    const typedRecently = now - lastKeystroke < 10000;
    if (state.diskEdits.length >= 4 && !typedRecently && now - state.lastWaitNudge > 20 * 60000 && !isPaused() && now >= state.onBreakUntil) {
      state.lastWaitNudge = now;
      say('Something\'s working on your code. While it does, try one slow breath: in for 4, out for 6. 🍃', 'calm');
    }
  };
  context.subscriptions.push(
    watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return; // dirty-state flips, not edits
      if (e.document.uri.scheme !== 'file' && e.document.uri.scheme !== 'untitled') return;
      lastKeystroke = Date.now();
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
    vscode.commands.registerCommand('sprig.startSession', startSession),
    vscode.commands.registerCommand('sprig.endSession', () => (state.session ? endSession() : vscode.window.showInformationMessage('Sprig: no session is running.'))),
    vscode.commands.registerCommand('sprig.changeIntention', changeIntention),
    vscode.commands.registerCommand('sprig.journal', openJournal),
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

  state.session = context.globalState.get('sprig.session') || null;
  // A session left open for over 16 hours was forgotten: file it in the journal without a reflection.
  if (state.session && Date.now() - state.session.start > 16 * 3600000) archiveSession({ done: null, feeling: null, note: '' });

  tick = setInterval(onTick, TICK_MS);
  context.subscriptions.push({ dispose: () => { clearInterval(tick); clearInterval(breakTick); } });

  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning!' : h < 17 ? 'Good afternoon!' : 'Good evening!';
  say(state.session
    ? `${greet} Picking up where you left off: “${state.session.intention}”.`
    : `${greet} Take one slow breath, then set an intention to begin. 🌱`, 'happy');
  updateStatus();
}

function deactivate() {
  clearInterval(tick);
  clearInterval(breakTick);
  if (extContext && state.day) saveDay();
}

module.exports = { activate, deactivate };
