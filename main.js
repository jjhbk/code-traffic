const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, Notification, screen } = require('electron');
const { Board } = require('./board');
const { runningAgents } = require('./processes');

// WSLg can expose a display while its GPU shared-image path is unavailable.
// Electron's software renderer is reliable for this small board and xterm view.
if (process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || process.env.WAYLAND_DISPLAY)) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

let windowRef;
let board;
let pty;
const terminals = new Map();
const boardPort = Number.parseInt(process.env.SIGNAL_BOX_PORT || '4747', 10);

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
    maxWidth,
    maxHeight,
    backgroundColor: '#10141a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  windowRef.webContents.on('console-message', (_event, detailsOrLevel, message, lineNumber, sourceId) => {
    const details = typeof detailsOrLevel === 'object'
      ? detailsOrLevel
      : { level: detailsOrLevel, message, lineNumber, sourceId };
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
function readWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); } catch (_) { return {}; }
}
function saveWindowState(bounds) {
  try {
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(bounds));
  } catch (_) { /* Window persistence is best effort. */ }
}

function wireIpc() {
  ipcMain.handle('sessions:list', () => board.list());
  ipcMain.handle('session:create', async (_event, { cwd, agent = 'claude' } = {}) => {
    const tile = crypto.randomUUID();
    board.register(tile, cwd, agent);
    await spawnSession(tile, cwd, agent, null);
    return tile;
  });
  ipcMain.handle('session:open', async (_event, { tile } = {}) => {
    const session = board.reopen(tile);
    if (!session) throw new Error('That session is no longer available.');
    await spawnSession(tile, session.cwd, session.agent || 'claude', session.sessionId);
    return true;
  });
  ipcMain.handle('session:close', (_event, { tile } = {}) => {
    const child = terminals.get(tile);
    if (child) {
      child.kill();
      terminals.delete(tile);
    }
    return board.close(tile);
  });
  ipcMain.handle('folder:pick', async () => {
    const result = await dialog.showOpenDialog(windowRef, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.on('pty:write', (_event, { tile, data } = {}) => {
    if (typeof data === 'string') {
      terminals.get(tile)?.write(data);
    }
  });
  ipcMain.on('session:working', (_event, { tile } = {}) => {
    if (tile && terminals.has(tile)) {
      board.handleHook('working', tile, { cwd: board.sessions.get(tile)?.cwd, submitted: true });
    }
  });
  ipcMain.on('pty:resize', (_event, { tile, cols, rows } = {}) => {
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) terminals.get(tile)?.resize(cols, rows);
  });
}

async function spawnSession(tile, cwd, agent, sessionId) {
  if (!pty) throw new Error('Embedded terminals are unavailable because node-pty could not be loaded.');
  if (!cwd || typeof cwd !== 'string') throw new Error('Choose a project folder first.');
  if (terminals.has(tile)) return;
  const binary = findAgent(agent);
  if (!binary) throw new Error(`${agent === 'codex' ? 'Codex CLI' : 'Claude Code'} was not found on PATH. Install it, then restart Signal Box.`);
  const resumableId = sessionId && !(agent === 'codex' && sessionId.startsWith('codex:')) ? sessionId : null;
  const args = resumableId
    ? (agent === 'codex' ? ['resume', resumableId] : ['--resume', resumableId])
    : [];
  const child = pty.spawn(binary, args, {
    name: 'xterm-256color',
    // These are only safe startup values. The renderer immediately resizes
    // the PTY to the actual terminal panel dimensions after it is painted.
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, SIGNAL_TILE: tile, SIGNAL_AGENT: agent },
  });
  terminals.set(tile, child);
  child.onData((data) => {
    if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('pty:data', { tile, data });
  });
  child.onExit(() => terminals.delete(tile));
}

function findAgent(agent) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [agent === 'codex' ? 'codex' : 'claude'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/)[0] || null;
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

async function start() {
  board = new Board({ storagePath: path.join(app.getPath('userData'), 'sessions.json') });
  for (const agent of runningAgents()) board.registerExternal(`process:${agent.pid}`, agent.cwd, agent.agent);
  try {
    await board.listen(Number.isInteger(boardPort) && boardPort > 0 && boardPort < 65536 ? boardPort : 4747);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Port ${boardPort} is already in use. Stop the other process or set SIGNAL_BOX_PORT to another port.`);
    }
    throw error;
  }
  board.on('change', (changed) => {
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.webContents.send('sessions:changed', { sessions: board.list(), changed });
    }
    if (changed && changed.state && !changed.navigation) notifyUser(changed);
  });
  wireIpc();
  createWindow();
}

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox('Signal Box could not start', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  for (const child of terminals.values()) child.kill();
  terminals.clear();
  if (board) await board.closeServer();
});
