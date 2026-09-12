const board = document.getElementById('board');
const summary = document.getElementById('summary');
const error = document.getElementById('error');
const terminalView = document.getElementById('terminal-view');
const terminalHost = document.getElementById('terminal');
const terminalTitle = document.getElementById('terminal-title');
const sessionChoice = document.getElementById('session-choice');
const settingsModal = document.getElementById('settings-modal');
let sessions = [];
let archivedSessions = [];
let hasTelegramToken = false;
let telegramChatStep = false;
let activeTile = null;
let fitTimer;
let fitAttempts = 0;
const terminals = new Map();
const pendingPty = new Map();
window.addEventListener('error', (event) => {
  console.error(`[renderer-error] ${event.message}`, event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer-rejection]', event.reason);
});

const rank = { approval: 0, done: 1, working: 2, null: 3 };
const agentLabels = { claude: 'Claude Code', codex: 'Codex', terminal: 'Terminal' };

function agentLabel(agent) { return agentLabels[agent] || 'Session'; }

function elapsed(since) {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function sorted(list) {
  return [...list].sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || a.since - b.since || a.created - b.created);
}

function render() {
  const ordered = sorted(sessions);
  board.dataset.count = String(ordered.length);
  summary.textContent = ordered.length === 0 ? 'No sessions' : `${ordered.length} session${ordered.length === 1 ? '' : 's'}`;
  board.replaceChildren();
  if (!ordered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<strong>Your sessions will appear here</strong>Start Claude Code, Codex, or a terminal from Signal Box.';
    board.append(empty);
    return;
  }
  for (const session of ordered) {
    const tile = document.createElement(session.owned ? 'button' : 'article');
    tile.className = `tile ${session.owned ? '' : 'external'} state-${session.state || 'off'}`;
    if (session.owned) tile.type = 'button';
    const lamp = document.createElement('div'); lamp.className = 'lamp';
    const project = document.createElement('div'); project.className = 'project'; project.textContent = session.project;
    const pathText = document.createElement('div'); pathText.className = 'path'; pathText.textContent = session.path || 'Unknown location';
    const clock = document.createElement('div'); clock.className = 'clock'; clock.textContent = elapsed(session.since);
    tile.append(lamp, project, pathText, clock);
    const sessionMark = document.createElement('span');
    sessionMark.className = 'session-mark';
    sessionMark.textContent = `${session.owned ? '' : 'external · '}${agentLabel(session.agent)}`;
    tile.append(sessionMark);
    if (!session.owned) {
      const dismiss = document.createElement('button');
      dismiss.className = 'tile-dismiss';
      dismiss.type = 'button';
      dismiss.title = 'Remove from board';
      dismiss.textContent = '×';
      dismiss.addEventListener('click', async (event) => {
        event.stopPropagation();
        await window.signalBox.closeSession({ tile: session.key, permanent: true });
        sessions = sessions.filter((item) => item.key !== session.key);
        render();
      });
      tile.append(dismiss);
    }
    if (session.owned) tile.addEventListener('click', async () => {
      try {
        await window.signalBox.openSession({ tile: session.tile || session.key });
        openTerminal(session);
      } catch (caught) { showError(caught.message || 'Could not reopen this session.'); }
    });
    board.append(tile);
  }
}

function openTerminal(session) {
  try {
    const tile = session.tile || session.key;
    if (!tile) throw new Error('This session does not have a terminal id.');
    activeTile = tile;
    terminalView.hidden = false;
    terminalTitle.textContent = `${agentLabel(session.agent)} · ${session.project} · ${session.path}`;
    for (const [entryTile, entry] of terminals) entry.container.hidden = entryTile !== tile;

    let entry = terminals.get(tile);
    if (!entry) {
      if (!window.Terminal || !window.FitAddon || !window.signalBox) {
        throw new Error(`Terminal assets missing (Terminal=${Boolean(window.Terminal)}, FitAddon=${Boolean(window.FitAddon)}, IPC=${Boolean(window.signalBox)})`);
      }
      const container = document.createElement('div');
      container.className = 'terminal-pane';
      terminalHost.append(container);
      const terminal = new window.Terminal({
        cursorBlink: true,
        scrollback: 5000,
        theme: { background: '#0d1117', foreground: '#d8e0e8' },
        fontSize: 13,
      });
      const fitAddon = new window.FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      terminal.onData((data) => window.signalBox.writePty({ tile, data }));
      const copySelection = () => {
        const selection = terminal.getSelection();
        if (!selection) return false;
        navigator.clipboard?.writeText(selection).catch(() => {
          const helper = document.createElement('textarea');
          helper.value = selection;
          helper.style.position = 'fixed';
          helper.style.opacity = '0';
          document.body.append(helper);
          helper.select();
          document.execCommand('copy');
          helper.remove();
        });
        return true;
      };
      terminal.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase();
        const modifier = event.ctrlKey || event.metaKey;
        if (modifier && (key === 'c' || (event.shiftKey && key === 'c')) && terminal.hasSelection()) {
          copySelection();
          return false;
        }
        return true;
      });
      container.addEventListener('contextmenu', (event) => {
        if (!terminal.hasSelection()) return;
        event.preventDefault();
        copySelection();
      });
      terminal.onKey(({ domEvent }) => {
        if (domEvent.key === 'Enter') window.signalBox.markWorking({ tile });
      });
      entry = { terminal, fitAddon, container };
      terminals.set(tile, entry);
    }
    fitAttempts = 0;
    const buffered = pendingPty.get(tile);
    if (buffered) {
      pendingPty.delete(tile);
      entry.terminal.write(buffered, scheduleFit);
    }
    requestAnimationFrame(() => {
      if (terminalView.hidden || activeTile !== tile) return;
      scheduleFit();
    });
  } catch (caught) {
    console.error('[terminal-init]', caught);
    closeTerminalView({ dispose: true });
    showError(caught.message || 'The embedded terminal could not start.');
  }
}

function disposeTerminal(tile) {
  const entry = terminals.get(tile);
  if (!entry) return;
  entry.terminal.dispose();
  entry.container.remove();
  terminals.delete(tile);
  pendingPty.delete(tile);
}

function disposeAllTerminals() {
  for (const tile of [...terminals.keys()]) disposeTerminal(tile);
}

function closeTerminalView({ dispose = false } = {}) {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = null;
  const tile = activeTile;
  terminalView.hidden = true;
  activeTile = null;
  if (dispose && tile) disposeTerminal(tile);
}

function fitTerminal() {
  if (terminalView.hidden || !activeTile) return;
  const entry = terminals.get(activeTile);
  if (!entry) return;
  try {
    const bounds = entry.container.getBoundingClientRect();
    if ((bounds.width < 40 || bounds.height < 40) && fitAttempts < 6) {
      fitAttempts += 1;
      fitTimer = setTimeout(() => {
        fitTimer = null;
        fitTerminal();
      }, 100);
      return;
    }
    entry.fitAddon.fit();
    entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
    entry.terminal.focus();
    window.signalBox.resizePty({ tile: activeTile, cols: entry.terminal.cols, rows: entry.terminal.rows });
  } catch (caught) {
    console.error('[terminal-resize]', caught);
  }
}

function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer);
  fitAttempts = 0;
  fitTimer = setTimeout(() => {
    fitTimer = null;
    fitTerminal();
  }, 120);
}

function showError(message) { error.textContent = message; error.hidden = false; setTimeout(() => { error.hidden = true; }, 4000); }

function showSettings() {
  settingsModal.hidden = false;
  telegramChatStep = false;
  updateSettingsFields();
  document.getElementById('save-settings').textContent = 'Save bot token';
  document.getElementById('telegram-token').focus();
}

function updateSettingsFields() {
  const enabled = document.getElementById('enable-telegram').checked;
  const token = document.getElementById('telegram-token');
  const chatId = document.getElementById('telegram-chat-id');
  const tokenLabel = document.getElementById('telegram-token-label');
  const chatLabel = document.getElementById('telegram-chat-label');
  tokenLabel.hidden = !enabled || telegramChatStep;
  token.hidden = !enabled || telegramChatStep;
  chatLabel.hidden = !enabled || !telegramChatStep;
  chatId.hidden = !enabled || !telegramChatStep;
  token.disabled = !enabled;
  chatId.disabled = !enabled;
  token.required = enabled && !telegramChatStep && !hasTelegramToken;
  chatId.required = enabled && telegramChatStep;
  if (!enabled) document.getElementById('settings-instruction').textContent = 'Telegram is optional. Continue without remote control, or enable it below.';
}

function showChatIdStep() {
  telegramChatStep = true;
  document.getElementById('settings-title').textContent = 'Initialize Telegram';
  document.getElementById('settings-instruction').textContent = 'Open your bot in Telegram, send /start, then enter the chat ID it sends back.';
  document.getElementById('save-settings').textContent = 'Save chat ID';
  updateSettingsFields();
  document.getElementById('telegram-chat-id').focus();
}

document.getElementById('enable-telegram').addEventListener('change', () => {
  if (!document.getElementById('enable-telegram').checked) telegramChatStep = false;
  updateSettingsFields();
});
document.getElementById('telegram-settings').addEventListener('click', async () => {
  try {
    const settings = await window.signalBox.getSettings();
    hasTelegramToken = settings.hasToken;
    document.getElementById('settings-title').textContent = 'Telegram settings';
    document.getElementById('settings-instruction').textContent = hasTelegramToken
      ? 'Enter a new bot token, or leave it blank to keep the saved token.'
      : 'Telegram is optional. Enable it for remote control.';
    document.getElementById('enable-telegram').checked = settings.enabled;
    document.getElementById('telegram-token').value = '';
    document.getElementById('telegram-token').placeholder = hasTelegramToken ? 'Leave blank to keep saved token' : '';
    document.getElementById('telegram-chat-id').value = settings.chatId;
    telegramChatStep = false;
    document.getElementById('close-settings').hidden = !settings.configured && settings.enabled;
    showSettings();
  } catch (caught) { showError(caught.message || 'Could not load Telegram settings.'); }
});
document.getElementById('close-settings').addEventListener('click', () => { settingsModal.hidden = true; });

document.getElementById('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const settingsError = document.getElementById('settings-error');
  settingsError.hidden = true;
  try {
    const enabled = document.getElementById('enable-telegram').checked;
    const wasChatStep = telegramChatStep;
    const tokenInput = document.getElementById('telegram-token');
    const chatIdInput = document.getElementById('telegram-chat-id');
    const result = await window.signalBox.saveSettings({
      telegramEnabled: enabled,
      telegramBotToken: tokenInput.value,
      telegramChatId: chatIdInput.value,
    });
    if (enabled) {
      if (wasChatStep && result.configured) settingsModal.hidden = true;
      else {
        chatIdInput.value = result.chatId;
        showChatIdStep();
      }
    }
    else settingsModal.hidden = true;
  } catch (caught) {
    settingsError.textContent = caught.message || 'Could not save settings.';
    settingsError.hidden = false;
  }
});

function chooseSessionMode() {
  sessionChoice.hidden = false;
  document.getElementById('start-new-session').focus();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (mode) => {
      if (settled) return;
      settled = true;
      sessionChoice.hidden = true;
      resolve(mode);
    };
    document.getElementById('start-new-session').onclick = () => finish('new');
    document.getElementById('continue-session').onclick = () => finish('continue');
    document.getElementById('cancel-session-choice').onclick = () => finish(null);
    sessionChoice.onclick = (event) => {
      if (event.target === sessionChoice) finish(null);
    };
    sessionChoice.onkeydown = (event) => {
      if (event.key === 'Escape') finish(null);
    };
  });
}

function latestSavedSession(cwd) {
  return [...sessions, ...archivedSessions]
    .filter((session) => session.owned && session.cwd === cwd && session.sessionId)
    .sort((a, b) => (b.created || 0) - (a.created || 0))[0] || null;
}

async function startSession(mode) {
  const cwd = await window.signalBox.pickFolder();
  if (!cwd) return;
  const previous = latestSavedSession(cwd);
  if (mode === 'continue') {
    if (!previous) throw new Error('No saved session was found for that project folder.');
    await window.signalBox.openSession({ tile: previous.tile || previous.key });
    openTerminal(previous);
    return;
  }
  const agent = document.getElementById('agent-select').value;
  const tile = await window.signalBox.createSession({ cwd, agent });
  const project = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
  const session = sessions.find((item) => item.tile === tile) || { tile, project, path: cwd, cwd, agent };
  openTerminal(session);
}

const soundToggle = document.getElementById('sound-toggle');
const audio = window.signalBoxAudio || {
  isEnabled: () => false,
  toggle: async () => false,
  play: () => {},
};
function updateSoundButton() {
  const on = audio.isEnabled();
  soundToggle.textContent = on ? 'Sound on' : 'Sound off';
  soundToggle.setAttribute('aria-pressed', String(on));
}
soundToggle.addEventListener('click', async () => {
  try {
    await audio.toggle();
    updateSoundButton();
  } catch (caught) {
    showError(caught.message || 'Could not initialize audio.');
  }
});
updateSoundButton();

document.getElementById('new-session').addEventListener('click', async () => {
  try {
    const mode = await chooseSessionMode();
    if (mode) await startSession(mode);
  } catch (caught) { showError(caught.message || 'Could not create a session.'); }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !sessionChoice.hidden) document.getElementById('cancel-session-choice').click();
});

document.getElementById('clear-all').addEventListener('click', async () => {
  if (!sessions.length || !window.confirm(`Clear all ${sessions.length} sessions? External sessions will be removed; Signal Box sessions will be archived.`)) return;
  const current = [...sessions];
  await Promise.all(current.map((session) => window.signalBox.closeSession({
    tile: session.tile || session.key,
    permanent: !session.owned,
  })));
  sessions = [];
  render();
  closeTerminalView();
  disposeAllTerminals();
});

document.getElementById('terminal-back').addEventListener('click', () => closeTerminalView());
document.getElementById('terminal-close').addEventListener('click', async () => {
  if (!activeTile || !window.confirm('Close this session?')) return;
  const tile = activeTile;
  await window.signalBox.closeSession({ tile });
  sessions = sessions.filter((session) => (session.tile || session.key) !== tile);
  render();
  closeTerminalView({ dispose: true });
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !terminalView.hidden) closeTerminalView();
});
window.addEventListener('resize', () => {
  if (!terminalView.hidden && terminals.has(activeTile)) scheduleFit();
});

window.signalBox.onSessionsChanged(({ sessions: next, archivedSessions: archived, changed }) => {
  sessions = next;
  if (Array.isArray(archived)) archivedSessions = archived;
  render();
  if (changed && changed.state && !changed.navigation && !changed.repeated) audio.play(changed.state);
});
window.signalBox.onPtyData(({ tile, data }) => {
  const entry = terminals.get(tile);
  if (entry) entry.terminal.write(data);
  else pendingPty.set(tile, `${pendingPty.get(tile) || ''}${data}`.slice(-1024 * 1024));
});
Promise.all([window.signalBox.listSessions(), window.signalBox.listArchivedSessions()]).then(([next, archived]) => {
  sessions = next;
  archivedSessions = archived;
  render();
}).catch((caught) => showError(caught.message));
window.signalBox.getSettings().then((settings) => {
  hasTelegramToken = settings.hasToken;
  document.getElementById('enable-telegram').checked = settings.enabled;
  if (settings.enabled && !settings.configured) {
    document.getElementById('close-settings').hidden = true;
    showSettings();
    if (settings.chatId === '' && settings.hasToken) showChatIdStep();
  }
}).catch((caught) => showError(caught.message));
setInterval(render, 1000);
