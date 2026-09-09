const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { TelegramControl } = require('../telegram');
const root = path.resolve(__dirname, '..');

async function approvals() {
  const session = { tile: 'one', owned: true };
  let questions = [{ question: 'Old question?', options: [{ label: 'Yes' }] }];
  const writes = [];
  const control = new TelegramControl({
    token: 'test', chatId: '42', listSessions: () => [session],
    getHistory: () => ({ pendingQuestions: questions }), ensureSession: async () => {},
    writeSession: (...args) => writes.push(args),
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) }),
  });
  control.stopped = false;
  const action = () => control.addAction({ type: 'answer', tile: 'one', questionSignature: JSON.stringify(questions[0]), keys: 'y\r', label: 'Yes' });
  const click = (data) => control.handleCallback({ id: 'click', data, message: { chat: { id: 42 } } });
  const cleared = action();
  control.clearApproval('one');
  await click(cleared);
  const stale = action();
  questions = [{ question: 'Different question?' }];
  await click(stale);
  const raced = action();
  control.ensureSession = async () => control.clearApproval('one');
  await click(raced);
  assert.equal(writes.length, 0, 'expired and raced approvals must not reach the terminal');
  control.stop();
}

function hooks() {
  let settings = JSON.stringify({ theme: 'original', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'custom-hook' }] }] } });
  const fakeFs = { existsSync: () => true, mkdirSync: () => {}, readFileSync: () => settings, writeFileSync: (_p, data) => { settings = data; } };
  const context = { require: n => n === 'fs' ? fakeFs : require(n), module: { exports: {} }, process: { env: {} }, console };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'hooks.js'), 'utf8') + '\ninstall(); install();', context);
  let parsed = JSON.parse(settings);
  assert.equal(parsed.hooks.Stop.length, 2, 'preserve custom hooks and avoid duplicate installations');
  parsed.theme = 'new'; settings = JSON.stringify(parsed);
  vm.runInNewContext('uninstall();', context);
  parsed = JSON.parse(settings);
  assert.equal(parsed.theme, 'new');
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'custom-hook');

  let config = 'model = "new-model"\nnotify = ["node", "codex-notify.js"]\n';
  vm.runInNewContext(fs.readFileSync(path.join(root, 'codex-hooks.js'), 'utf8'), {
    require: n => n === 'fs' ? { ...fakeFs, readFileSync: () => config, writeFileSync: (_p, data) => { config = data; } } : require(n),
    process: { env: {}, argv: ['node', 'codex-hooks.js', '--uninstall'] }, console,
  });
  assert.equal(config, 'model = "new-model"\n');
}

async function launchRace() {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const functionSource = source.slice(source.indexOf('async function spawnSession('), source.indexOf('\nfunction findAgent('));
  let release;
  let spawned = 0;
  const board = { sessions: new Map([['tile', {}]]) };
  const context = {
    board, terminals: new Map(), SESSION_TYPES: new Set(['codex']), process: { env: {} },
    pty: { spawn: () => { spawned++; throw new Error('Unexpected spawn'); } },
    findAgent: () => '/bin/codex', sessionArgs: () => [],
    checkCodexSandbox: () => new Promise(resolve => { release = resolve; }),
  };
  vm.runInNewContext(functionSource, context);
  const starting = context.spawnSession('tile', '/project', 'codex', null, false);
  board.sessions.delete('tile');
  release();
  await assert.rejects(starting, /closed during startup/);
  assert.equal(spawned, 0);

  const handlers = new Map();
  const records = new Map();
  const creationContext = {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: () => {} },
    SESSION_TYPES: new Set(['codex']), crypto: { randomUUID: () => 'failed-tile' },
    board: { register: tile => records.set(tile, {}), close: tile => records.delete(tile) },
    spawnSession: async () => { throw new Error('Sandbox failed'); },
  };
  vm.runInNewContext(source.slice(source.indexOf('function wireIpc()'), source.indexOf('async function spawnSession(')), creationContext);
  creationContext.wireIpc();
  await assert.rejects(handlers.get('session:create')(null, { cwd: '/project', agent: 'codex' }), /Sandbox failed/);
  assert.equal(records.size, 0, 'failed launches must remove their newly registered tile');
}

function historyCache() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-audit-'));
  const oldHome = process.env.CODEX_HOME;
  const originalRead = fs.readFileSync;
  try {
    process.env.CODEX_HOME = directory;
    fs.mkdirSync(path.join(directory, 'sessions'));
    const file = path.join(directory, 'sessions', 'thread.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'audit-thread', cwd: '/project' } }) + '\n');
    const { sessionHistory } = require('../history');
    const session = { agent: 'codex', sessionId: 'audit-thread', cwd: '/project' };
    let reads = 0;
    fs.readFileSync = function (p, ...args) { if (p === file) reads++; return originalRead.call(this, p, ...args); };
    sessionHistory(session);
    const initial = reads;
    sessionHistory(session);
    assert.equal(reads, initial, 'unchanged history must not be reread');
    fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'New prompt' } }) + '\n');
    assert.equal(sessionHistory(session).count, 1, 'appended messages invalidate cache');
    assert.ok(reads > initial);
  } finally {
    fs.readFileSync = originalRead;
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    fs.rmSync(directory, { recursive: true });
  }
}

async function httpLimits() {
  const { Board } = require('../board');
  const http = require('http');
  const board = new Board();
  await board.listen(0);
  const port = board.server.address().port;
  const request = (url, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
  try {
    assert.equal(await request('http://[', ''), 400);
    assert.equal(await request('/hook?state=working&tile=oversized', 'x'.repeat(1024 * 1024 + 1)), 413);
    assert.equal(board.sessions.has('oversized'), false);
    assert.equal(await request('/hook?state=working&tile=valid', '{}'), 200);
    assert.equal(board.sessions.has('valid'), true);
  } finally { await board.closeServer(); }
}

(async () => {
  await approvals(); hooks(); await launchRace(); historyCache(); await httpLimits();
  console.log('audit regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
