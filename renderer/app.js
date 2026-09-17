const board = document.getElementById('board');
const summary = document.getElementById('summary');
const error = document.getElementById('error');
const terminalView = document.getElementById('terminal-view');
const terminalHost = document.getElementById('terminal');
const terminalTitle = document.getElementById('terminal-title');
const sessionChoice = document.getElementById('session-choice');
const settingsModal = document.getElementById('settings-modal');
document.getElementById('browser-extension-settings').addEventListener('click', async () => {
  try {
    const opened = await window.signalBox.openBrowserExtensionFolder();
   const pairing = await window.signalBox.getBrowserPairing();
   await window.signalBox.writeClipboard(pairing.token);
    const extensionPathTarget = document.getElementById('browser-extension-path');
    extensionPathTarget.textContent = opened.windowsPath || opened.path;
    extensionPathTarget.dataset.copyPath = opened.windowsPath || opened.path;
   document.getElementById('browser-session-id').textContent = pairing.sessionId;
   document.getElementById('browser-host-url').textContent = pairing.hostUrl;
    document.getElementById('browser-setup-status').textContent = opened.folderOpened
      ? opened.managerOpened
        ? 'The extension folder and browser extension manager are open.'
        : 'The extension folder is open. In Chrome, open chrome://extensions manually.'
      : 'Copy the path below and load it in Chrome. The folder could not be opened automatically.';
   document.getElementById('browser-modal').hidden = false;
    refreshBrowserStatus();
  } catch (error) { showError(error.message); }
});
async function refreshBrowserStatus() {
  const status = document.getElementById('browser-connection-status');
  try {
    const bridge = await window.signalBox.getBrowserStatus();
    status.textContent = bridge.connected
      ? `Browser status: connected · ${bridge.pending} action${bridge.pending === 1 ? '' : 's'} waiting`
      : 'Browser status: waiting for the paired extension on an allowed browser page.';
  } catch (error) { status.textContent = `Browser status: unavailable · ${error.message}`; }
}
document.getElementById('close-browser-setup').addEventListener('click', () => { document.getElementById('browser-modal').hidden = true; });
document.getElementById('open-browser-manager').addEventListener('click', async () => {
  try {
    await window.signalBox.openBrowserExtensionManager();
    document.getElementById('browser-setup-status').textContent = 'Chrome extensions is open. Turn on Developer mode, then choose Load unpacked.';
  } catch (error) { showError(error.message); }
});
document.getElementById('copy-browser-token').addEventListener('click', async () => {
  try { const pairing = await window.signalBox.getBrowserPairing(); await window.signalBox.writeClipboard(pairing.token); showError('Pairing token copied.'); }
  catch (error) { showError(error.message); }
});
document.getElementById('copy-browser-path').addEventListener('click', async () => {
  const target = document.getElementById('browser-extension-path');
  await window.signalBox.writeClipboard(target.dataset.copyPath || target.textContent);
  showError('Extension path copied.');
});
document.getElementById('copy-browser-session').addEventListener('click', async () => {
  await window.signalBox.writeClipboard(document.getElementById('browser-session-id').textContent);
  showError('Browser session ID copied.');
});
let browserTestRequest = null;
document.getElementById('browser-test-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('browser-test-status');
  const actions = document.getElementById('browser-test-actions');
  actions.hidden = true;
  status.textContent = 'Preparing browser action…';
  try {
    browserTestRequest = await window.signalBox.prepareUberBooking({
      pickup: document.getElementById('browser-test-pickup').value.trim(),
      destination: document.getElementById('browser-test-destination').value.trim(),
      rideType: document.getElementById('browser-test-ride').value.trim(),
      maxFare: Number(document.getElementById('browser-test-max-fare').value),
      preflight: document.getElementById('browser-test-preflight').checked,
      sessionId: document.getElementById('browser-session-id').textContent,
    });
    status.textContent = 'Test action is waiting for approval. Approve here or use the Telegram button.';
    actions.hidden = false;
  } catch (caught) { status.textContent = caught.message || 'Could not prepare the browser action.'; }
});
document.getElementById('approve-browser-test').addEventListener('click', async () => {
  if (!browserTestRequest) return;
  const status = document.getElementById('browser-test-status');
  const actions = document.getElementById('browser-test-actions');
  actions.hidden = true; status.textContent = 'Approved. Waiting for the paired Chrome tab…';
  try {
    const result = await window.signalBox.decideBrowserAction({ requestId: browserTestRequest.request_id || browserTestRequest.requestId, optionId: 'allow', sessionId: document.getElementById('browser-session-id').textContent });
    status.textContent = `Browser action ${result.status || 'finished'}. Check Chrome for the result.`;
  } catch (caught) { status.textContent = caught.message || 'Browser action failed.'; }
});
document.getElementById('deny-browser-test').addEventListener('click', async () => {
  if (!browserTestRequest) return;
  try { await window.signalBox.decideBrowserAction({ requestId: browserTestRequest.request_id || browserTestRequest.requestId, optionId: 'deny' }); } catch (caught) { showError(caught.message); }
  browserTestRequest = null;
  document.getElementById('browser-test-actions').hidden = true;
  document.getElementById('browser-test-status').textContent = 'Test action cancelled.';
});
const setupPanel = document.getElementById('setup-panel');
let setupExpanded = false;
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
    const delivery = document.createElement('div'); delivery.className = `delivery delivery-${session.delivery?.status || 'none'}`;
    if (session.state !== 'done' && session.delivery?.status === 'submitted') delivery.textContent = 'prompt submitted · waiting for agent';
    else if (session.state !== 'done' && session.delivery?.status === 'unknown') delivery.textContent = 'prompt acknowledgement unknown';
    else if (session.state !== 'done' && session.delivery?.status === 'failed') delivery.textContent = 'prompt delivery failed';
    tile.append(lamp, project, pathText, clock, delivery);
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
  setupPanel.hidden = !items.length || !setupExpanded;
  document.getElementById('connections-toggle').textContent = items.length ? `＋ Set up your tools · ${items.length}` : '＋ Connect your tools';
  if (!items.length) { document.getElementById('setup-list').replaceChildren(); return; }
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
    const [telegram, gmail, digest, model, calendar, drive, integrations] = await Promise.all([
      window.signalBox.getSettings(),
      window.signalBox.getMailStatus(),
      window.signalBox.getDigestSettings(),
      window.signalBox.checkModel().catch(() => null),
      window.signalBox.getCalendarStatus().catch(() => null),
      window.signalBox.getDriveStatus().catch(() => null),
      window.signalBox.getIntegrationStatus().catch(() => null),
    ]);
    const items = [];
    if (!telegram.configured) items.push({ icon: '↗', title: 'Connect Telegram', detail: 'Receive approvals and daily updates wherever you are.', action: 'Set up', tone: 'cyan', onClick: () => document.getElementById('telegram-settings').click() });
    if (!gmail.paired) items.push({ icon: '✉', title: 'Connect Gmail', detail: 'Let Signal Box find commitments and follow-ups from your inbox.', action: 'Connect', tone: 'violet', onClick: () => document.getElementById('gmail-settings').click() });
    if (gmail.paired && calendar?.health?.status === 'error') items.push({ icon: '◫', title: 'Calendar sync needs attention', detail: calendar.health.details?.message || 'Google Calendar could not sync. Reconnect Google to refresh permissions.', action: 'Reconnect', tone: 'amber', onClick: () => document.getElementById('gmail-settings').click() });
    if (gmail.paired && drive?.health?.status === 'error') items.push({ icon: '□', title: 'Drive sync needs attention', detail: drive.health.details?.message || 'Google Drive could not sync. Reconnect Google to refresh permissions.', action: 'Reconnect', tone: 'amber', onClick: () => document.getElementById('gmail-settings').click() });
    if (!digest.quietHoursStart && !digest.quietHoursEnd) items.push({ icon: '◷', title: 'Set notification quiet hours', detail: `Choose when Signal Box should stay quiet. Current timezone: ${digest.timeZone}.`, action: 'Configure', tone: 'amber', onClick: () => document.getElementById('digest-settings').click() });
    const localModel = model?.localModel || 'the recommended model';
    const installLocalModel = async () => {
      const command = `ollama pull ${localModel}`;
      await window.signalBox.writeClipboard(command);
      await window.signalBox.openExternal('https://ollama.com/download');
      showError(`Copied “${command}”. Install Ollama, run the command, then refresh Signal Box.`);
    };
    const localModelDetail = model?.localError === 'ollama-unreachable'
      ? 'Ollama is installed but is not responding. Start Ollama, then refresh Signal Box.'
      : `Install ${localModel} with Ollama. The exact command will be copied when you continue.`;
    if (model?.mode === 'local' && model.localAvailable === false) items.push({ icon: '◌', title: 'Enable private local AI', detail: `${localModelDetail} Deterministic ranking remains active until then.`, action: 'Copy command', tone: 'violet', onClick: installLocalModel });
    if (model?.mode === 'frontier' && model.localAvailable === false) items.push({ icon: '◌', title: 'Frontier ranking is paused', detail: `${localModelDetail} Signal Box requires local privacy processing before sending pseudonymized tasks to a frontier model.`, action: 'Copy command', tone: 'amber', onClick: installLocalModel });
    if (model?.hardware?.wsl && model.hardware.reason === 'gpu-query-failed') items.push({ icon: '▣', title: 'WSL GPU access needs attention', detail: 'nvidia-smi is present but WSL cannot access the GPU. Ollama can still run on CPU; enable the WSL GPU driver integration for faster local inference.', action: 'Refresh', tone: 'amber', onClick: refreshSetupCenter });
    if (integrations && !integrations.claude.configured) items.push({ icon: '⌁', title: 'Claude integration needs setup', detail: 'Signal Box cannot find its Claude lifecycle hook. Restart Signal Box, then start a new Claude session.', action: 'Refresh', tone: 'amber', onClick: refreshSetupCenter });
    if (integrations && !integrations.codex.configured) items.push({ icon: '⌁', title: 'Codex integration needs setup', detail: 'Signal Box cannot find its Codex notification hook. Restart Signal Box, then start a new Codex session.', action: 'Refresh', tone: 'amber', onClick: refreshSetupCenter });
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
    meta.textContent = `${task.owner === 'self' ? 'Your next step' : 'Waiting on someone'}${task.counterparty ? ` · ${task.counterparty}` : ''}${task.dueDate ? ` · due ${task.dueDate}` : ''}`;
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
      const suppress = document.createElement('button'); suppress.type = 'button'; suppress.textContent = 'Mute this contact';
      suppress.addEventListener('click', async () => { await window.signalBox.suppressCounterparty({ counterparty: task.counterparty }); await loadTasks(); });
      actions.append(suppress);
    }
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => openTaskEditModal(task, 'edit'));
    actions.append(edit); card.append(actions); list.append(card);
  }
}

function renderMailMessages(messages) {
  const list = document.getElementById('mail-list');
  list.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'No synced Gmail messages yet. Connect Gmail and run Sync now.'; list.append(empty); return;
  }
  for (const message of messages) {
    const card = document.createElement('article'); card.className = 'mail-card task-card';
    const title = document.createElement('h3'); title.textContent = message.subject || '(no subject)'; card.append(title);
    if (message.isSpam || message.isBulk) { const badge = document.createElement('span'); badge.className = `mail-classification ${message.isSpam ? 'mail-spam' : 'mail-bulk'}`; badge.textContent = message.isSpam ? 'Likely spam' : 'Bulk / unwanted'; card.append(badge); }
    const meta = document.createElement('p'); meta.className = 'task-meta';
    const timestamp = message.timestamp ? new Date(Number(message.timestamp)).toLocaleString() : 'Unknown time';
    meta.textContent = `${message.direction === 'outgoing' ? 'Sent' : 'Received'} · ${message.from || 'Unknown sender'} · ${timestamp}`; card.append(meta);
    const body = document.createElement('p'); body.className = 'mail-body'; body.textContent = message.body || '(empty message)'; card.append(body);
    list.append(card);
  }
}
async function loadMailMessages() {
  try { renderMailMessages(await window.signalBox.listMailMessages()); } catch (caught) { showError(caught.message || 'Could not load Gmail messages.'); }
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

const ACTIVITY_LABELS = {
  'model-local': 'Local model recognized entities for privacy filtering',
  'model-ranking': 'Task ranking completed',
  'model-privacy': 'Privacy boundary processed model data',
  'observation-saved': 'Source observation stored',
  'connector-health': 'Connector health updated',
  'event-ingested': 'Agent event received',
  'approval-requested': 'Approval requested',
  'approval-decided': 'Approval decision recorded',
  'approval-expired': 'Approval expired',
  'execution-prepared': 'Action prepared',
  'execution-authorized': 'Action authorized',
  'execution-dispatched': 'Action dispatched',
  'execution-confirmed': 'Action completed',
  'execution-failed': 'Action failed',
  'notification-sent': 'Telegram notification sent',
  'notification-unknown': 'Telegram notification delivery is unknown',
};
function activityDetails(entry) {
  const details = entry.details || {};
  const parts = [];
  if (details.provider) parts.push(details.provider);
  if (details.type) parts.push(details.type);
  if (details.capability) parts.push(details.capability);
  if (details.source) parts.push(details.source);
  if (details.status && !entry.kind.includes(details.status)) parts.push(details.status);
  if (entry.kind === 'model-ranking' && details.source) parts.push(`source: ${details.source}`);
  if (entry.kind === 'model-privacy') parts.push(details.redacted ? 'PII check passed' : 'PII check failed');
  if (Array.isArray(details.leaks) && details.leaks.length) parts.push(`exposed: ${details.leaks.join(', ')}`);
  if (details.reason) parts.push(details.reason);
  return parts.join(' · ');
}
async function loadActivity() {
  const list = document.getElementById('activity-list');
  try {
    const entries = await window.signalBox.getActivity();
    list.replaceChildren();
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'No assistant activity yet. Connect a source or run a local privacy test.'; list.append(empty); return; }
    for (const entry of entries) {
      const item = document.createElement('article'); item.className = 'activity-item';
      const title = document.createElement('strong'); title.textContent = ACTIVITY_LABELS[entry.kind] || entry.kind.replaceAll('-', ' ');
      const meta = document.createElement('span'); meta.textContent = new Date(entry.createdAt).toLocaleString();
      const detail = document.createElement('p'); detail.textContent = activityDetails(entry);
      item.append(title, meta, detail); list.append(item);
    }
  } catch (caught) { list.textContent = caught.message || 'Activity is unavailable.'; }
}

function formatDiagnosticTime(value) { return value ? new Date(value).toLocaleString() : 'never'; }
function renderModelDiagnostics(diagnostic) {
  const metrics = diagnostic?.metrics || {};
  const ranking = metrics.lastRanking;
  const local = metrics.lastLocalCall;
  const privacy = metrics.lastPrivacyCheck;
  document.getElementById('model-diagnostics').textContent = [
    `Mode: ${diagnostic?.mode || 'off'} · local model: ${diagnostic?.localModel || 'not configured'} · frontier: ${diagnostic?.frontierModel || 'not configured'}`,
    `Local calls: ${metrics.localCalls || 0} · frontier calls: ${metrics.frontierCalls || 0} · ranking runs: ${metrics.rankingCalls || 0}`,
    `Last local call: ${local ? `${local.purpose}, ${local.status}, ${formatDiagnosticTime(local.at)}` : 'never'}`,
    `Last ranking: ${ranking ? `${ranking.source}, ${ranking.status || 'fallback'}${ranking.reason ? ` (${ranking.reason})` : ''}, ${formatDiagnosticTime(ranking.at)}` : 'never'}`,
    `Last privacy boundary: ${privacy ? `${privacy.redacted ? '✓ PII redaction check passed' : '✕ redaction check failed'} · ${privacy.boundary}${privacy.leaks?.length ? ` · exposed: ${privacy.leaks.join(', ')}` : ''} · ${formatDiagnosticTime(privacy.at)}` : 'not exercised yet'}`,
  ].join('\n');
}
async function refreshModelDiagnostics() {
  try { renderModelDiagnostics(await window.signalBox.getModelDiagnostics()); } catch (caught) { document.getElementById('model-diagnostics').textContent = caught.message || 'Diagnostics unavailable.'; }
}

function graphText(parent, x, y, value, className) {
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('x', x); text.setAttribute('y', y); text.setAttribute('class', className); text.textContent = String(value || '').slice(0, 52); parent.append(text); return text;
}
async function loadTaskGraph() {
  const svg = document.getElementById('task-graph');
  const empty = document.getElementById('graph-empty');
  svg.replaceChildren();
  try {
    const graph = await window.signalBox.getTaskGraph();
    if (!graph.nodes.length) { empty.hidden = false; svg.hidden = true; return; }
    empty.hidden = true; svg.hidden = false;
    const taskNodes = graph.nodes.filter((node) => node.type === 'task');
    const sourceNodes = graph.nodes.filter((node) => node.type === 'observation' || node.type === 'context');
    const positions = new Map();
    const height = Math.max(300, Math.max(taskNodes.length, sourceNodes.length) * 88 + 50);
    svg.setAttribute('viewBox', `0 0 900 ${height}`);
    taskNodes.forEach((node, index) => positions.set(node.id, { x: 220, y: 55 + index * 88 }));
    sourceNodes.forEach((node, index) => positions.set(node.id, { x: 680, y: 55 + index * 88 }));
    for (const edge of graph.edges) {
      const from = positions.get(edge.from); const to = positions.get(edge.to); if (!from || !to) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', from.x + 155); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x - 155); line.setAttribute('y2', to.y); line.setAttribute('class', 'graph-edge'); svg.append(line);
    }
    for (const node of graph.nodes) {
      const position = positions.get(node.id); if (!position) continue;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.setAttribute('class', `graph-node graph-${node.type}`);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); rect.setAttribute('x', position.x - 155); rect.setAttribute('y', position.y - 25); rect.setAttribute('width', 310); rect.setAttribute('height', 50); rect.setAttribute('rx', 12); group.append(rect);
      graphText(group, position.x - 140, position.y - 3, node.label, 'graph-label');
      graphText(group, position.x - 140, position.y + 16, node.type === 'task' ? `${node.status || 'active'}${node.dueDate ? ` · due ${node.dueDate}` : ''}` : (node.type === 'context' ? `${node.contextType || 'context'}${node.expired ? ' · expired' : ''}` : (node.source || 'source observation')), 'graph-meta');
      svg.append(group);
    }
  } catch (caught) { empty.hidden = false; empty.textContent = caught.message || 'Task graph unavailable.'; svg.hidden = true; }
}

const dataViews = ['activity-view', 'assistant-view', 'tasks-view', 'graph-view', 'mail-view', 'calendar-view', 'drive-view'];
const dataViewButtons = { 'activity-view': 'activity-toggle', 'assistant-view': 'assistant-toggle', 'tasks-view': 'tasks-toggle', 'graph-view': 'graph-toggle', 'mail-view': 'mail-toggle', 'calendar-view': 'calendar-toggle', 'drive-view': 'drive-toggle' };
const searchableViews = new Set(['tasks-view', 'mail-view', 'calendar-view', 'drive-view']);
function filterCurrentView() {
  const visible = dataViews.find((id) => !document.getElementById(id).hidden);
  if (!searchableViews.has(visible)) return;
  const query = document.getElementById('workspace-search').value.trim().toLocaleLowerCase();
  const cards = [...document.querySelectorAll(`#${visible} .task-card`)];
  cards.forEach((card) => { card.hidden = !card.textContent.toLocaleLowerCase().includes(query); });
  document.getElementById('search-empty').hidden = !query || cards.some((card) => !card.hidden);
}
document.getElementById('workspace-search').addEventListener('input', filterCurrentView);
for (const id of searchableViews) new MutationObserver(filterCurrentView).observe(document.getElementById(id), { childList: true, subtree: true });
async function toggleDataView(viewId, loader) {
  const target = document.getElementById(viewId);
  board.hidden = true;
  document.getElementById('session-toolbar').hidden = true;
  document.getElementById('sessions-toggle').setAttribute('aria-pressed', 'false');
  document.getElementById('view-search').hidden = !searchableViews.has(viewId);
  document.getElementById('workspace-search').value = '';
  document.getElementById('workspace-search').placeholder = `Search ${({ 'tasks-view': 'tasks', 'mail-view': 'mail', 'calendar-view': 'events', 'drive-view': 'files' })[viewId] || 'this view'}…`;
  document.getElementById('search-empty').hidden = true;
  dataViews.forEach((id) => {
    document.getElementById(id).hidden = true;
    document.getElementById(dataViewButtons[id])?.setAttribute('aria-pressed', 'false');
  });
    target.hidden = false;
    document.getElementById(dataViewButtons[viewId])?.setAttribute('aria-pressed', 'true');
    document.getElementById('view-title').textContent = document.getElementById(dataViewButtons[viewId]).textContent.trim().replace(/^[^\p{L}]+/u, '');
    await loader();
}
document.getElementById('sessions-toggle').addEventListener('click', () => {
  document.getElementById('view-search').hidden = true;
  dataViews.forEach((id) => { document.getElementById(id).hidden = true; document.getElementById(dataViewButtons[id]).setAttribute('aria-pressed', 'false'); });
  board.hidden = false;
  document.getElementById('session-toolbar').hidden = false;
  document.getElementById('sessions-toggle').setAttribute('aria-pressed', 'true');
  document.getElementById('view-title').textContent = 'Agent sessions';
});
document.querySelector('.skip-link').addEventListener('click', async (event) => { event.preventDefault(); await toggleDataView('assistant-view', loadAssistantConversation); document.getElementById('assistant-input').focus(); });
document.getElementById('connections-toggle').addEventListener('click', async () => {
  setupExpanded = !setupExpanded;
  await refreshSetupCenter();
  if (!document.getElementById('setup-list').children.length) document.getElementById('gmail-settings').click();
  else setupPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('workspace-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
document.getElementById('tasks-toggle').addEventListener('click', () => toggleDataView('tasks-view', loadTasks));
document.getElementById('tasks-refresh').addEventListener('click', loadTasks);
document.getElementById('activity-toggle').addEventListener('click', () => toggleDataView('activity-view', loadActivity));
document.getElementById('activity-refresh').addEventListener('click', loadActivity);
async function loadAssistantConversation() {
  const decisionsTarget = document.getElementById('assistant-decisions');
  const workflowsTarget = document.getElementById('assistant-workflows');
  const notificationsTarget = document.getElementById('assistant-notifications');
  const target = document.getElementById('assistant-history');
  decisionsTarget.replaceChildren();
  workflowsTarget.replaceChildren();
  notificationsTarget.replaceChildren();
  target.replaceChildren();
  try {
    const status = await window.signalBox.getAssistantStatus();
    const pauseButton = document.getElementById('assistant-pause');
    pauseButton.textContent = status.paused ? 'Resume' : 'Pause';
    pauseButton.dataset.paused = status.paused ? 'true' : 'false';
    const health = document.getElementById('assistant-health');
    health.textContent = status.paused ? 'Assistant paused' : status.running || status.background?.running ? 'Assistant active' : 'Assistant offline';
    health.dataset.state = status.paused ? 'paused' : status.running || status.background?.running ? 'active' : 'unavailable';
    const [messages, decisions, workflows, assistantTasks, notifications] = await Promise.all([
      window.signalBox.getAssistantConversation(), window.signalBox.getAssistantDecisions(), window.signalBox.getAssistantWorkflows(), window.signalBox.listTasks(), window.signalBox.getAssistantNotifications(),
    ]);
    const taskNames = new Map(assistantTasks.map((task) => [task.taskId, task.summary]));
    const actionable = decisions.filter((decision) => decision.type !== 'wait');
    const decisionHeading = document.createElement('h3'); decisionHeading.textContent = actionable.length ? 'Needs attention' : 'No triggered next steps';
    decisionsTarget.append(decisionHeading);
    if (!actionable.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'A little breathing room. No tasks need attention right now.'; decisionsTarget.append(empty); }
    for (const decision of actionable) {
      const card = document.createElement('article'); card.className = 'assistant-state';
      const task = document.createElement('strong'); task.textContent = taskNames.get(decision.taskId) || 'Task to review';
      const detail = document.createElement('span'); detail.textContent = `${({ digest: 'Upcoming deadline', clarify: 'Needs clarification', draft_follow_up: 'Time to follow up', suggest_resolution: 'Needs resolution' })[decision.type] || decision.type.replaceAll('_', ' ')} · ${decision.reason.replaceAll('-', ' ')}`;
      const evidence = document.createElement('small'); evidence.textContent = decision.evidence?.length ? `Evidence: ${decision.evidence.join(' ').slice(0, 240)}` : 'No supporting evidence recorded.';
      card.append(task, detail, evidence); decisionsTarget.append(card);
      const review = document.createElement('button'); review.type = 'button'; review.textContent = 'Review tasks →'; review.addEventListener('click', () => document.getElementById('tasks-toggle').click()); card.append(review);
    }
    if (workflows.length) {
      const workflowHeading = document.createElement('h3'); workflowHeading.textContent = 'Active workflows'; workflowsTarget.append(workflowHeading);
      for (const workflow of workflows) {
        const card = document.createElement('article'); card.className = 'assistant-state';
        const title = document.createElement('strong'); title.textContent = taskNames.get(workflow.taskId) || (workflow.workflowType === 'browser-availability' ? 'Browser availability watch' : 'Follow-up');
        const detail = document.createElement('span'); detail.textContent = workflow.workflowType === 'browser-availability' ? ({ waiting_event: 'Monitoring until a matching result is found', evaluating: 'Checking the saved browser recipe', executing: 'Availability found; reservation in progress', needs_attention: 'Needs your attention', completed: 'Monitoring completed' })[workflow.state] || workflow.state.replaceAll('_', ' ') : ({ awaiting_approval: 'Waiting for your review', waiting_event: 'Waiting for a reply', needs_attention: 'Needs your attention', verifying: 'Checking the outcome', executing: 'In progress' })[workflow.state] || workflow.state.replaceAll('_', ' ');
        const wake = document.createElement('small'); wake.textContent = workflow.wakeAt ? `Next check: ${new Date(workflow.wakeAt).toLocaleString()}` : 'No next check scheduled.';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel workflow';
        cancel.addEventListener('click', async () => { cancel.disabled = true; try { await window.signalBox.cancelAssistantWorkflow({ workflowId: workflow.workflowId }); await loadAssistantConversation(); } catch (caught) { cancel.disabled = false; showError(caught.message || 'Could not cancel workflow.'); } });
        card.append(title, detail, wake, cancel); workflowsTarget.append(card);
      }
    }
    if (!workflows.length) { const heading = document.createElement('h3'); heading.textContent = 'Following up'; const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'Nothing in motion yet. Follow-ups you start will appear here.'; workflowsTarget.append(heading, empty); }
    const pendingNotifications = notifications.filter((notification) => !notification.acknowledged);
    const notificationHeading = document.createElement('h3'); notificationHeading.textContent = pendingNotifications.length ? `${pendingNotifications.length} new signal${pendingNotifications.length === 1 ? '' : 's'}` : 'No new signals'; notificationsTarget.append(notificationHeading);
    if (!pendingNotifications.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'The assistant has nothing new to hand back right now.'; notificationsTarget.append(empty); }
    for (const notification of pendingNotifications) {
      const card = document.createElement('article'); card.className = 'assistant-state';
      const item = notification.items?.[0] || {};
      const title = document.createElement('strong'); title.textContent = item.summary || 'Signal Box update';
      const detail = document.createElement('span'); detail.textContent = item.reason || notification.notificationClass.replaceAll('-', ' ');
      const seen = document.createElement('button'); seen.type = 'button'; seen.textContent = 'Mark seen';
      seen.addEventListener('click', async () => { seen.disabled = true; try { await window.signalBox.acknowledgeAssistantNotification({ notificationId: notification.notificationId }); await loadAssistantConversation(); } catch (caught) { seen.disabled = false; showError(caught.message || 'Could not acknowledge signal.'); } });
      card.append(title, detail, seen); notificationsTarget.append(card);
    }
    await loadAssistantPermissions();
    for (const message of messages) {
      const card = document.createElement('article'); card.className = `activity-card assistant-${message.direction}`;
      const meta = document.createElement('small'); meta.textContent = `${message.direction === 'inbound' ? 'You' : 'Signal Box'} · ${new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
      const body = document.createElement('p'); body.textContent = message.content;
      card.append(meta, body); target.append(card);
    }
  } catch (caught) { document.getElementById('assistant-health').textContent = 'Assistant unavailable'; document.getElementById('assistant-health').dataset.state = 'unavailable'; showError(caught.message || 'Assistant conversation unavailable.'); }
}
async function loadAssistantPermissions() {
  const target = document.getElementById('assistant-permissions-list');
  const runsTarget = document.getElementById('assistant-runs-list');
  if (!target || !runsTarget || !window.signalBox.listStandingGrants) return;
  const [grants, runs] = await Promise.all([window.signalBox.listStandingGrants(), window.signalBox.listAutonomousRuns({ limit: 12 })]);
  const fillGrantOptions = (id, capability, recipeId, emptyText) => {
    const select = document.getElementById(id); if (!select) return;
    const matching = grants.filter((grant) => grant.status === 'active' && grant.capability === capability && (!grant.constraints?.recipeId || grant.constraints.recipeId === recipeId));
    select.replaceChildren();
    if (!matching.length) { const option = document.createElement('option'); option.value = ''; option.textContent = emptyText; select.append(option); return; }
    for (const grant of matching) { const option = document.createElement('option'); option.value = grant.grantId; option.textContent = `${grant.constraints?.recipeId || recipeId} · ${grant.usedCount}${grant.maxUses == null ? '' : `/${grant.maxUses}`} uses`; select.append(option); }
  };
  fillGrantOptions('availability-check-grant', 'browser.read', 'uber.quote-cab.v1', 'Create a browser read permission first');
  fillGrantOptions('availability-reservation-grant', 'browser.commit', 'uber.book-cab.v1', 'Create a browser commit permission first');
  target.replaceChildren(); runsTarget.replaceChildren();
  const heading = document.createElement('h3'); heading.textContent = 'Active permissions'; target.append(heading);
  if (!grants.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'No standing permissions. One-time approvals remain available.'; target.append(empty); }
  for (const grant of grants) {
    const card = document.createElement('article'); card.className = 'permission-card';
    const title = document.createElement('strong'); title.textContent = grant.capability;
    const details = document.createElement('span'); details.textContent = `${grant.constraints.recipeId || 'Any registered action'} · ${grant.usedCount}${grant.maxUses == null ? '' : `/${grant.maxUses}`} uses · expires ${new Date(grant.expiresAt).toLocaleDateString()}`;
    const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = grant.status === 'active' ? 'Revoke' : grant.status;
    revoke.disabled = grant.status !== 'active';
    revoke.addEventListener('click', async () => { revoke.disabled = true; try { await window.signalBox.revokeStandingGrant({ grantId: grant.grantId }); await loadAssistantPermissions(); } catch (caught) { revoke.disabled = false; showError(caught.message || 'Could not revoke permission.'); } });
    card.append(title, details, revoke); target.append(card);
  }
  const runHeading = document.createElement('h3'); runHeading.textContent = 'Automatic activity'; runsTarget.append(runHeading);
  if (!runs.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'No automatic actions have run yet.'; runsTarget.append(empty); }
  for (const run of runs) {
    const item = document.createElement('div'); item.className = 'permission-run';
    const label = document.createElement('span'); label.textContent = `${run.action?.recipeId || run.action?.capability || 'Action'} · ${run.status} · ${new Date(run.createdAt).toLocaleString()}`; item.append(label);
    if (run.status === 'unknown' && window.signalBox.reconcileAutonomousRun) {
      const reconcile = document.createElement('button'); reconcile.type = 'button'; reconcile.textContent = 'Mark verified';
      reconcile.addEventListener('click', async () => {
        const evidence = window.prompt('What verified that this browser action completed?');
        if (!evidence?.trim()) return;
        reconcile.disabled = true;
        try { await window.signalBox.reconcileAutonomousRun({ runId: run.runId, evidence }); await loadAssistantConversation(); }
        catch (caught) { reconcile.disabled = false; showError(caught.message || 'Could not reconcile this action.'); }
      });
      item.append(reconcile);
    }
    runsTarget.append(item);
  }
}
document.getElementById('assistant-toggle').addEventListener('click', () => toggleDataView('assistant-view', loadAssistantConversation));
document.getElementById('assistant-refresh').addEventListener('click', loadAssistantConversation);
document.getElementById('notifications-refresh')?.addEventListener('click', loadAssistantConversation);
document.getElementById('permissions-refresh')?.addEventListener('click', loadAssistantPermissions);
document.getElementById('mobile-pairing-generate')?.addEventListener('click', async () => {
  const button = document.getElementById('mobile-pairing-generate'); const output = document.getElementById('mobile-pairing-output');
  if (!window.signalBox.getMobilePairing) return;
  button.disabled = true;
  try {
    const pairing = await window.signalBox.getMobilePairing(); output.hidden = false; output.replaceChildren();
    const heading = document.createElement('span'); heading.textContent = 'One-time code';
    const code = document.createElement('strong'); code.textContent = pairing.pairingCode || 'Unavailable';
    const url = document.createElement('span'); url.textContent = `Core URL: ${pairing.hostUrl}`;
    const token = document.createElement('span'); token.textContent = `Bootstrap token: ${pairing.bootstrapToken || 'Unavailable'}`;
    const expiry = document.createElement('small'); expiry.textContent = pairing.pairingExpiresAt ? `Expires ${new Date(pairing.pairingExpiresAt).toLocaleTimeString()}. Generate a new code after it expires.` : 'Pairing code unavailable.';
    output.append(heading, code, url, token, expiry);
  } catch (caught) { showError(caught.message || 'Could not generate a mobile pairing code.'); }
  finally { button.disabled = false; }
});
document.getElementById('desktop-forget-location')?.addEventListener('click', async () => {
  if (!window.signalBox.deleteAssistantLocationHistory || !window.confirm('Forget all stored raw mobile location history? Saved places and arrival reminders will remain.')) return;
  const button = document.getElementById('desktop-forget-location'); button.disabled = true;
  try { const result = await window.signalBox.deleteAssistantLocationHistory(); button.textContent = `Forgot ${result.deleted || 0} location event${result.deleted === 1 ? '' : 's'}`; }
  catch (caught) { showError(caught.message || 'Could not forget location history.'); }
  finally { button.disabled = false; }
});
document.getElementById('permission-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const recipeId = document.getElementById('permission-recipe').value.trim();
  const origin = document.getElementById('permission-origin').value.trim();
  const hours = Math.min(8760, Math.max(1, Number(document.getElementById('permission-hours').value || 24)));
  const usesInput = document.getElementById('permission-uses').value;
  const maxUses = usesInput ? Math.min(1000, Math.max(1, Number(usesInput))) : null;
  const constraints = { ...(recipeId ? { recipeId } : {}), ...(origin ? { origin } : {}) };
  const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
  try { await window.signalBox.createStandingGrant({ capability: document.getElementById('permission-capability').value, surface: 'desktop', constraints, expiresAt: Date.now() + hours * 60 * 60 * 1000, maxUses }); await loadAssistantPermissions(); event.currentTarget.reset(); document.getElementById('permission-hours').value = '24'; }
  catch (caught) { showError(caught.message || 'Could not create permission.'); }
  finally { button.disabled = false; }
});
document.getElementById('availability-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    await window.signalBox.startAvailabilityWatch({
      inputs: {
        pickup: document.getElementById('availability-pickup').value.trim(),
        destination: document.getElementById('availability-destination').value.trim(),
        rideType: document.getElementById('availability-ride').value.trim(),
        maxFare: Number(document.getElementById('availability-max-fare').value),
      },
      checkGrantId: document.getElementById('availability-check-grant').value,
      reservationGrantId: document.getElementById('availability-reservation-grant').value,
      intervalMs: Number(document.getElementById('availability-interval').value) * 60 * 1000,
      maxChecks: Number(document.getElementById('availability-max-checks').value),
    });
    await loadAssistantConversation();
    form.reset(); document.getElementById('availability-ride').value = 'UberX'; document.getElementById('availability-interval').value = '15'; document.getElementById('availability-max-checks').value = '96';
  } catch (caught) { showError(caught.message || 'Could not start monitoring.'); }
  finally { button.disabled = false; }
});
document.getElementById('assistant-pause').addEventListener('click', async () => {
  const button = document.getElementById('assistant-pause');
  button.disabled = true;
  try { await window.signalBox.setAssistantPaused({ paused: button.dataset.paused !== 'true' }); await loadAssistantConversation(); }
  catch (caught) { showError(caught.message || 'Could not change assistant state.'); }
  finally { button.disabled = false; }
});
document.getElementById('assistant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('assistant-input');
  const text = input.value.trim(); if (!text) return;
  const send = event.currentTarget.querySelector('button[type="submit"]');
  if (send.disabled) return;
  send.disabled = true; send.textContent = 'Sending…';
  try { await window.signalBox.sendAssistantMessage({ text }); if (input.value.trim() === text) input.value = ''; await loadAssistantConversation(); }
  catch (caught) { showError(caught.message || 'Could not send assistant message.'); }
  finally { send.disabled = false; send.textContent = 'Send message ↗'; input.focus(); }
});
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  const input = document.getElementById('assistant-input'); input.value = button.dataset.prompt; input.focus();
}));
document.getElementById('assistant-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); document.getElementById('assistant-form').requestSubmit(); }
});
document.getElementById('graph-toggle').addEventListener('click', () => toggleDataView('graph-view', loadTaskGraph));
document.getElementById('graph-refresh').addEventListener('click', loadTaskGraph);
document.getElementById('mail-toggle').addEventListener('click', () => toggleDataView('mail-view', loadMailMessages));
document.getElementById('mail-refresh').addEventListener('click', loadMailMessages);
async function loadCalendarEvents() {
  try {
    const events = await window.signalBox.listCalendarEvents();
    const list = document.getElementById('calendar-list'); list.replaceChildren();
    if (!events.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'No calendar events synced yet.'; list.append(empty); return; }
    for (const event of events) {
      const card = document.createElement('article'); card.className = 'mail-card task-card';
      const title = document.createElement('h3'); title.textContent = event.subject || '(untitled event)';
      const meta = document.createElement('p'); meta.className = 'task-meta'; meta.textContent = event.timestamp ? new Date(event.timestamp).toLocaleString() : 'Unknown time';
      const body = document.createElement('p'); body.textContent = event.body || '';
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.addEventListener('click', () => openCalendarEditor(event));
      card.append(title, meta, body, edit); list.append(card);
    }
  } catch (caught) { showError(caught.message || 'Could not load calendar events.'); }
}
function calendarInputValue(value) {
  if (!value || !String(value).includes('T')) return '';
  const date = new Date(value); if (Number.isNaN(date.valueOf())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
}
function openCalendarEditor(event) {
  document.getElementById('calendar-edit-id').value = event.id || '';
  document.getElementById('calendar-edit-etag').value = event.etag || '';
  document.getElementById('calendar-edit-summary').value = event.subject || '';
  document.getElementById('calendar-edit-start').value = calendarInputValue(event.start || event.timestamp);
  document.getElementById('calendar-edit-end').value = calendarInputValue(event.end);
  document.getElementById('calendar-edit-location').value = event.location || '';
  document.getElementById('calendar-edit-description').value = event.description || '';
  document.getElementById('calendar-edit-error').hidden = true;
  document.getElementById('calendar-edit-modal').hidden = false;
}
document.getElementById('close-calendar-edit').addEventListener('click', () => { document.getElementById('calendar-edit-modal').hidden = true; });
document.getElementById('calendar-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorTarget = document.getElementById('calendar-edit-error'); errorTarget.hidden = true;
  try {
    const changes = {
      summary: document.getElementById('calendar-edit-summary').value.trim(),
      start: document.getElementById('calendar-edit-start').value,
      end: document.getElementById('calendar-edit-end').value,
      location: document.getElementById('calendar-edit-location').value.trim(),
      description: document.getElementById('calendar-edit-description').value.trim(),
    };
    const approval = await window.signalBox.prepareCalendarUpdate({ eventId: document.getElementById('calendar-edit-id').value, etag: document.getElementById('calendar-edit-etag').value, changes });
    const action = approval.action || {};
    const confirmed = window.confirm(`Save this calendar edit?\n\n${action.changes?.summary || changes.summary}`);
    if (!confirmed) return;
    await window.signalBox.executeCalendarUpdate({ requestId: approval.request_id || approval.requestId });
    document.getElementById('calendar-edit-modal').hidden = true;
    await loadCalendarEvents();
  } catch (caught) { errorTarget.textContent = caught.message || 'Could not update the calendar event.'; errorTarget.hidden = false; }
});
async function loadDriveFiles() {
  try {
    const files = await window.signalBox.listDriveFiles();
    const list = document.getElementById('drive-list'); list.replaceChildren();
    if (!files.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = 'No Drive files synced yet.'; list.append(empty); return; }
    for (const file of files) { const card = document.createElement('article'); card.className = 'mail-card task-card'; const title = document.createElement('h3'); title.textContent = file.subject || '(unnamed file)'; const meta = document.createElement('p'); meta.className = 'task-meta'; meta.textContent = file.timestamp ? new Date(file.timestamp).toLocaleString() : 'Unknown time'; const body = document.createElement('p'); body.textContent = file.body || ''; card.append(title, meta, body); list.append(card); }
  } catch (caught) { showError(caught.message || 'Could not load Drive files.'); }
}
document.getElementById('calendar-toggle').addEventListener('click', () => toggleDataView('calendar-view', loadCalendarEvents));
document.getElementById('calendar-refresh').addEventListener('click', loadCalendarEvents);
document.getElementById('calendar-sync').addEventListener('click', async () => { try { await window.signalBox.syncCalendar(); await loadCalendarEvents(); } catch (caught) { showError(caught.message || 'Calendar sync failed.'); } });
document.getElementById('drive-toggle').addEventListener('click', () => toggleDataView('drive-view', loadDriveFiles));
document.getElementById('drive-refresh').addEventListener('click', loadDriveFiles);
document.getElementById('drive-sync').addEventListener('click', async () => { try { await window.signalBox.syncDrive(); await loadDriveFiles(); } catch (caught) { showError(caught.message || 'Drive sync failed.'); } });

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
const modelModal = document.getElementById('model-modal');
document.getElementById('model-settings').addEventListener('click', async () => {
  try {
    const settings = await window.signalBox.getModelSettings();
    document.getElementById('model-mode').value = settings.mode;
    document.getElementById('local-model').value = settings.localModel;
    document.getElementById('frontier-model').value = settings.frontierModel;
    document.getElementById('frontier-base-url').value = settings.frontierBaseUrl;
    document.getElementById('frontier-api-key').value = '';
    document.getElementById('model-key-status').textContent = settings.hasFrontierKey
      ? 'Frontier API key is stored securely. Leave the field blank to keep it.'
      : 'No frontier API key is stored.';
    document.getElementById('model-error').hidden = true;
    modelModal.hidden = false;
    await refreshModelDiagnostics();
  } catch (caught) { showError(caught.message || 'Could not load AI settings.'); }
});
document.getElementById('close-model').addEventListener('click', () => { modelModal.hidden = true; });
document.getElementById('probe-local-model').addEventListener('click', async () => {
  const target = document.getElementById('model-diagnostics');
  target.textContent = 'Running local entity recognition and redaction test…';
  try {
    const result = await window.signalBox.probeLocalModel();
    target.textContent = `${result.localCall ? '✓ Local model call completed.' : 'Local model call was not made.'} ${result.redacted ? '✓ PII was removed before the pseudonymized payload boundary.' : '✕ PII redaction check failed.'}\nDetected entities: ${result.entitiesDetected}.\nSample payload: ${result.sample}`;
    await refreshModelDiagnostics();
  } catch (caught) {
    target.textContent = caught.message || 'Local model test failed. Install and start Ollama, then retry.';
  }
});
document.getElementById('model-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorTarget = document.getElementById('model-error');
  errorTarget.hidden = true;
  try {
    await window.signalBox.saveModelSettings({
      mode: document.getElementById('model-mode').value,
      localModel: document.getElementById('local-model').value.trim(),
      frontierModel: document.getElementById('frontier-model').value.trim(),
      frontierBaseUrl: document.getElementById('frontier-base-url').value.trim(),
      frontierApiKey: document.getElementById('frontier-api-key').value.trim(),
    });
    modelModal.hidden = true;
    await refreshSetupCenter();
    showError('AI settings saved.');
  } catch (caught) {
    errorTarget.textContent = caught.message || 'Could not save AI settings.';
    errorTarget.hidden = false;
  }
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
  const credentialStatus = document.getElementById('gmail-credential-status');
  if (credentialStatus) {
    credentialStatus.textContent = status.storageAvailable
      ? status.hasClientSecret
        ? '✓ Google client secret is stored securely in the OS-backed credential store. It will never be shown here.'
        : 'No Google client secret is stored. This is valid for public PKCE clients; enter one only if Google requires it.'
      : 'Secure credential storage is unavailable. No Google client secret can be stored safely.';
  }
  document.getElementById('gmail-status').textContent = !status.paired
    ? (status.storageMessage || 'Gmail is not connected.')
    : health?.status === 'error'
      ? `Gmail sync error: ${health.details?.message || 'unknown error'}`
      : health?.updatedAt
        ? `Gmail is connected. Last sync: ${new Date(health.updatedAt).toLocaleString()}.`
      : 'Gmail is connected. Calendar edits require reconnecting Google to grant Calendar event access.';
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
    document.getElementById('digest-at').value = settings.digestAt;
    document.getElementById('digest-cadence').value = String(settings.cadenceMinutes ?? 60);
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
document.getElementById('export-data').addEventListener('click', async () => {
  try {
    const result = await window.signalBox.exportData();
    if (!result.canceled) document.getElementById('digest-stats').textContent += `\nExported to ${result.filePath}`;
  } catch (caught) { document.getElementById('digest-error').textContent = caught.message || 'Could not export data.'; document.getElementById('digest-error').hidden = false; }
});
document.getElementById('delete-mail-data').addEventListener('click', async () => {
  try {
    const result = await window.signalBox.deleteMailData();
    if (!result.canceled) { await loadTasks(); await loadMailMessages(); document.getElementById('digest-stats').textContent += '\nStored Gmail data deleted.'; refreshSetupCenter(); }
  } catch (caught) { document.getElementById('digest-error').textContent = caught.message || 'Could not delete Gmail data.'; document.getElementById('digest-error').hidden = false; }
});
document.getElementById('digest-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorTarget = document.getElementById('digest-error');
  errorTarget.hidden = true;
  try {
    await window.signalBox.saveDigestSettings({
      quietHoursStart: document.getElementById('quiet-start').value,
      quietHoursEnd: document.getElementById('quiet-end').value,
      digestAt: document.getElementById('digest-at').value,
      cadenceMinutes: Number(document.getElementById('digest-cadence').value),
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
toggleDataView('assistant-view', loadAssistantConversation);
setInterval(render, 1000);
setInterval(() => {
  if (!document.getElementById('activity-view').hidden) loadActivity();
  if (!document.getElementById('browser-modal').hidden) refreshBrowserStatus();
}, 3000);
