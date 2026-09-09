const board = document.getElementById('board');
const summary = document.getElementById('summary');
const error = document.getElementById('error');
const terminalView = document.getElementById('terminal-view');
const terminalHost = document.getElementById('terminal');
const terminalTitle = document.getElementById('terminal-title');
let sessions = [];
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
        await window.signalBox.closeSession({ tile: session.key });
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
    const cwd = await window.signalBox.pickFolder();
    if (cwd) {
      const agent = document.getElementById('agent-select').value;
      const tile = await window.signalBox.createSession({ cwd, agent });
      const project = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
      const session = sessions.find((item) => item.tile === tile) || { tile, project, path: cwd, agent };
      openTerminal(session);
    }
  } catch (caught) { showError(caught.message || 'Could not create a session.'); }
});

document.getElementById('clear-all').addEventListener('click', async () => {
  if (!sessions.length || !window.confirm(`Remove all ${sessions.length} sessions from Signal Box? Owned processes will be terminated.`)) return;
  const current = [...sessions];
  await Promise.all(current.map((session) => window.signalBox.closeSession({ tile: session.tile || session.key })));
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

window.signalBox.onSessionsChanged(({ sessions: next, changed }) => {
  sessions = next;
  render();
  if (changed && changed.state && !changed.navigation) audio.play(changed.state);
});
window.signalBox.onPtyData(({ tile, data }) => {
  const entry = terminals.get(tile);
  if (entry) entry.terminal.write(data);
  else pendingPty.set(tile, `${pendingPty.get(tile) || ''}${data}`.slice(-1024 * 1024));
});
window.signalBox.listSessions().then((next) => { sessions = next; render(); }).catch((caught) => showError(caught.message));
setInterval(render, 1000);
