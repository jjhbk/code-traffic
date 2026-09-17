require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, safeStorage, screen, shell } = require('electron');
const { Board } = require('./board');
const { runningAgents } = require('./processes');
const { sessionArgs } = require('./session-command');
const { restoreShellPath } = require('./shell-path');
const { checkCodexSandbox } = require('./codex-sandbox');
const { runTerminalCommand } = require('./terminal-command');
const { TelegramControl } = require('./telegram');
const { resolveCodexTileSessionId } = require('./codex-sessions');
const { queuePrompt } = require('./codex-control');
const { sessionHistory } = require('./history');
const { startCodexMonitor, terminalApprovalQuestion } = require('./codex-monitor');
const { readSettings, writeSettings } = require('./app-settings');
const { install: installClaudeHooks, settingsPaths: claudeSettingsPaths } = require('./hooks');
const { install: installCodexHooks, paths: codexConfigPaths } = require('./codex-hooks');
const { integrationStatus } = require('./host/integrations/status');
const { SqliteStore } = require('./host/store/sqlite-store');
const { ApprovalService } = require('./host/approvals/service');
const { GoogleOAuth, GmailProvider, GoogleCalendarProvider, GoogleDriveProvider } = require('./host/mail/google');
const { ProtectedCredentialStore } = require('./host/mail/credentials');
const { createOAuthState, waitForOAuthCallback } = require('./host/mail/oauth-callback');
const { MailSync } = require('./host/mail/sync');
const { TaskService } = require('./host/tasks/service');
const { DigestScheduler } = require('./host/scheduling/digest');
const { AssistantRuntime } = require('./host/runtime/assistant');
const { ProactivityService } = require('./host/proactivity/service');
const { ConversationService } = require('./host/conversation/service');
const { WorkflowService } = require('./host/workflows/service');
const { FollowUpWorkflow } = require('./host/workflows/follow-up');
const { EntityVault, PrivacyGateway } = require('./host/privacy/gateway');
const { OllamaClient } = require('./host/models/clients');
const { IsolatedFrontierClient } = require('./host/models/frontier-gateway');
const { BrowserBridge } = require('./host/browser/bridge');
const { BrowserActionService } = require('./host/browser/service');
const { BrowserRecipeExecutor } = require('./host/browser/executor');
const { BridgeBrowserAdapter } = require('./host/browser/bridge-adapter');
const { uberCabBooking, uberCabQuote } = require('./host/browser/recipes');
const { ModelRouter } = require('./host/models/router');
const { recommendLocalModel, detectGpuProfile } = require('./host/models/profile');

const GOOGLE_CLIENT_ID = process.env.SIGNAL_BOX_GOOGLE_CLIENT_ID || '';

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!windowRef || windowRef.isDestroyed()) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.show();
    windowRef.focus();
  });
}

const disableSandbox = process.env.SIGNAL_BOX_NO_SANDBOX === '1';

if (disableSandbox) {
  app.commandLine.appendSwitch('no-sandbox');
}

// WSL has a D-Bus Secret Service from GNOME Keyring but usually does not
// advertise a desktop environment, so Electron can otherwise select basic_text.
if (process.platform === 'linux' && process.env.WSL_INTEROP) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
  // WSLg's Wayland path can lose the native cursor in Electron windows.
  // X11 is the stable WSLg backend for Signal Box's desktop window.
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// WSLg/Wayland can expose a display while the GPU shared-image path is unavailable.
// Electron's software renderer is reliable for this small board and xterm view.
if (process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || process.env.WAYLAND_DISPLAY)) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

let windowRef;
let board;
let pty;
let telegram;
let stopCodexMonitor;
let livenessTimer;
let hostStore;
let approvalService;
let mailCredentials;
let mailSync;
let calendarSync;
let driveSync;
let taskService;
let digestScheduler;
let assistantRuntime;
let proactivityService;
let conversationService;
let followUpWorkflow;
let mailSyncTimer;
let calendarSyncTimer;
let driveSyncTimer;
let digestTimer;
let privacyGateway;
let modelRouter;
let modelHardware = { available: false, vendor: null, devices: [], memoryBytes: 0, reason: 'not-checked', wsl: false };
let browserBridge;
let appSettings = {};
const codexTerminalQuestions = new Map();
const terminals = new Map();
const remoteCommands = new Map();
const deliveryTimers = new Map();
const DELIVERY_ACK_TIMEOUT_MS = Number.parseInt(process.env.SIGNAL_BOX_DELIVERY_TIMEOUT_MS || '15000', 10) || 15000;
const boardPort = Number.parseInt(process.env.SIGNAL_BOX_PORT || '4747', 10);
const desktopNotificationsEnabled = false;
const SESSION_TYPES = new Set(['claude', 'codex', 'terminal']);

try {
  pty = require('node-pty');
} catch (_) {
  pty = null;
}

function createWindow() {
  const saved = readWindowState();
  const workArea = screen.getPrimaryDisplay().workArea;
  const minWidth = 620;
  const minHeight = 420;
  const maxWidth = Math.max(minWidth, Math.floor(workArea.width * 0.92));
  const maxHeight = Math.max(minHeight, Math.floor(workArea.height * 0.92));
  const width = Math.min(Math.max(saved.width || Math.floor(workArea.width * 0.84), minWidth), maxWidth);
  const height = Math.min(Math.max(saved.height || Math.floor(workArea.height * 0.84), minHeight), maxHeight);
  const x = Math.min(Math.max(saved.x ?? Math.floor(workArea.x + (workArea.width - width) / 2), workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(saved.y ?? Math.floor(workArea.y + (workArea.height - height) / 2), workArea.y), workArea.y + workArea.height - height);
  windowRef = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth,
    minHeight,
    backgroundColor: '#10141a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: process.env.SIGNAL_BOX_NO_SANDBOX !== '1',
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  windowRef.webContents.on('console-message', (_event, details) => {
    console.error(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  windowRef.webContents.on('did-finish-load', () => console.error('[renderer] loaded'));
  windowRef.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`Signal Box renderer failed to load (${code}): ${description} — ${url}`);
  });
  windowRef.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  windowRef.on('close', () => saveWindowState(windowRef.getBounds()));
  windowRef.on('closed', () => { windowRef = null; });
}

function windowStatePath() { return path.join(app.getPath('userData'), 'window.json'); }

function configureUserDataPath() {
  app.setName('signal-box');
  app.setPath('userData', path.join(app.getPath('appData'), 'signal-box'));
}

function readWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); } catch (_) { return {}; }
}
function saveWindowState(bounds) {
  try {
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(bounds));
  } catch (_) { /* Window persistence is best effort. */ }
}

function hookTokenPath() { return path.join(app.getPath('userData'), 'hook-token'); }
function ensureHookToken() {
  const file = hookTokenPath();
  try {
    const current = fs.readFileSync(file, 'utf8').trim();
    if (current) {
      try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ACLs are managed by the user profile. */ }
      return { file, token: current };
    }
  } catch (_) { /* Create it below. */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ACLs are managed by the user profile. */ }
  return { file, token };
}

function openExternalUrl(url) {
  if (process.platform === 'linux' && process.env.WSL_INTEROP) {
    return new Promise((resolve, reject) => {
      const escaped = url.replace(/'/g, "''");
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${escaped}'`], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) return resolve(true);
        shell.openExternal(url).then(() => resolve(true)).catch((error) => reject(new Error(`Windows browser launcher exited with code ${code}: ${error.message}`)));
      });
    });
  }
  return shell.openExternal(url).then(() => true);
}

function openChromeExtensionManager() {
  if (process.platform === 'linux' && process.env.WSL_INTEROP) {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-Command',
        "Start-Process chrome.exe -ArgumentList 'chrome://extensions'",
      ], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve(true);
        else reject(new Error(`Windows Chrome launcher exited with code ${code}`));
      });
    });
  }
  return openExternalUrl('chrome://extensions');
}

function withTimeout(operation, fallback, timeoutMs = 1200) {
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((resolve) => { const timer = setTimeout(() => resolve(fallback), timeoutMs); timer.unref?.(); }),
  ]);
}

function wireIpc() {
  if (typeof Menu !== 'undefined') Menu.setApplicationMenu?.(null);
  ipcMain.handle('window:minimize', () => { windowRef?.minimize(); return true; });
  ipcMain.handle('window:toggle-maximize', () => {
    if (windowRef?.isMaximized()) windowRef.unmaximize();
    else windowRef?.maximize();
    return Boolean(windowRef?.isMaximized());
  });
  ipcMain.handle('window:close', () => { windowRef?.close(); return true; });
  ipcMain.handle('external:open', (_event, target) => {
    const url = new URL(String(target || ''));
    const allowedHosts = ['console.cloud.google.com', 'support.google.com', 'developers.google.com', 'cloud.google.com', 'ollama.com'];
    const isAllowedHost = allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (url.protocol !== 'https:' || !isAllowedHost) {
      throw new Error('Signal Box can only open approved setup pages.');
    }
    return openExternalUrl(url.toString()).catch((error) => {
      throw new Error(`Could not open your default browser: ${error.message}`);
    });
  });
  ipcMain.handle('browser:open-extension-folder', async () => {
    const extensionPath = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'browser-extension');
    if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) throw new Error('The browser bridge extension is missing from this Signal Box build.');
    let windowsPath = '';
    if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME) {
      const converted = spawnSync('wslpath', ['-w', extensionPath], { encoding: 'utf8' });
      if (converted.status === 0) windowsPath = converted.stdout.trim();
    }
    const error = await withTimeout(() => {
      if (windowsPath) {
        const child = spawn('explorer.exe', [windowsPath], { stdio: 'ignore' });
        return new Promise((resolve) => child.once('error', () => resolve('Windows Explorer could not be opened.')).once('exit', (code) => resolve(code === 0 ? '' : `Windows Explorer exited with code ${code}.`)));
      }
      return shell.openPath(extensionPath);
    }, 'The folder opener did not respond.');
    // Browser security requires the user to confirm a local unpacked
    // extension. Open the manager beside the folder so the in-app action is
    // still a complete, guided install flow on every supported desktop.
    let managerOpened = false;
    try {
      const opened = await withTimeout(() => openChromeExtensionManager(), false);
      managerOpened = opened !== false;
    } catch (_) { /* Chromium may not be the default browser. */ }
    return { path: extensionPath, windowsPath, folderOpened: !error, folderError: error || null, managerOpened };
 });
  ipcMain.handle('browser:open-extension-manager', async () => {
    try { await withTimeout(() => openChromeExtensionManager(), false); return true; }
    catch (error) { throw new Error(`Could not open Chrome extensions: ${error.message}`); }
  });
  ipcMain.handle('browser:get-pairing', () => {
    const pairing = ensureHookToken();
    const port = Number.isInteger(boardPort) && boardPort > 0 && boardPort < 65536 ? boardPort : 4747;
    return { token: pairing.token, sessionId: appSettings.browserSessionId || '', hostUrl: `http://127.0.0.1:${port}` };
  });
  ipcMain.handle('browser:get-status', () => browserBridge?.status(appSettings.browserSessionId || '') || { sessionId: appSettings.browserSessionId || '', connected: false, lastSeenAt: null, pending: 0 });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_event, text = '') => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('sessions:list', () => board.list());
  ipcMain.handle('sessions:archived-list', () => board.listArchived());
  ipcMain.handle('tasks:list', () => hostStore?.listTasks() || []);
  ipcMain.handle('tasks:update', (_event, { taskId, status } = {}) => {
    if (!hostStore) throw new Error('Task storage is unavailable.');
    return hostStore.setTaskStatus(taskId, status);
  });
  ipcMain.handle('tasks:snooze', (_event, { taskId, untilAt } = {}) => {
    if (!hostStore) throw new Error('Task storage is unavailable.');
    return hostStore.snoozeTask(taskId, untilAt);
  });
  ipcMain.handle('tasks:suppress-counterparty', (_event, { counterparty, untilAt = null } = {}) => {
    if (!hostStore) throw new Error('Task storage is unavailable.');
    hostStore.setSuppression('counterparty', counterparty, untilAt, 'user');
    return true;
  });
  ipcMain.handle('tasks:list-suppressions', () => hostStore?.listSuppressions() || []);
  ipcMain.handle('tasks:remove-suppression', (_event, { scopeType, scopeKey } = {}) => {
    if (!hostStore) throw new Error('Task storage is unavailable.');
    hostStore.removeSuppression(scopeType, scopeKey);
    return true;
  });
  ipcMain.handle('tasks:correct', (_event, { taskId, changes } = {}) => {
    if (!hostStore) throw new Error('Task storage is unavailable.');
    return hostStore.correctTask(taskId, changes);
  });
  ipcMain.handle('digest:get-settings', () => ({
    quietHoursStart: appSettings.quietHoursStart || '',
    quietHoursEnd: appSettings.quietHoursEnd || '',
    digestAt: appSettings.digestAt || '08:30',
    cadenceMinutes: [15, 30, 60].includes(Number(appSettings.digestCadenceMinutes)) ? Number(appSettings.digestCadenceMinutes) : 60,
    dailyCap: Number.isInteger(appSettings.dailyDigestCap) ? appSettings.dailyDigestCap : 5,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    stats: hostStore?.notificationStats() || { delivery: {}, feedback: {} },
    history: hostStore?.listNotifications() || [],
  }));
  ipcMain.handle('digest:save-settings', (_event, { quietHoursStart = '', quietHoursEnd = '', digestAt = '08:30', cadenceMinutes = 60, dailyCap = 5 } = {}) => {
    const validTime = (value) => value === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    const cap = Number(dailyCap);
    const cadence = Number(cadenceMinutes);
    if (!validTime(quietHoursStart) || !validTime(quietHoursEnd) || !validTime(digestAt)) throw new Error('Digest and quiet hours must use HH:MM format.');
    if (!Number.isInteger(cap) || cap < 1 || cap > 50) throw new Error('Daily digest cap must be between 1 and 50.');
    if (![0, 15, 30, 60].includes(cadence)) throw new Error('Digest cadence must be daily, 15, 30, or 60 minutes.');
    appSettings = { ...appSettings, quietHoursStart, quietHoursEnd, digestAt, digestCadenceMinutes: cadence, dailyDigestCap: cap };
    writeSettings(app.getPath('userData'), appSettings);
    if (digestScheduler) {
      digestScheduler.quietStart = quietHoursStart || null;
      digestScheduler.quietEnd = quietHoursEnd || null;
      digestScheduler.digestAt = digestAt;
      digestScheduler.cadenceMinutes = cadence;
      digestScheduler.dailyCap = cap;
    }
    return { quietHoursStart, quietHoursEnd, digestAt, cadenceMinutes: cadence, dailyCap: cap };
  });
  ipcMain.handle('model:get-status', () => ({ ...(modelRouter?.status() || { mode: 'off', local: false, frontier: false, active: false }), hardware: modelHardware }));
  ipcMain.handle('model:get-settings', () => ({
    mode: modelRouter?.mode || appSettings.modelMode || 'local',
    localModel: modelRouter?.localClient?.model || appSettings.localModel || '',
    frontierModel: modelRouter?.frontierClient?.model || appSettings.frontierModel || 'gpt-4o-mini',
    frontierBaseUrl: appSettings.frontierBaseUrl || process.env.SIGNAL_BOX_FRONTIER_BASE_URL || 'https://api.openai.com/v1',
    hasFrontierKey: Boolean(mailCredentials?.has('frontier-api-key') || process.env.SIGNAL_BOX_FRONTIER_API_KEY),
    storageAvailable: Boolean(mailCredentials),
  }));
  ipcMain.handle('model:save-settings', (_event, { mode = 'local', localModel = '', frontierModel = 'gpt-4o-mini', frontierBaseUrl = '', frontierApiKey = '' } = {}) => {
    if (!['local', 'frontier', 'off'].includes(mode)) throw new Error('Choose local, frontier, or off model mode.');
    const cleanLocal = String(localModel || '').trim();
    const cleanFrontier = String(frontierModel || '').trim();
    const cleanBase = String(frontierBaseUrl || '').trim();
    const cleanKey = String(frontierApiKey || '').trim();
    if (!cleanLocal || !cleanFrontier) throw new Error('Both model names are required.');
    if (mode === 'frontier' && !cleanKey && !mailCredentials?.has('frontier-api-key') && !process.env.SIGNAL_BOX_FRONTIER_API_KEY) throw new Error('Enter a frontier API key before enabling frontier mode.');
    if (cleanKey) {
      if (!mailCredentials) throw new Error('Secure credential storage is unavailable. Start the OS keyring before saving the frontier API key.');
      mailCredentials.save('frontier-api-key', cleanKey);
    }
    appSettings = { ...appSettings, modelMode: mode, localModel: cleanLocal, frontierModel: cleanFrontier, ...(cleanBase ? { frontierBaseUrl: cleanBase } : {}) };
    writeSettings(app.getPath('userData'), appSettings);
    configureModelRouter();
    return { mode: modelRouter.mode, localModel: modelRouter.localClient?.model || cleanLocal, frontierModel: modelRouter.frontierClient?.model || cleanFrontier, hasFrontierKey: Boolean(mailCredentials?.has('frontier-api-key') || process.env.SIGNAL_BOX_FRONTIER_API_KEY) };
  });
  ipcMain.handle('model:check', async () => ({ ...(await (modelRouter?.availability() || { mode: 'off', local: false, frontier: false, active: false, localAvailable: false })), hardware: modelHardware }));
  ipcMain.handle('model:diagnostics', () => modelRouter?.diagnostics() || { mode: 'off', metrics: {} });
  ipcMain.handle('model:probe', async () => modelRouter?.probe() || { localCall: false, redacted: false });
  ipcMain.handle('tasks:graph', () => hostStore?.taskGraph({ includeDismissed: true }) || { nodes: [], edges: [] });
  ipcMain.handle('assistant:decisions', () => proactivityService?.evaluate(hostStore?.listTasks() || []) || []);
  ipcMain.handle('assistant:conversation', () => conversationService?.history('desktop:signal-box') || []);
  ipcMain.handle('activity:list', () => {
    const entries = hostStore?.recentAudit(60) || [];
    const diagnostics = modelRouter?.diagnostics();
    const modelEvents = [];
    if (diagnostics?.metrics?.lastPrivacyCheck) modelEvents.push({ kind: 'model-privacy', details: diagnostics.metrics.lastPrivacyCheck, createdAt: diagnostics.metrics.lastPrivacyCheck.at });
    if (diagnostics?.metrics?.lastLocalCall) modelEvents.push({ kind: 'model-local', details: diagnostics.metrics.lastLocalCall, createdAt: diagnostics.metrics.lastLocalCall.at });
    if (diagnostics?.metrics?.lastRanking) modelEvents.push({ kind: 'model-ranking', details: diagnostics.metrics.lastRanking, createdAt: diagnostics.metrics.lastRanking.at });
    return [...entries, ...modelEvents].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60).map((entry) => ({
      kind: entry.kind,
      createdAt: entry.createdAt,
      details: entry.kind === 'connector-health' ? { status: entry.details.status, provider: String(entry.details.adapterId || '').split(':')[0] || 'connector' }
        : entry.kind === 'event-ingested' ? { status: 'received', type: entry.details.type || 'event' }
          : entry.kind === 'observation-saved' ? { status: 'stored', provider: String(entry.details.adapterId || '').split(':')[0] || 'source' }
            : entry.kind.startsWith('execution-') ? { status: entry.kind.slice('execution-'.length), capability: entry.details.capability || entry.details.provider || 'action' }
              : entry.kind.startsWith('notification-') ? { status: entry.kind.slice('notification-'.length), type: entry.details.notificationClass || 'notification' }
                : entry.details,
    }))
  });
  ipcMain.handle('integrations:status', () => integrationStatus({
    claudeConfig: claudeSettingsPaths().settings,
    codexConfig: codexConfigPaths().config,
    hookMarker: `127.0.0.1:${Number.isInteger(boardPort) && boardPort > 0 && boardPort < 65536 ? boardPort : 4747}/hook?state=`,
  }));
  ipcMain.handle('browser:prepare-uber', async (_event, { pickup, destination, rideType = 'UberX', maxFare, sessionId = null, preflight = false } = {}) => {
    if (!hostStore || !approvalService) throw new Error('Durable browser action storage is unavailable.');
    const service = new BrowserActionService({ approvals: approvalService, store: hostStore, executor: null });
    const recipe = preflight ? uberCabQuote : uberCabBooking;
    const request = service.prepare(recipe, { pickup, destination, rideType, maxFare }, { principal: 'signal-box-user', surfaces: ['desktop', 'telegram'], sessionId: sessionId || appSettings.browserSessionId });
    try { await telegram?.sendBrowserApproval(request); } catch (error) { console.error(`[telegram] browser approval notification failed: ${error.message}`); }
    return request;
  });
  ipcMain.handle('browser:decide', async (_event, { requestId, optionId = 'allow', sessionId = null } = {}) => {
    if (!approvalService) throw new Error('Browser approval storage is unavailable.');
    const decision = approvalService.decide(requestId, optionId, { principal: 'signal-box-user', surface: 'desktop' });
    if (optionId !== 'allow') return { status: 'cancelled', decision };
    return { status: 'approved', decision, ...(await dispatchBrowserAction(requestId, sessionId, 'desktop')) };
  });
  ipcMain.handle('browser:execute', async (_event, { requestId, sessionId, surface = 'desktop' } = {}) => {
    if (!hostStore || !approvalService || !browserBridge) throw new Error('Browser action execution is unavailable.');
    const activeSessionId = sessionId || appSettings.browserSessionId;
    if (!activeSessionId) throw new Error('A browser session ID is required.');
    const adapter = new BridgeBrowserAdapter({ bridge: browserBridge, sessionId: activeSessionId, origin: uberCabBooking.origin });
    const executor = new BrowserRecipeExecutor({ browser: adapter });
    const service = new BrowserActionService({ approvals: approvalService, store: hostStore, executor });
    return service.executeApproved(requestId, { executor, principal: 'signal-box-user', surface });
  });
  ipcMain.handle('data:export', async () => {
    if (!hostStore) throw new Error('Durable storage is unavailable.');
    const result = await dialog.showSaveDialog(windowRef, { title: 'Export Signal Box data', defaultPath: 'signal-box-export.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, `${JSON.stringify(hostStore.exportData(), null, 2)}\n`, { mode: 0o600 });
    return { canceled: false, filePath: result.filePath };
  });
  ipcMain.handle('data:delete-mail', async () => {
    if (!hostStore) throw new Error('Durable storage is unavailable.');
    const confirmation = await dialog.showMessageBox(windowRef, { type: 'warning', buttons: ['Delete stored Gmail data', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Delete stored Gmail data', message: 'Remove synced Gmail messages, derived tasks, and digest history from this device?', detail: 'This disconnects no account and cannot undo the local deletion.' });
    if (confirmation.response !== 0) return { canceled: true };
    const counts = hostStore.deleteMailData();
    return { canceled: false, counts };
  });
  ipcMain.handle('settings:get', () => ({
    configured: Boolean(appSettings.telegramBotToken && appSettings.telegramChatId),
    enabled: appSettings.telegramEnabled === true
      || (appSettings.telegramEnabled === undefined && Boolean(appSettings.telegramBotToken)),
    hasToken: Boolean(appSettings.telegramBotToken),
    chatId: appSettings.telegramChatId || '',
  }));
  ipcMain.handle('settings:save', (_event, { telegramBotToken, telegramChatId, telegramEnabled = true } = {}) => {
    const submittedToken = typeof telegramBotToken === 'string' ? telegramBotToken.trim() : '';
    const token = submittedToken || appSettings.telegramBotToken || '';
    const chatId = typeof telegramChatId === 'string' ? telegramChatId.trim() : '';
    const tokenChanged = Boolean(submittedToken && submittedToken !== appSettings.telegramBotToken);
    const savedChatId = tokenChanged ? '' : chatId;
    if (telegramEnabled && !token) throw new Error('Enter a Telegram bot token to continue.');
    appSettings = { ...appSettings, telegramEnabled, telegramBotToken: token, telegramChatId: savedChatId };
    writeSettings(app.getPath('userData'), appSettings);
    if (telegram) {
      telegram.stop();
      telegram.token = token;
      telegram.chatId = savedChatId;
      if (telegramEnabled) telegram.start();
    }
    return {
      configured: Boolean(telegramEnabled && token && savedChatId),
      enabled: telegramEnabled,
      chatId: savedChatId,
      tokenChanged,
    };
  });
  ipcMain.handle('mail:status', () => {
    const account = mailCredentials?.load('gmail-account') || '';
    const adapterId = account ? `gmail:${account}` : null;
    return { paired: Boolean(mailCredentials?.load('gmail-refresh-token')), provider: 'gmail', account, clientId: mailCredentials?.load('gmail-client-id') || GOOGLE_CLIENT_ID || '', hasClientSecret: Boolean(mailCredentials?.has('gmail-client-secret')), storageAvailable: Boolean(mailCredentials), storageMessage: mailCredentials ? null : 'Signal Box cannot access the OS credential store. Start a desktop keyring service, then restart Signal Box.', health: adapterId ? hostStore?.getConnectorHealth(adapterId) || null : null };
  });
  ipcMain.handle('mail:sync', async () => runMailSync());
  ipcMain.handle('calendar:sync', async () => runCalendarSync());
  ipcMain.handle('calendar:status', () => {
    const account = mailCredentials?.load('gmail-account') || '';
    const adapterId = account ? `calendar:${account}` : null;
    return { paired: Boolean(calendarSync), provider: 'google-calendar', account, health: adapterId ? hostStore?.getConnectorHealth(adapterId) || null : null };
  });
  ipcMain.handle('calendar:events', () => {
    const account = mailCredentials?.load('gmail-account') || '';
    return hostStore?.observations(account ? `calendar:${account}` : null).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)) || [];
  });
  ipcMain.handle('calendar:prepare-update', (_event, { eventId, changes = {}, etag = null } = {}) => {
    if (!hostStore || !approvalService) throw new Error('Durable calendar action storage is unavailable.');
    if (!eventId || !changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('A calendar event and edit fields are required.');
    const allowed = ['summary', 'description', 'location', 'start', 'end'];
    const sanitized = Object.fromEntries(Object.entries(changes).filter(([key, value]) => allowed.includes(key) && typeof value === 'string'));
    if (!Object.keys(sanitized).length || !sanitized.summary?.trim() || !sanitized.start || !sanitized.end) throw new Error('Calendar title, start, and end are required.');
    const action = { capability: 'calendar.update', autonomous: false, eventId: String(eventId), etag: etag || null, changes: sanitized, consequences: 'Update this Google Calendar event and notify its guests according to Google Calendar settings.', options: [{ optionId: 'update', label: 'Save calendar edit' }, { optionId: 'deny', label: 'Cancel' }] };
    return approvalService.request(action, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 10 * 60 * 1000 });
  });
  ipcMain.handle('calendar:execute-update', async (_event, { requestId } = {}) => dispatchCalendarUpdate(requestId, 'signal-box-user', 'desktop'));
  ipcMain.handle('drive:sync', async () => runDriveSync());
  ipcMain.handle('drive:status', () => {
    const account = mailCredentials?.load('gmail-account') || '';
    const adapterId = account ? `drive:${account}` : null;
    return { paired: Boolean(driveSync), provider: 'google-drive', account, health: adapterId ? hostStore?.getConnectorHealth(adapterId) || null : null };
  });
  ipcMain.handle('drive:files', () => {
    const account = mailCredentials?.load('gmail-account') || '';
    return hostStore?.observations(account ? `drive:${account}` : null).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)) || [];
  });
  ipcMain.handle('mail:messages', () => {
    if (!hostStore) return [];
    const account = mailCredentials?.load('gmail-account') || '';
    const adapterId = account ? `gmail:${account}` : null;
    return hostStore.observations(adapterId).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  });
  ipcMain.handle('mail:propose-reply', async (_event, { taskId, subject, body } = {}) => {
    if (!hostStore || !approvalService) throw new Error('Durable action storage is unavailable.');
    const task = hostStore.listTasks({ includeDismissed: true }).find((item) => item.taskId === taskId);
    if (!task) throw new Error('Task not found.');
    if (!followUpWorkflow) throw new Error('Follow-up workflows are unavailable.');
    const { approval } = followUpWorkflow.prepare(task, { subject, body, principal: 'signal-box-user', surfaces: ['desktop', 'telegram'], expiresAt: Date.now() + 10 * 60 * 1000 });
    try { await telegram?.sendReplyApproval(approval); } catch (error) { console.error(`[telegram] reply approval notification failed: ${error.message}`); }
    return approval;
  });
  ipcMain.handle('mail:send-approved-reply', async (_event, { requestId } = {}) => {
    return dispatchApprovedReply(requestId, 'signal-box-user', 'desktop');
  });
  ipcMain.handle('mail:reconcile-reply', async (_event, { requestId, attemptId } = {}) => reconcileApprovedReply(requestId, attemptId, 'desktop'));
  ipcMain.handle('mail:disconnect', () => {
    if (!mailCredentials) {
      const error = new Error('Secure credential storage is unavailable. Start your desktop keyring service (GNOME Keyring, KDE Wallet, or Secret Service), then restart Signal Box.');
      error.code = 'CREDENTIAL_STORAGE_UNAVAILABLE';
      throw error;
    }
    for (const name of ['gmail-refresh-token', 'gmail-client-id', 'gmail-client-secret', 'gmail-account']) mailCredentials.delete(name);
    mailSync = null;
    calendarSync = null;
    driveSync = null;
    return { paired: false, provider: 'gmail' };
  });
  ipcMain.handle('mail:pair', async (_event, { clientId: submittedClientId = '', clientSecret: submittedClientSecret = '' } = {}) => {
    if (!mailCredentials) throw new Error('Protected credential storage is unavailable.');
    const clientId = String(submittedClientId || GOOGLE_CLIENT_ID || mailCredentials.load('gmail-client-id') || '').trim();
    const clientSecret = String(submittedClientSecret || mailCredentials.load('gmail-client-secret') || '').trim();
    if (!clientId) throw new Error('Google connection is not configured in this Signal Box build.');
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = createOAuthState();
    let ready;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
    const callback = waitForOAuthCallback({
      expectedState: state,
      onReady: ({ host, port }) => {
        ready({ host, port });
        windowRef?.webContents.send('mail:pair-progress', { stage: 'waiting-for-google', redirectUri: `http://${host}:${port}/oauth/callback` });
      },
      onError: (error) => {
        windowRef?.webContents.send('mail:pair-progress', { stage: 'error', message: error.message });
        rejectReady(error);
      },
    });
    const { port } = await readyPromise;
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const oauth = new GoogleOAuth({ clientId, clientSecret: clientSecret || null });
    await openExternalUrl(oauth.authorizationUrl({ redirectUri, state, codeChallenge }));
    windowRef?.webContents.send('mail:pair-progress', { stage: 'browser-opened' });
    const code = await callback;
    windowRef?.webContents.send('mail:pair-progress', { stage: 'callback-received' });
    const tokens = await oauth.exchangeCode(code, redirectUri, codeVerifier);
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Reauthorize with offline access.');
    windowRef?.webContents.send('mail:pair-progress', { stage: 'saving-credentials' });
    mailCredentials.save('gmail-refresh-token', tokens.refresh_token);
    mailCredentials.save('gmail-client-id', clientId);
    if (clientSecret) mailCredentials.save('gmail-client-secret', clientSecret);
    let account = '';
    try {
      const profile = await new GmailProvider({ accessToken: tokens.access_token }).request('/profile');
      account = profile.emailAddress || '';
      if (account) mailCredentials.save('gmail-account', account);
    } catch (error) { console.error(`[mail] could not read Gmail profile: ${error.message}`); }
    wireMailSync();
    return { paired: true, provider: 'gmail', account };
  });
  ipcMain.handle('session:create', async (_event, { cwd, agent = 'claude' } = {}) => {
    if (!SESSION_TYPES.has(agent)) throw new Error('Choose Claude Code, Codex, or Terminal.');
    const tile = crypto.randomUUID();
    board.register(tile, cwd, agent);
    try { await spawnSession(tile, cwd, agent, null, false); }
    catch (error) { board.close(tile); throw error; }
    return tile;
  });
  ipcMain.handle('session:open', async (_event, { tile } = {}) => {
    const session = board.sessions.get(tile) || board.unarchive(tile);
    if (!session) throw new Error('That session is no longer available.');
    await spawnSession(tile, session.cwd, session.agent || 'claude', session.sessionId, true);
    board.reopen(tile);
    return true;
  });
  ipcMain.handle('session:close', (_event, { tile, permanent = false } = {}) => {
    telegram?.clearApproval(tile);
    const child = terminals.get(tile);
    if (child) {
      child.kill();
      terminals.delete(tile);
    }
    return permanent ? board.close(tile) : board.archive(tile);
  });
  ipcMain.handle('folder:pick', async () => {
    const result = await dialog.showOpenDialog(windowRef, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('pty:write', (_event, { tile, data } = {}) => {
    if (typeof data === 'string') {
      terminals.get(tile)?.write(data);
      const session = board.sessions.get(tile);
      if (session?.agent !== 'terminal' && /[\r\n]$/.test(data)) {
        submitDelivery(tile, { channel: 'desktop-pty', sessionId: session.sessionId });
        board.handleHook('working', tile, { cwd: session.cwd, session_id: session.sessionId });
      }
    }
  });
  ipcMain.on('session:working', (_event, { tile } = {}) => {
    const session = board.sessions.get(tile);
    if (tile && terminals.has(tile) && session?.agent !== 'terminal') {
      board.handleHook('working', tile, { cwd: session.cwd, session_id: session.sessionId });
    }
  });
  ipcMain.on('pty:resize', (_event, { tile, cols, rows } = {}) => {
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) terminals.get(tile)?.resize(cols, rows);
  });
}

async function dispatchApprovedReply(requestId, principal, surface) {
  if (!hostStore || !approvalService) throw new Error('Durable action storage is unavailable.');
  const request = hostStore.getApproval(requestId);
  if (!request || request.action?.capability !== 'gmail.send') throw new Error('Reply approval not found.');
  const action = request.action;
  const currentTask = action.taskId ? hostStore.listTasks({ includeDismissed: true }).find((task) => task.taskId === action.taskId) : null;
  if (action.taskId && (!currentTask || currentTask.status !== 'active')) throw new Error('This follow-up is no longer attached to an active task.');
  if (action.taskVersion != null && currentTask && Number(currentTask.updatedAt) !== Number(action.taskVersion)) throw new Error('This follow-up is stale because the task changed.');
  const provider = createGmailProvider();
  const decision = approvalService.decide(requestId, 'send', { principal, surface });
  const attempt = approvalService.execution({ requestId, status: 'prepared', details: { capability: action.capability, destination: action.destination, surface } });
  approvalService.execution({ attemptId: attempt.attemptId, requestId, status: 'authorized', details: { decisionId: decision.decisionId, surface } });
  try {
    approvalService.execution({ attemptId: attempt.attemptId, requestId, status: 'dispatched', details: { provider: 'gmail', surface } });
    const sent = await provider.sendReply({ to: action.destination, subject: action.content.subject, body: action.content.body, threadId: action.threadId, inReplyTo: action.inReplyTo, references: action.references });
    approvalService.execution({ attemptId: attempt.attemptId, requestId, status: 'confirmed', details: { provider: 'gmail', messageId: sent.id || null, threadId: sent.threadId || action.threadId } });
    approvalService.receipt({ attemptId: attempt.attemptId, receipt: { provider: 'gmail', messageId: sent.id || null, threadId: sent.threadId || action.threadId, destination: action.destination } });
    if (action.workflowId) hostStore.updateWorkflow(action.workflowId, { state: 'waiting_event', wakeAt: Date.now() + 48 * 60 * 60 * 1000, payload: { ...hostStore.getWorkflow(action.workflowId).payload, sentMessageId: sent.id || null, outcome: 'confirmed' }, details: { attemptId: attempt.attemptId } });
    return { status: 'confirmed', attemptId: attempt.attemptId, messageId: sent.id || null };
  } catch (error) {
    const status = error.name === 'AbortError' || /timeout|network|fetch/i.test(error.message) ? 'unknown' : 'failed';
    approvalService.execution({ attemptId: attempt.attemptId, requestId, status, details: { provider: 'gmail', error: error.message, surface } });
    if (action.workflowId) hostStore.updateWorkflow(action.workflowId, { state: status === 'unknown' ? 'needs_attention' : 'needs_attention', payload: { ...hostStore.getWorkflow(action.workflowId).payload, outcome: status, error: error.message }, details: { attemptId: attempt.attemptId } });
    if (status === 'unknown') {
      error.code = 'EXECUTION_UNKNOWN';
      error.attemptId = attempt.attemptId;
      error.requestId = requestId;
    }
    throw error;
  }
}

async function dispatchCalendarUpdate(requestId, principal, surface) {
  if (!hostStore || !approvalService) throw new Error('Durable action storage is unavailable.');
  const request = hostStore.getApproval(requestId);
  if (!request || request.action?.capability !== 'calendar.update') throw new Error('Calendar edit approval not found.');
  const action = request.action;
  const account = mailCredentials?.load('gmail-account') || '';
  const refreshToken = mailCredentials?.load('gmail-refresh-token') || '';
  const clientId = mailCredentials?.load('gmail-client-id') || GOOGLE_CLIENT_ID || '';
  const clientSecret = mailCredentials?.load('gmail-client-secret') || null;
  if (!account || !refreshToken || !clientId) throw new Error('Connect Google before editing Calendar.');
  const provider = new GoogleCalendarProvider({ refreshToken, oauth: new GoogleOAuth({ clientId, clientSecret }) });
  const decision = approvalService.decide(requestId, 'update', { principal, surface });
  const attempt = approvalService.execution({ requestId, status: 'prepared', details: { capability: action.capability, eventId: action.eventId, surface } });
  approvalService.execution({ attemptId: attempt.attemptId, requestId, status: 'authorized', details: { decisionId: decision.decisionId, surface } });
  try {
    approvalService.execution({ attemptId: attempt.attemptId, requestId, status: 'dispatched', details: { provider: 'google-calendar', eventId: action.eventId, surface } });
    const changes = { ...action.changes };
    for (const key of ['start', 'end']) if (typeof changes[key] === 'string') changes[key] = { dateTime: new Date(changes[key]).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    const updated = await provider.updateEvent(action.eventId, changes, { etag: action.etag });
    approvalService.execution({ attemptId: attempt.attemptId, requestId, status: 'confirmed', details: { provider: 'google-calendar', eventId: updated.id || action.eventId, surface } });
    approvalService.receipt({ attemptId: attempt.attemptId, receipt: { provider: 'google-calendar', eventId: updated.id || action.eventId, etag: updated.etag || null, changedFields: Object.keys(changes) } });
    return { status: 'confirmed', attemptId: attempt.attemptId, eventId: updated.id || action.eventId };
  } catch (error) {
    const status = error.name === 'AbortError' || /timeout|network|fetch/i.test(error.message) ? 'unknown' : 'failed';
    approvalService.execution({ attemptId: attempt.attemptId, requestId, status, details: { provider: 'google-calendar', eventId: action.eventId, error: error.message, surface } });
    if (status === 'unknown') { error.code = 'EXECUTION_UNKNOWN'; error.attemptId = attempt.attemptId; error.requestId = requestId; }
    throw error;
  }
}

async function reconcileApprovedReply(requestId, attemptId, surface) {
  if (!hostStore || !approvalService) throw new Error('Durable action storage is unavailable.');
  const request = hostStore.getApproval(requestId);
  const attempt = hostStore.getExecutionAttempt(attemptId);
  if (!request || !attempt || attempt.requestId !== requestId) throw new Error('Reply execution record not found.');
  if (attempt.status !== 'unknown') return { status: attempt.status, attemptId };
  const action = request.action;
  const provider = createGmailProvider();
  const result = await provider.reconcileReply({ to: action.destination, subject: action.content.subject, body: action.content.body, threadId: action.threadId });
  if (!result.found) return { status: 'unknown', attemptId, reconciled: false };
  approvalService.execution({ attemptId, requestId, status: 'confirmed', details: { provider: 'gmail', surface, reconciled: true, messageId: result.messageId } });
  approvalService.receipt({ attemptId, receipt: { provider: 'gmail', messageId: result.messageId, threadId: result.threadId, destination: action.destination, reconciled: true } });
  if (action.workflowId) hostStore.updateWorkflow(action.workflowId, { state: 'waiting_event', wakeAt: Date.now() + 48 * 60 * 60 * 1000, payload: { ...hostStore.getWorkflow(action.workflowId).payload, sentMessageId: result.messageId, outcome: 'reconciled' }, details: { attemptId, reconciled: true } });
  return { status: 'confirmed', attemptId, messageId: result.messageId, reconciled: true };
}

async function spawnSession(tile, cwd, agent, sessionId, reopening) {
  if (!pty) throw new Error('Embedded terminals are unavailable because node-pty could not be loaded.');
  if (!cwd || typeof cwd !== 'string') throw new Error('Choose a project folder first.');
  if (terminals.has(tile)) return;
  if (!SESSION_TYPES.has(agent)) throw new Error('Unsupported session type.');
  const launchRecord = board.sessions.get(tile);
  if (!launchRecord) throw new Error('This session was closed.');
  const binary = findAgent(agent);
  const displayName = agent === 'codex' ? 'Codex CLI' : agent === 'terminal' ? 'A system shell' : 'Claude Code';
  if (!binary) throw new Error(`${displayName} was not found. Install or configure it, then restart Signal Box.`);
  if (agent === 'codex' && reopening) {
    if (!sessionId && launchRecord.state == null) {
      reopening = false;
    } else {
      const resolvedId = resolveCodexTileSessionId(sessionId, cwd, launchRecord.sessionIdVerified ? null : launchRecord.created);
      if (!resolvedId) throw new Error('Cannot identify this Codex thread safely. Create a new session instead.');
      sessionId = resolvedId;
      if (launchRecord.sessionId !== resolvedId || !launchRecord.sessionIdVerified) {
        launchRecord.sessionId = resolvedId;
        launchRecord.sessionIdVerified = true;
        board.persist();
      }
    }
  }
  const args = sessionArgs(agent, sessionId, reopening);
  const env = { ...process.env, SIGNAL_TILE: tile, SIGNAL_AGENT: agent };
  if (agent === 'codex') await checkCodexSandbox(binary, cwd, env);
  if (board.sessions.get(tile) !== launchRecord) throw new Error('This session was closed during startup.');
  if (terminals.has(tile)) return;
  const child = pty.spawn(binary, args, {
    name: 'xterm-256color',
    // These are only safe startup values. The renderer immediately resizes
    // the PTY to the actual terminal panel dimensions after it is painted.
    cols: 80,
    rows: 24,
    cwd,
    env,
  });
  terminals.set(tile, child);
  child.onData((data) => {
    if (agent === 'codex') {
      const previousEntry = codexTerminalQuestions.get(tile);
      const previous = previousEntry?.buffer || '';
      const buffer = `${previous}${data}`.slice(-12000);
      const question = terminalApprovalQuestion(buffer);
      codexTerminalQuestions.set(tile, { buffer, question });
      if (question && JSON.stringify(previousEntry?.question || null) !== JSON.stringify(question)) {
        board.handleHook('approval', tile, { session_id: sessionId, cwd });
      }
    }
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('pty:data', { tile, data });
  });
  child.onExit(({ exitCode = null, signal = null } = {}) => {
    terminals.delete(tile);
    codexTerminalQuestions.delete(tile);
    board.processExited(tile, { code: exitCode, signal });
  });
}

function findAgent(agent) {
  if (agent === 'terminal') {
    return process.platform === 'win32'
      ? process.env.COMSPEC || 'powershell.exe'
      : process.env.SHELL || '/bin/bash';
  }
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [agent === 'codex' ? 'codex' : 'claude'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/)[0] || null;
}

async function executeRemoteTerminal(session, command) {
  const tile = session.tile || session.key;
  if (remoteCommands.has(tile)) throw new Error('A command is already running in this terminal. Use /interrupt first.');
  const shell = findAgent('terminal');
  let child;
  try {
    return await runTerminalCommand({
      command,
      cwd: session.cwd,
      shell,
      onSpawn: (spawned) => {
        child = spawned;
        remoteCommands.set(tile, spawned);
      },
    });
  } finally {
    if (remoteCommands.get(tile) === child) remoteCommands.delete(tile);
  }
}

function interruptRemoteTerminal(session) {
  const tile = session.tile || session.key;
  const child = remoteCommands.get(tile);
  if (!child) return false;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGINT');
    else child.kill('SIGINT');
  } catch (_) {
    try { child.kill('SIGINT'); } catch (_) { return false; }
  }
  return true;
}

function clearDeliveryTimer(tile) {
  const timer = deliveryTimers.get(tile);
  if (timer) clearTimeout(timer);
  deliveryTimers.delete(tile);
}

function submitDelivery(tile, details = {}) {
  const attemptId = details.attemptId || crypto.randomUUID();
  clearDeliveryTimer(tile);
  board.recordDelivery(tile, 'submitted', { ...details, attemptId });
  const timer = setTimeout(() => {
    const session = board.sessions.get(tile);
    if (session?.delivery?.status === 'submitted' && session.delivery.attemptId === attemptId) {
      board.recordDelivery(tile, 'unknown', { ...session.delivery, attemptId, reason: 'acknowledgement-timeout' });
    }
    deliveryTimers.delete(tile);
  }, DELIVERY_ACK_TIMEOUT_MS);
  timer.unref?.();
  deliveryTimers.set(tile, timer);
  return attemptId;
}

async function sendRemoteAgentPrompt(session, message) {
  if (session.agent !== 'codex') return false;
  const threadId = resolveCodexTileSessionId(session.sessionId, session.cwd, session.sessionIdVerified ? null : session.created);
  if (!threadId) {
    throw new Error(session.sessionId
      ? 'Cannot verify this tile\'s Codex thread. Create a new tile instead.'
      : 'Open this Signal Box tile and finish a Codex turn before sending prompts remotely.');
  }
  const saved = board.sessions.get(session.tile || session.key);
  if (saved && (saved.sessionId !== threadId || !saved.sessionIdVerified)) {
    saved.sessionId = threadId;
    saved.sessionIdVerified = true;
    board.persist();
  }
  const binary = findAgent('codex');
  if (!binary) throw new Error('Codex CLI was not found on PATH.');
  const tile = session.tile || session.key;
  const attemptId = submitDelivery(tile, { channel: 'codex-queue', sessionId: threadId });
  try {
    await queuePrompt({ binary, threadId, message, cwd: session.cwd });
  } catch (error) {
    clearDeliveryTimer(tile);
    board.recordDelivery(tile, 'failed', { attemptId, channel: 'codex-queue', error: error.message });
    throw error;
  }
  // `codex queue` succeeding proves that the local Codex queue accepted the
  // prompt. Codex does not provide the Claude-style UserPromptSubmit hook,
  // so acknowledge this delivery here to avoid a permanent waiting label.
  board.recordDelivery(tile, 'acknowledged', { attemptId, channel: 'codex-queue', sessionId: threadId });
  board.handleHook('working', tile, { session_id: threadId, cwd: session.cwd });
  return true;
}

function notifyUser(changed) {
  const session = board.list().find((item) => item.key === changed.key);
  const labels = { working: 'Working', approval: 'Needs approval', done: 'Finished' };
  const project = session?.project || 'Agent session';
  const messages = {
    working: `This session started in ${project}.`,
    approval: `This session is awaiting approval in ${project}.`,
    done: `The session run is complete in ${project}.`,
  };
  const title = `Signal Box — ${labels[changed.state] || changed.state}`;
  const body = messages[changed.state] || `Signal Box received an update for ${project}.`;

  if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME) {
    const encodedTitle = Buffer.from(xmlEscape(title), 'utf8').toString('base64');
    const encodedBody = Buffer.from(xmlEscape(body), 'utf8').toString('base64');
    const toastScript = `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}'));$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedBody}'));$x=New-Object Windows.Data.Xml.Dom.XmlDocument;$x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>");$n=New-Object Windows.UI.Notifications.ToastNotification($x);[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Signal Box').Show($n)`;
    spawn('powershell.exe', [
      '-NoProfile', '-Command', `${toastScript};[System.Media.SystemSounds]::Asterisk.Play()`,
    ], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
}

function xmlEscape(value) {
  return value.replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character]));
}

function sessionHistoryWithTerminalQuestions(session) {
  const history = sessionHistory(session);
  const terminalQuestion = codexTerminalQuestions.get(session.tile || session.key)?.question;
  if (session.agent === 'codex' && terminalQuestion && !history.pendingQuestions.length) {
    history.pendingQuestions = [terminalQuestion];
  }
  return history;
}

async function dispatchBrowserAction(requestId, sessionId = null, surface = 'desktop') {
  if (!hostStore || !approvalService || !browserBridge) throw new Error('Browser action execution is unavailable.');
  const activeSessionId = sessionId || appSettings.browserSessionId;
  if (!activeSessionId) throw new Error('A browser session ID is required.');
  const bridgeStatus = browserBridge.status(activeSessionId);
  if (!bridgeStatus.connected) throw new Error('Browser extension is not connected. Open https://m.uber.com in the paired Chrome tab, then retry the action.');
  const adapter = new BridgeBrowserAdapter({ bridge: browserBridge, sessionId: activeSessionId, origin: uberCabBooking.origin });
  const executor = new BrowserRecipeExecutor({ browser: adapter });
  const service = new BrowserActionService({ approvals: approvalService, store: hostStore, executor });
  return service.executeApproved(requestId, { executor, principal: 'signal-box-user', surface });
}

function configureModelRouter() {
  const gpuProfile = detectGpuProfile({ wsl: Boolean(process.env.WSL_DISTRO_NAME) });
  const cpuInfo = os.cpus();
  const cpuProfile = { model: cpuInfo[0]?.model || 'Unknown CPU', cores: cpuInfo.length, architecture: process.arch };
  modelHardware = { ...gpuProfile, cpu: cpuProfile, wsl: Boolean(process.env.WSL_DISTRO_NAME) };
  const localProfile = recommendLocalModel({ gpuMemoryBytes: gpuProfile.memoryBytes, cpuCores: cpuProfile.cores, cpuModel: cpuProfile.model, architecture: cpuProfile.architecture });
  const localModel = appSettings.localModel || process.env.SIGNAL_BOX_LOCAL_MODEL || localProfile.model;
  const frontierModel = appSettings.frontierModel || process.env.SIGNAL_BOX_FRONTIER_MODEL || 'gpt-4o-mini';
  const frontierKey = mailCredentials?.load('frontier-api-key') || process.env.SIGNAL_BOX_FRONTIER_API_KEY || '';
  const localClient = new OllamaClient({ model: localModel });
  const frontierClient = frontierKey ? new IsolatedFrontierClient({ model: frontierModel, baseUrl: appSettings.frontierBaseUrl || process.env.SIGNAL_BOX_FRONTIER_BASE_URL || 'https://api.openai.com/v1', apiKey: frontierKey }) : null;
  modelRouter?.frontierClient?.close?.();
  modelRouter = new ModelRouter({ privacyGateway, localClient, frontierClient, mode: appSettings.modelMode || process.env.SIGNAL_BOX_MODEL_MODE || 'local' });
  console.error(`[models] mode=${modelRouter.mode} local=${localModel} (${localProfile.tier}) gpu=${gpuProfile.available ? `${gpuProfile.devices.map((device) => `${device.name}/${Math.round(device.memoryBytes / 1024 ** 3)}GiB`).join(',')}` : 'unavailable'} frontier=${modelRouter.status().frontier}`);
}

function hasPendingApproval(session) {
  if (!session) return false;
  try { return (sessionHistoryWithTerminalQuestions(session).pendingQuestions || []).length > 0; }
  catch (_) { return false; }
}

async function start() {
  appSettings = readSettings(app.getPath('userData'));
  if (!appSettings.browserSessionId) {
    appSettings = { ...appSettings, browserSessionId: `browser-${crypto.randomUUID()}` };
    writeSettings(app.getPath('userData'), appSettings);
  }
  try {
    mailCredentials = new ProtectedCredentialStore({ filename: path.join(app.getPath('userData'), 'mail-credentials.json'), safeStorage });
    console.error(`[mail] protected credential storage ready: ${safeStorage.getSelectedStorageBackend?.() || 'available'}; profile=${path.join(app.getPath('userData'), 'mail-credentials.json')}`);
    let vaultKey = mailCredentials.load('privacy-vault-key');
    if (!vaultKey) { vaultKey = crypto.randomBytes(32).toString('base64'); mailCredentials.save('privacy-vault-key', vaultKey); }
    privacyGateway = new PrivacyGateway({ vault: new EntityVault({ filename: path.join(app.getPath('userData'), 'privacy-vault.json'), key: Buffer.from(vaultKey, 'base64') }), localOnly: true });
    console.error('[privacy] encrypted entity vault ready; remote inference disabled');
  } catch (error) {
    mailCredentials = null;
    privacyGateway = new PrivacyGateway({ localOnly: true });
    console.error(`[mail] protected credential storage unavailable: ${error.message}; backend=${safeStorage.getSelectedStorageBackend?.() || 'unknown'}`);
  }
  configureModelRouter();
  const hookAuth = ensureHookToken();
  browserBridge = new BrowserBridge();
  try { installClaudeHooks({ tokenFile: hookAuth.file }); } catch (error) { console.error(`[hooks] Claude install failed: ${error.message}`); }
  try { installCodexHooks({ tokenFile: hookAuth.file }); } catch (error) { console.error(`[hooks] Codex install failed: ${error.message}`); }
  try {
    hostStore = new SqliteStore({ filename: path.join(app.getPath('userData'), 'signal-box.db') });
    approvalService = new ApprovalService({ store: hostStore });
  } catch (error) {
    hostStore = null;
    console.error(`[store] SQLite unavailable; durable event storage is disabled: ${error.message}`);
  }
  board = new Board({
    storagePath: path.join(app.getPath('userData'), 'sessions.json'),
    historyProvider: sessionHistoryWithTerminalQuestions,
    authToken: hookAuth.token,
    store: hostStore,
    browserBridge,
  });
  if (hostStore) {
    try {
      const imported = hostStore.importSessions([...board.list(), ...board.listArchived()]);
      if (imported.imported) console.error(`[store] imported ${imported.count} legacy session record${imported.count === 1 ? '' : 's'}`);
    } catch (error) {
      console.error(`[store] legacy session import failed: ${error.message}`);
    }
  }
  wireMailSync();
  taskService = hostStore ? new TaskService({ store: hostStore }) : null;
  proactivityService = hostStore ? new ProactivityService({ store: hostStore }) : null;
  conversationService = hostStore ? new ConversationService({ store: hostStore, channel: 'desktop' }) : null;
  if (hostStore && approvalService) followUpWorkflow = new FollowUpWorkflow({ store: hostStore, approvals: approvalService, workflows: new WorkflowService({ store: hostStore }) });
  digestScheduler = hostStore ? new DigestScheduler({
    store: hostStore,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    digestAt: appSettings.digestAt || '08:30',
    cadenceMinutes: [15, 30, 60].includes(Number(appSettings.digestCadenceMinutes)) ? Number(appSettings.digestCadenceMinutes) : 60,
    quietStart: appSettings.quietHoursStart || null,
    quietEnd: appSettings.quietHoursEnd || null,
  }) : null;
  assistantRuntime = hostStore ? new AssistantRuntime({
    store: hostStore,
    intervalMs: 30 * 1000,
    onError: (error) => console.error(`[assistant] runtime tick failed: ${error.message}`),
  }) : null;
  if (assistantRuntime) {
    const scheduleNext = (kind, intervalMs) => assistantRuntime.schedule(kind, {}, Date.now() + intervalMs, `${kind}:${Math.floor((Date.now() + intervalMs) / intervalMs)}`);
    assistantRuntime.register('assistant.sync.gmail', async () => { await runMailSync(); scheduleNext('assistant.sync.gmail', 5 * 60 * 1000); });
    assistantRuntime.register('assistant.sync.calendar', async () => { await runCalendarSync(); scheduleNext('assistant.sync.calendar', 5 * 60 * 1000); });
    assistantRuntime.register('assistant.sync.drive', async () => { await runDriveSync(); scheduleNext('assistant.sync.drive', 10 * 60 * 1000); });
    assistantRuntime.register('assistant.digest', async () => {
      await runScheduledDigest();
      return { completed: true };
    });
    assistantRuntime.schedule('assistant.sync.gmail', {}, Date.now(), `assistant.sync.gmail:${Math.floor(Date.now() / (5 * 60 * 1000))}`);
    assistantRuntime.schedule('assistant.sync.calendar', {}, Date.now(), `assistant.sync.calendar:${Math.floor(Date.now() / (5 * 60 * 1000))}`);
    assistantRuntime.schedule('assistant.sync.drive', {}, Date.now(), `assistant.sync.drive:${Math.floor(Date.now() / (10 * 60 * 1000))}`);
    assistantRuntime.schedule('assistant.digest', {}, Date.now(), `assistant:digest:${Math.floor(Date.now() / 30_000)}`);
  }
  for (const agent of runningAgents()) board.registerExternal(`process:${agent.pid}`, agent.cwd, agent.agent);
  try {
    await board.listen(Number.isInteger(boardPort) && boardPort > 0 && boardPort < 65536 ? boardPort : 4747);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Port ${boardPort} is already in use. Stop the other process or set SIGNAL_BOX_PORT to another port.`);
    }
    throw error;
  }
  telegram = new TelegramControl({
    token: appSettings.telegramEnabled === false ? '' : appSettings.telegramBotToken,
    chatId: appSettings.telegramChatId,
    listSessions: () => board.list(),
    listTasks: () => hostStore?.listTasks() || [],
    updateTask: (taskId, status) => hostStore?.setTaskStatus(taskId, status),
    recordDigestFeedback: (notificationId, useful) => hostStore?.recordNotificationFeedback(notificationId, useful, { channel: 'telegram' }),
    assistantMessage: async (text, externalId = null) => {
      if (!conversationService) throw new Error('Durable conversation storage is unavailable.');
      const conversation = conversationService.open(`telegram:${appSettings.telegramChatId}`);
      conversationService.receive(conversation.conversationId, text, externalId);
      conversationService.respond(conversation.conversationId, 'Message saved. Assistant planning will use it as context.');
      await telegram.send('Message saved. Assistant planning will use it as context.');
    },
    getHistory: sessionHistoryWithTerminalQuestions,
    executeTerminal: executeRemoteTerminal,
    interruptTerminal: interruptRemoteTerminal,
    sendPrompt: sendRemoteAgentPrompt,
    approvalService,
    approveMailReply: (requestId, _principal, surface) => dispatchApprovedReply(requestId, 'signal-box-user', surface),
    approveBrowserAction: async (requestId, sessionId, _principal, surface) => {
      const adapter = new BridgeBrowserAdapter({ bridge: browserBridge, sessionId, origin: uberCabBooking.origin });
      const executor = new BrowserRecipeExecutor({ browser: adapter });
      const service = new BrowserActionService({ approvals: approvalService, store: hostStore, executor });
      return service.executeApproved(requestId, { executor, principal: 'signal-box-user', surface });
    },
    ensureSession: async (tile) => {
      const session = board.sessions.get(tile);
      if (!session || !session.owned) throw new Error('That session is not remotely controllable.');
      await spawnSession(tile, session.cwd, session.agent || 'claude', session.sessionId, true);
      return session;
    },
    writeSession: (tile, data, { approval = false } = {}) => {
      const child = terminals.get(tile);
      if (!child) throw new Error('That terminal is not running.');
      const session = board.sessions.get(tile);
      if ((approval || data.endsWith('\r')) && session?.agent === 'codex') codexTerminalQuestions.delete(tile);
      child.write(data);
      if (!approval && /[\r\n]$/.test(data)) submitDelivery(tile, { channel: 'telegram-pty', sessionId: session.sessionId });
      if (approval && session?.agent !== 'terminal') {
        submitDelivery(tile, { channel: 'approval-pty', sessionId: session.sessionId });
      }
      if (!approval && data.endsWith('\r') && session?.agent !== 'terminal') {
        board.handleHook('working', tile, { cwd: session?.cwd, session_id: session.sessionId });
      }
    },
    markWorking: (session) => {
      if (!session?.owned || session.agent === 'terminal') return;
      board.handleHook('working', session.tile || session.key, { cwd: session.cwd, session_id: session.sessionId });
    }
  });
  board.on('change', (changed) => {
    if (changed?.delivery && ['acknowledged', 'failed', 'unknown'].includes(changed.delivery.status)) clearDeliveryTimer(changed.key);
    const changedSession = changed?.key ? board.list().find((session) => session.key === changed.key) : null;
    const approvalStillPending = hasPendingApproval(changedSession);
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.webContents.send('sessions:changed', { sessions: board.list(), archivedSessions: board.listArchived(), changed });
    }
    if (desktopNotificationsEnabled && changed && changed.state && !changed.navigation) notifyUser(changed);
    // A lifecycle event can arrive while the agent is still waiting for the
    // same question. Keep its Telegram buttons valid until the question is
    // answered, replaced, cancelled, or actually disappears from history.
    if (changed?.state && changed.state !== 'approval' && !approvalStillPending) telegram.clearApproval(changed.key);
    if (changed?.state === 'approval' && !changed.navigation) {
      // notifyState deduplicates identical question signatures, but reissues
      // buttons when a repeated approval contains a new question.
      telegram.notifyState(changedSession, 'approval');
    } else if (changed?.state === 'done' && !changed.navigation && !changed.repeated && !approvalStillPending) {
      telegram.notifyState(changedSession, 'done');
    }
  });
  stopCodexMonitor = startCodexMonitor({
    listSessions: () => board.list(),
    getHistory: sessionHistoryWithTerminalQuestions,
    onApproval: (session) => board.handleHook('approval', session.tile || session.key, {
      session_id: session.sessionId,
      cwd: session.cwd,
    }),
    onQuestionsCleared: (session) => board.completePendingDone(session.tile || session.key),
  });
  livenessTimer = setInterval(() => board.checkLiveness(), 15 * 1000);
  livenessTimer.unref?.();
  wireIpc();
  createWindow();
  if (appSettings.telegramEnabled !== false) telegram.start();
  assistantRuntime?.start();
  for (const session of board.list()) {
    if (session.state === 'approval') telegram.notifyState(session, 'approval');
  }
}

function wireMailSync() {
  mailSync = null;
  if (!hostStore || !mailCredentials) return;
  const refreshToken = mailCredentials.load('gmail-refresh-token');
  const clientId = mailCredentials.load('gmail-client-id');
  const clientSecret = mailCredentials.load('gmail-client-secret');
  const account = mailCredentials.load('gmail-account');
  if (!refreshToken || !clientId || !clientSecret || !account) return;
  const oauth = new GoogleOAuth({ clientId, clientSecret });
  const provider = new GmailProvider({ refreshToken, oauth });
  mailSync = new MailSync({ store: hostStore, provider });
  calendarSync = new MailSync({ store: hostStore, provider: new GoogleCalendarProvider({ refreshToken, oauth }) });
  driveSync = new MailSync({ store: hostStore, provider: new GoogleDriveProvider({ refreshToken, oauth }) });
}

function createGmailProvider() {
  if (!mailCredentials) throw new Error('Protected credential storage is unavailable.');
  const refreshToken = mailCredentials.load('gmail-refresh-token');
  const clientId = mailCredentials.load('gmail-client-id');
  const clientSecret = mailCredentials.load('gmail-client-secret');
  if (!refreshToken || !clientId) throw new Error('Connect Gmail before sending a reply.');
  return new GmailProvider({ refreshToken, oauth: new GoogleOAuth({ clientId, clientSecret: clientSecret || null }) });
}

async function runMailSync() {
  if (!mailSync || !mailCredentials) return { paired: false, provider: 'gmail', reason: 'Gmail sync is not initialized. Reconnect Gmail after the secure credential store is ready.' };
  const account = mailCredentials.load('gmail-account');
  const adapterId = `gmail:${account}`;
  try {
    const result = await mailSync.run({ adapterId, accountAddress: account });
    const tasks = taskService?.processAll(adapterId) || [];
    const syncResult = { ...result, taskCandidates: tasks.length };
    console.error(`[mail] sync complete account=${account} fetched=${syncResult.fetched} inserted=${syncResult.inserted} tasks=${syncResult.taskCandidates}`);
    hostStore.setConnectorHealth(adapterId, 'healthy', syncResult);
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('mail:status-changed', { status: 'healthy', result: syncResult });
    return syncResult;
  } catch (error) {
    hostStore.setConnectorHealth(adapterId, 'error', { message: error.message, code: error.code || null });
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('mail:status-changed', { status: 'error', error: error.message });
    throw error;
  }
}

async function runCalendarSync() {
  if (!calendarSync || !mailCredentials) return { paired: false, provider: 'google-calendar', reason: 'Google Calendar sync is not initialized. Connect Google after the secure credential store is ready.' };
  const account = mailCredentials.load('gmail-account');
  const adapterId = `calendar:${account}`;
  try {
    const result = await calendarSync.run({ adapterId, accountAddress: account });
    const tasks = taskService?.processAll(adapterId) || [];
    const syncResult = { ...result, taskCandidates: tasks.length };
    hostStore.setConnectorHealth(adapterId, 'healthy', syncResult);
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('calendar:status-changed', { status: 'healthy', result: syncResult });
    return syncResult;
  } catch (error) {
    hostStore.setConnectorHealth(adapterId, 'error', { message: error.message, code: error.code || null });
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('calendar:status-changed', { status: 'error', error: error.message });
    throw error;
  }
}

async function runDriveSync() {
  if (!driveSync || !mailCredentials) return { paired: false, provider: 'google-drive', reason: 'Google Drive sync is not initialized. Connect Google after the secure credential store is ready.' };
  const account = mailCredentials.load('gmail-account');
  const adapterId = `drive:${account}`;
  try {
    const result = await driveSync.run({ adapterId, accountAddress: account, boundedWindow: 100 });
    const tasks = taskService?.processAll(adapterId) || [];
    const syncResult = { ...result, taskCandidates: tasks.length };
    hostStore.setConnectorHealth(adapterId, 'healthy', syncResult);
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('drive:status-changed', { status: 'healthy', result: syncResult });
    return syncResult;
  } catch (error) {
    hostStore.setConnectorHealth(adapterId, 'error', { message: error.message, code: error.code || null });
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('drive:status-changed', { status: 'error', error: error.message });
    throw error;
  }
}

async function runScheduledDigest() {
  if (!digestScheduler || !hostStore || !telegram?.enabled || !telegram.configured) return null;
  const tasks = hostStore.listTasks();
  const decisions = proactivityService?.evaluate(tasks) || [];
  const decisionTypes = new Map(decisions.map((decision) => [decision.taskId, decision.type]));
  const actionableTasks = tasks.filter((task) => decisionTypes.get(task.taskId) !== 'wait');
  let modelRanking = null;
  try { modelRanking = await modelRouter?.rank(actionableTasks); } catch (error) { console.error(`[models] ranking unavailable; using deterministic ranking: ${error.message}`); }
  const digest = digestScheduler.prepareScheduled(actionableTasks, modelRanking);
  if (!digest) return null;
  await deliverPendingDigest();
  return digest;
}

async function deliverPendingDigest() {
  if (!hostStore || !telegram?.enabled || !telegram.configured) return null;
  const notification = hostStore.claimNotification('digest');
  if (!notification) return null;
  const lines = notification.items.map((item, index) => `${index + 1}. ${item.summary}${item.reasons?.length ? ` — ${item.reasons.join(', ')}` : ''}`);
  try {
    const feedback = {
      inline_keyboard: [[
        { text: 'Useful', callback_data: telegram.addAction({ type: 'digest-feedback', notificationId: notification.notificationId, useful: true }) },
        { text: 'Not useful', callback_data: telegram.addAction({ type: 'digest-feedback', notificationId: notification.notificationId, useful: false }) },
      ]],
    };
    await telegram.send(`Today\n\n${lines.join('\n')}`, { reply_markup: feedback });
    return hostStore.completeNotification(notification.notificationId, 'sent', { channel: 'telegram' });
  } catch (error) {
    const status = error.name === 'AbortError' || /timeout|network|fetch/i.test(error.message) ? 'unknown' : 'failed';
    hostStore.completeNotification(notification.notificationId, status, { channel: 'telegram', error: error.message });
    throw error;
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstance) return;
  configureUserDataPath();
  await restoreShellPath();
  return start();
}).catch((error) => {
  dialog.showErrorBox('Signal Box could not start', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  stopCodexMonitor?.();
  if (livenessTimer) clearInterval(livenessTimer);
  if (mailSyncTimer) clearInterval(mailSyncTimer);
  if (calendarSyncTimer) clearInterval(calendarSyncTimer);
  if (driveSyncTimer) clearInterval(driveSyncTimer);
  if (digestTimer) clearInterval(digestTimer);
  assistantRuntime?.stop();
  telegram?.stop();
  modelRouter?.frontierClient?.close?.();
  for (const child of remoteCommands.values()) {
    try { child.kill(); } catch (_) { /* Process may already have exited. */ }
  }
  remoteCommands.clear();
  for (const child of terminals.values()) child.kill();
  terminals.clear();
  if (board) await board.closeServer();
  hostStore?.close();
});
