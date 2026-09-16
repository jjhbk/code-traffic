const board = document.getElementById('board');
const summary = document.getElementById('summary');
const error = document.getElementById('error');
const terminalView = document.getElementById('terminal-view');
const terminalHost = document.getElementById('terminal');
const terminalTitle = document.getElementById('terminal-title');
const sessionChoice = document.getElementById('session-choice');
const settingsModal = document.getElementById('settings-modal');
const setupPanel = document.getElementById('setup-panel');
let sessions = [];
let archivedSessions = [];
let hasTelegramToken = false;
let telegramChatStep = false;
let activeTile = null;
let tasks = [];
let fitTimer;
let fitAttempts = 0;
const terminals = new Map();
const pendingPty = new Map();
let taskEditMode = 'edit';

if (window.signalBox.environment?.wsl) {
  document.body.classList.add('wsl-cursor-fallback');
  const cursor = document.getElementById('wsl-cursor');
  let cursorFrame = 0;
  let cursorX = 0;
  let cursorY = 0;
  window.addEventListener('pointermove', (event) => {
    cursorX = event.clientX;
    cursorY = event.clientY;
    if (cursorFrame) return;
    cursorFrame = requestAnimationFrame(() => {
      cursor.style.transform = `translate3d(${cursorX + 2}px, ${cursorY + 2}px, 0) rotate(-12deg)`;
      cursorFrame = 0;
    });
  }, { passive: true });
  window.addEventListener('blur', () => { cursor.style.display = 'none'; });
  window.addEventListener('focus', () => { cursor.style.display = 'block'; });
}

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
  summary.innerHTML = `<span class="status-beacon"></span>${ordered.length === 0 ? 'No sessions' : `${ordered.length} session${ordered.length === 1 ? '' : 's'}`}`;
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
    tile.className = `tile ${session.owned ? '' : 'external'} state-${session.state || 'off'} liveness-${session.liveness || 'inactive'}`;
    if (session.owned) tile.type = 'button';
    const lamp = document.createElement('div'); lamp.className = 'lamp';
    const project = document.createElement('div'); project.className = 'project'; project.textContent = session.project;
    const pathText = document.createElement('div'); pathText.className = 'path'; pathText.textContent = session.path || 'Unknown location';
    const clock = document.createElement('div'); clock.className = 'clock';
    clock.textContent = session.liveness === 'unknown' ? 'status unknown' : session.liveness === 'stale' ? 'stale' : elapsed(session.since);
    tile.append(lamp, project, pathText, clock);
    const sessionMark = document.createElement('span');
    sessionMark.className = 'session-mark';
    sessionMark.textContent = `${session.owned ? '' : 'external · '}${agentLabel(session.agent)}${session.processStatus === 'exited' ? ' · exited' : ''}`;
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

function renderSetup(items) {
  setupPanel.hidden = !items.length;
  if (!items.length) return;
  document.getElementById('setup-count').textContent = `${items.length} step${items.length === 1 ? '' : 's'} remaining`;
  const list = document.getElementById('setup-list');
  list.replaceChildren();
  for (const item of items) {
    const card = document.createElement('article'); card.className = `setup-card setup-${item.tone || 'neutral'}`;
    const icon = document.createElement('span'); icon.className = 'setup-icon'; icon.textContent = item.icon;
    const content = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = item.title;
    const detail = document.createElement('p'); detail.textContent = item.detail;
    content.append(title, detail);
    const action = document.createElement('button'); action.type = 'button'; action.textContent = item.action;
    action.addEventListener('click', item.onClick);
    card.append(icon, content, action); list.append(card);
  }
}

async function refreshSetupCenter() {
  try {
    const [telegram, gmail, digest] = await Promise.all([
      window.signalBox.getSettings(),
      window.signalBox.getMailStatus(),
      window.signalBox.getDigestSettings(),
    ]);
    const items = [];
    if (!telegram.configured) items.push({ icon: '↗', title: 'Connect Telegram', detail: 'Receive approvals and daily updates wherever you are.', action: 'Set up', tone: 'cyan', onClick: () => document.getElementById('telegram-settings').click() });
    if (!gmail.paired) items.push({ icon: '✉', title: 'Connect Gmail', detail: 'Let Signal Box find commitments and follow-ups from your inbox.', action: 'Connect', tone: 'violet', onClick: () => document.getElementById('gmail-settings').click() });
    if (!digest.quietHoursStart && !digest.quietHoursEnd) items.push({ icon: '◷', title: 'Set notification quiet hours', detail: `Choose when Signal Box should stay quiet. Current timezone: ${digest.timeZone}.`, action: 'Configure', tone: 'amber', onClick: () => document.getElementById('digest-settings').click() });
    renderSetup(items);
  } catch (caught) { console.error('[setup-center]', caught); }
}

function renderTasks() {
  const list = document.getElementById('tasks-list');
  list.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'No active tasks.'; list.append(empty); return;
  }
  for (const task of tasks) {
    const card = document.createElement('article'); card.className = 'task-card';
    const title = document.createElement('h3'); title.textContent = task.summary || 'Untitled task'; card.append(title);
    const meta = document.createElement('p'); meta.className = 'task-meta';
    meta.textContent = `${task.owner === 'self' ? 'You owe this' : 'Counterparty owes this'}${task.counterparty ? ` · ${task.counterparty}` : ''}${task.dueDate ? ` · due ${task.dueDate}` : ''}`;
    card.append(meta);
    if (task.evidence?.text) { const evidence = document.createElement('blockquote'); evidence.textContent = task.evidence.text; card.append(evidence); }
    const actions = document.createElement('div'); actions.className = 'task-actions';
    for (const [label, status] of [['Done', 'done'], ['Not useful', 'dismissed']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', async () => { await window.signalBox.updateTask({ taskId: task.taskId, status }); await loadTasks(); });
      actions.append(button);
    }
    const snooze = document.createElement('button'); snooze.type = 'button'; snooze.textContent = 'Snooze';
    snooze.addEventListener('click', () => openTaskEditModal(task, 'snooze'));
    actions.append(snooze);
    if (task.counterparty) {
      if (task.threadId && task.owner === 'self') {
        const reply = document.createElement('button'); reply.type = 'button'; reply.textContent = 'Reply';
        reply.addEventListener('click', () => openReplyModal(task));
        actions.append(reply);
      }
      const suppress = document.createElement('button'); suppress.type = 'button'; suppress.textContent = 'Suppress counterparty';
      suppress.addEventListener('click', async () => { await window.signalBox.suppressCounterparty({ counterparty: task.counterparty }); await loadTasks(); });
      actions.append(suppress);
    }
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => openTaskEditModal(task, 'edit'));
    actions.append(edit); card.append(actions); list.append(card);
  }
}

const taskEditModal = document.getElementById('task-edit-modal');
function openTaskEditModal(task, mode) {
  taskEditMode = mode;
  document.getElementById('task-edit-id').value = task.taskId;
  document.getElementById('task-edit-title').textContent = mode === 'snooze' ? 'Snooze task' : 'Edit task';
  document.getElementById('task-edit-summary-row').hidden = mode === 'snooze';
  document.getElementById('task-edit-owner-row').hidden = mode === 'snooze';
  document.getElementById('task-edit-summary').value = task.summary || '';
  document.getElementById('task-edit-due').value = mode === 'snooze' ? '' : (task.dueDate || '');
  document.getElementById('task-edit-owner').value = task.owner || 'self';
  document.getElementById('task-edit-error').hidden = true;
  taskEditModal.hidden = false;
}
document.getElementById('close-task-edit').addEventListener('click', () => { taskEditModal.hidden = true; });
document.getElementById('task-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorTarget = document.getElementById('task-edit-error');
  errorTarget.hidden = true;
  const taskId = document.getElementById('task-edit-id').value;
  const dueDate = document.getElementById('task-edit-due').value.trim();
  try {
    if (taskEditMode === 'snooze') {
      const untilAt = Date.parse(dueDate);
      if (!Number.isFinite(untilAt)) throw new Error('Enter a valid date and time.');
      await window.signalBox.snoozeTask({ taskId, untilAt });
    } else {
      const owner = document.getElementById('task-edit-owner').value;
      if (!['self', 'counterparty'].includes(owner)) throw new Error('Choose a valid task owner.');
      await window.signalBox.correctTask({ taskId, changes: { summary: document.getElementById('task-edit-summary').value.trim(), dueDate: dueDate || null, owner } });
    }
    taskEditModal.hidden = true;
    await loadTasks();
  } catch (caught) {
    errorTarget.textContent = caught.message || 'Could not update the task.';
    errorTarget.hidden = false;
  }
});

const replyModal = document.getElementById('reply-modal');
function openReplyModal(task) {
  document.getElementById('reply-task-id').value = task.taskId;
  document.getElementById('reply-destination').textContent = `To: ${task.counterparty}`;
  document.getElementById('reply-subject').value = String(task.summary || '').startsWith('Re:') ? task.summary : `Re: ${task.summary || 'Follow up'}`;
  document.getElementById('reply-body').value = '';
  document.getElementById('reply-error').hidden = true;
  replyModal.hidden = false;
}
document.getElementById('close-reply').addEventListener('click', () => { replyModal.hidden = true; });
document.getElementById('reply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorTarget = document.getElementById('reply-error');
  errorTarget.hidden = true;
  try {
    const approval = await window.signalBox.proposeReply({
      taskId: document.getElementById('reply-task-id').value,
      subject: document.getElementById('reply-subject').value,
      body: document.getElementById('reply-body').value,
    });
    const action = approval.action;
    const confirmed = window.confirm(`Send this reply to ${action.destination}?\n\nSubject: ${action.content.subject}\n\n${action.content.body}`);
    if (!confirmed) { replyModal.hidden = true; return; }
    await window.signalBox.sendApprovedReply({ requestId: approval.request_id || approval.requestId });
    replyModal.hidden = true;
    await loadTasks();
  } catch (caught) {
    errorTarget.textContent = caught.message || 'Could not send the reply.';
    errorTarget.hidden = false;
  }
});

async function loadTasks() {
  try { tasks = await window.signalBox.listTasks(); renderTasks(); } catch (caught) { showError(caught.message || 'Could not load tasks.'); }
}

document.getElementById('tasks-toggle').addEventListener('click', async () => {
  const view = document.getElementById('tasks-view');
  view.hidden = !view.hidden;
  if (!view.hidden) await loadTasks();
});
document.getElementById('tasks-refresh').addEventListener('click', loadTasks);

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
        window.signalBox.writeClipboard(selection).catch((caught) => console.error('[clipboard-copy]', caught));
        return true;
      };
      let pasteInFlight = false;
      const pasteClipboard = async () => {
        if (pasteInFlight) return;
        pasteInFlight = true;
        try {
          const text = await window.signalBox.readClipboard();
          // xterm.js wraps this in bracketed-paste markers so shells receive
          // multi-line text as one paste instead of executing each line.
          if (text) terminal.paste(text);
        } catch (caught) { console.error('[clipboard-paste]', caught); }
        finally { setTimeout(() => { pasteInFlight = false; }, 0); }
      };
      container.addEventListener('paste', (event) => {
        event.preventDefault();
        event.stopPropagation();
        pasteClipboard();
      }, true);
      terminal.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase();
        const modifier = event.ctrlKey || event.metaKey;
        if (modifier && (key === 'c' || (event.shiftKey && key === 'c')) && terminal.hasSelection()) {
          copySelection();
          return false;
        }
        if (modifier && key === 'v') {
          // The capture-phase paste handler above owns Ctrl/Cmd+V.
          return false;
        }
        if (event.shiftKey && key === 'insert') {
          pasteClipboard();
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
const gmailModal = document.getElementById('gmail-modal');
window.signalBox.onMailPairProgress?.(({ stage, message, redirectUri }) => {
  const statusTarget = document.getElementById('gmail-status');
  const messages = {
    'waiting-for-google': 'Waiting for Google authentication to return to Signal Box…',
    'browser-opened': 'Google is open in your browser. Complete authentication there…',
    'callback-received': 'Google authentication received. Finishing secure connection…',
    'saving-credentials': 'Saving the connection in your OS credential store…',
    error: message || 'Google authentication could not complete.',
  };
  if (statusTarget && messages[stage]) statusTarget.textContent = messages[stage];
  if (stage === 'error' && redirectUri) console.error(`[mail] OAuth callback error; expected redirect ${redirectUri}`);
});
document.querySelectorAll('.guide-link').forEach((button) => {
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = button.dataset.url || button.getAttribute('href');
    if (!target) return;
    button.setAttribute('aria-busy', 'true');
    try {
      await window.signalBox.openExternal(target);
    } catch (caught) {
      const message = caught?.message || 'Could not open the setup page.';
      const errorTarget = document.getElementById('gmail-error');
      errorTarget.textContent = message;
      errorTarget.hidden = false;
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
});
async function refreshGmailStatus() {
  const status = await window.signalBox.getMailStatus();
  const health = status.health;
  document.getElementById('gmail-status').textContent = !status.paired
    ? (status.storageMessage || 'Gmail is not connected.')
    : health?.status === 'error'
      ? `Gmail sync error: ${health.details?.message || 'unknown error'}`
      : health?.updatedAt
        ? `Gmail is connected. Last sync: ${new Date(health.updatedAt).toLocaleString()}.`
        : 'Gmail is connected for read-only sync.';
  document.getElementById('disconnect-gmail').hidden = !status.paired;
  document.getElementById('sync-gmail').hidden = !status.paired;
  const clientIdInput = document.getElementById('gmail-client-id');
  if (clientIdInput && status.clientId) clientIdInput.value = status.clientId;
}
document.getElementById('gmail-settings').addEventListener('click', async () => {
  try { await refreshGmailStatus(); gmailModal.hidden = false; } catch (caught) { showError(caught.message); }
});
document.getElementById('close-gmail').addEventListener('click', () => { gmailModal.hidden = true; });
document.getElementById('disconnect-gmail').addEventListener('click', async () => {
  try { await window.signalBox.disconnectMail(); await refreshGmailStatus(); } catch (caught) { showError(caught.message); }
});
document.getElementById('sync-gmail').addEventListener('click', async () => {
  const button = document.getElementById('sync-gmail');
  const statusTarget = document.getElementById('gmail-status');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Syncing…';
  statusTarget.textContent = 'Syncing Gmail messages…';
  try {
    const result = await window.signalBox.syncMail();
    if (!result?.paired) throw new Error(result?.reason || 'Gmail sync is not initialized. Reconnect Gmail and try again.');
    await refreshGmailStatus();
    const fetched = Number(result?.fetched || 0);
    const inserted = Number(result?.inserted || 0);
    statusTarget.textContent = fetched === 0
      ? 'Gmail sync completed, but Gmail returned no INBOX or SENT messages.'
      : `Gmail sync complete. ${fetched} message${fetched === 1 ? '' : 's'} fetched, ${inserted} new.`;
  } catch (caught) {
    statusTarget.textContent = `Gmail sync failed: ${caught.message || 'unknown error'}`;
    showError(caught.message);
    await refreshGmailStatus();
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
});
document.getElementById('gmail-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorTarget = document.getElementById('gmail-error');
  errorTarget.hidden = true;
  document.getElementById('gmail-status').textContent = 'Starting secure Google authentication…';
  try {
    await window.signalBox.pairMail({
      clientId: document.getElementById('gmail-client-id').value.trim(),
      clientSecret: document.getElementById('gmail-client-secret').value.trim(),
    });
    wireMailSyncStatus();
    await refreshGmailStatus();
    refreshSetupCenter();
  } catch (caught) {
    errorTarget.textContent = caught.message || 'Could not connect Gmail.';
    errorTarget.hidden = false;
  }
});
const digestModal = document.getElementById('digest-modal');
document.getElementById('digest-settings').addEventListener('click', async () => {
  try {
    const settings = await window.signalBox.getDigestSettings();
    document.getElementById('quiet-start').value = settings.quietHoursStart;
    document.getElementById('quiet-end').value = settings.quietHoursEnd;
    document.getElementById('digest-cap').value = settings.dailyCap;
    document.getElementById('digest-timezone').textContent = `Timezone: ${settings.timeZone}`;
    const delivery = Object.entries(settings.stats.delivery || {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No deliveries yet';
    const feedback = Object.entries(settings.stats.feedback || {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No feedback yet';
    document.getElementById('digest-stats').textContent = `Delivery — ${delivery}\nFeedback — ${feedback}`;
    await renderSuppressions();
    digestModal.hidden = false;
  } catch (caught) { showError(caught.message); }
});
document.getElementById('close-digest').addEventListener('click', () => { digestModal.hidden = true; });
document.getElementById('digest-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorTarget = document.getElementById('digest-error');
  errorTarget.hidden = true;
  try {
    await window.signalBox.saveDigestSettings({
      quietHoursStart: document.getElementById('quiet-start').value,
      quietHoursEnd: document.getElementById('quiet-end').value,
      dailyCap: Number(document.getElementById('digest-cap').value),
    });
    digestModal.hidden = true;
    refreshSetupCenter();
  } catch (caught) {
    errorTarget.textContent = caught.message || 'Could not save digest settings.';
    errorTarget.hidden = false;
  }
});
async function renderSuppressions() {
  const list = document.getElementById('suppression-list');
  list.replaceChildren();
  const suppressions = await window.signalBox.listSuppressions();
  if (!suppressions.length) { list.textContent = 'No active suppressions.'; return; }
  suppressions.forEach((suppression) => {
    const row = document.createElement('div'); row.className = 'suppression-row';
    const label = document.createElement('span'); label.textContent = `${suppression.scopeType}: ${suppression.scopeKey}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Undo';
    remove.addEventListener('click', async () => { await window.signalBox.removeSuppression({ scopeType: suppression.scopeType, scopeKey: suppression.scopeKey }); await renderSuppressions(); });
    row.append(label, remove); list.append(row);
  });
}
function wireMailSyncStatus() {
  window.signalBox.onMailStatusChanged?.(() => { if (!gmailModal.hidden) refreshGmailStatus().catch(() => {}); });
}
wireMailSyncStatus();
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
    refreshSetupCenter();
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

document.getElementById('window-minimize').addEventListener('click', () => window.signalBox.minimizeWindow());
document.getElementById('window-maximize').addEventListener('click', async () => {
  const maximized = await window.signalBox.toggleMaximizeWindow();
  document.getElementById('window-maximize').textContent = maximized ? '❐' : '□';
});
document.getElementById('window-close').addEventListener('click', () => window.signalBox.closeWindow());
document.querySelector('.chrome-drag-region').addEventListener('dblclick', async () => {
  const maximized = await window.signalBox.toggleMaximizeWindow();
  document.getElementById('window-maximize').textContent = maximized ? '❐' : '□';
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
refreshSetupCenter();
setInterval(render, 1000);
