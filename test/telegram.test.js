const assert = require('assert');
const { TelegramControl, parseCommand, sessionListText } = require('../telegram');

assert.deepStrictEqual(parseCommand('/use@signal_bot 2'), { name: 'use', argument: '2' });
assert.deepStrictEqual(parseCommand('run the tests'), { name: 'send', argument: 'run the tests' });

const sessions = [
  { key: 'one', tile: 'one', project: 'alpha', agent: 'claude', state: 'working', owned: true },
  { key: 'two', project: 'beta', agent: 'codex', state: 'done', owned: false },
  { key: 'three', tile: 'three', project: 'utilities', agent: 'terminal', state: null, owned: true },
  { key: 'four', tile: 'four', project: 'gamma', agent: 'codex', state: null, owned: true },
];
assert.match(sessionListText(sessions, 'one'), /alpha.*selected/);
assert.match(sessionListText(sessions, 'one'), /beta.*view only/);
assert.match(sessionListText(sessions, 'one'), /utilities · Terminal/);

(async () => {
  const sent = [];
  const writes = [];
  const ensured = [];
  const queuedPrompts = [];
  const control = new TelegramControl({
    token: 'test-token',
    chatId: '42',
    listSessions: () => sessions,
    getHistory: () => ({
      count: 1,
      pairs: [{ prompt: 'run the tests', output: 'Tests passed.' }],
      pendingQuestions: [{
        header: 'Runtime',
        question: 'Which runtime should be used?',
        options: [
          { label: 'Hybrid', description: 'Use local and remote workers.' },
          { label: 'Local', description: 'Stay on this machine.' },
        ],
      }],
    }),
    ensureSession: async (tile) => ensured.push(tile),
    writeSession: (tile, data) => writes.push({ tile, data }),
    executeTerminal: async (_session, command) => ({ output: `/workspace\nreceived: ${command}`, code: 0, signal: null, truncated: false }),
    interruptTerminal: () => true,
    sendPrompt: async (session, prompt) => queuedPrompts.push({ tile: session.tile, prompt }),
    submitDelayMs: 0,
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
  });
  control.stopped = false;

  await control.handleUpdate({ message: { chat: { id: 7 }, text: '/sessions' } });
  assert.strictEqual(sent.length, 0);

  await control.handleUpdate({ message: { chat: { id: 7 }, text: '/start' } });
  assert.strictEqual(sent[0].chat_id, '7');
  assert.match(sent[0].text, /TELEGRAM_CHAT_ID=7/);

  await control.handleUpdate({ message: { chat: { id: 42 }, text: '/use 1' } });
  await control.handleUpdate({ message: { chat: { id: 42 }, text: 'run the tests' } });
  assert.deepStrictEqual(ensured, ['one']);
  assert.deepStrictEqual(writes, [
    { tile: 'one', data: 'run the tests' },
    { tile: 'one', data: '\r' },
  ]);
  assert.match(sent.at(-1).text, /Prompt sent to alpha/);

  await control.handleUpdate({ message: { chat: { id: 42 }, text: '/use 2' } });
  assert.match(sent.at(-1).text, /external/i);

  await control.handleUpdate({ message: { chat: { id: 42 }, text: '/use 4' } });
  await control.handleUpdate({ message: { chat: { id: 42 }, text: 'run codex' } });
  assert.deepStrictEqual(queuedPrompts, [{ tile: 'four', prompt: 'run codex' }]);
  assert.deepStrictEqual(writes, [
    { tile: 'one', data: 'run the tests' },
    { tile: 'one', data: '\r' },
  ]);
  assert.match(sent.at(-1).text, /Prompt sent to gamma/);

  await control.handleUpdate({ message: { chat: { id: 42 }, text: '/use 3' } });
  await control.handleUpdate({ message: { chat: { id: 42 }, text: 'pwd' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(writes, [
    { tile: 'one', data: 'run the tests' },
    { tile: 'one', data: '\r' },
  ]);
  assert.match(sent.at(-1).text, /^\$ pwd/);
  assert.match(sent.at(-1).text, /received: pwd/);

  await control.handleUpdate({ message: { chat: { id: 42 }, text: '/tail' } });
  assert.match(sent.at(-1).text, /Input:\nrun the tests/);
  assert.match(sent.at(-1).text, /Output:\nTests passed\./);

  control.notifyState(sessions[0], 'done');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent.at(-1).text, /Latest input\/output/);
  assert.match(sent.at(-1).text, /Output:\nTests passed\./);

  control.notifyState(sessions[0], 'approval');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent.at(-1).text, /needs user input or permission/);
  assert.match(sent.at(-1).text, /Which runtime should be used\?/);
  assert.match(sent.at(-1).text, /Hybrid — Use local and remote workers\./);
  const callbackData = sent.at(-1).reply_markup.inline_keyboard[1][0].callback_data;
  await control.handleUpdate({
    callback_query: {
      id: 'callback-1',
      data: callbackData,
      message: { chat: { id: 42 } },
    },
  });
  assert.deepStrictEqual(ensured, ['one', 'one']);
  assert.deepStrictEqual(writes.at(-1), { tile: 'one', data: '\x1b[B\r' });
  assert.strictEqual(sent.at(-1).callback_query_id, 'callback-1');
  assert.match(sent.at(-1).text, /Sent: Local/);
  control.stop();

  const pairingMessages = [];
  const pairing = new TelegramControl({
    token: 'test-token',
    chatId: '',
    listSessions: () => [],
    getHistory: () => ({ count: 0, pairs: [] }),
    ensureSession: async () => {},
    writeSession: () => {},
    fetchImpl: async (_url, options) => {
      pairingMessages.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
  });
  pairing.stopped = false;
  await pairing.handleUpdate({ message: { chat: { id: 8675309 }, text: '/start' } });
  assert.strictEqual(pairingMessages[0].chat_id, '8675309');
  assert.match(pairingMessages[0].text, /TELEGRAM_CHAT_ID=8675309/);
  pairing.stop();
  console.log('telegram tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
