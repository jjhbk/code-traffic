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

  await control.handleUpdate({ message: { chat: { id: 42 }, text: '/sessions' } });
  assert.match(sent.at(-1).text, /Tap a session below/);
  const sessionButton = sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  const externalSessionButton = sent.at(-1).reply_markup.inline_keyboard[1][0].callback_data;
  await control.handleUpdate({ callback_query: { id: 'select-1', data: sessionButton, message: { chat: { id: 42 } } } });
  assert.match(sent.at(-1).text, /Selected alpha/);
  const historyButton = sent.at(-1).reply_markup.inline_keyboard[0][1].callback_data;
  await control.handleUpdate({ callback_query: { id: 'history-1', data: historyButton, message: { chat: { id: 42 } } } });
  assert.match(sent.at(-1).text, /Input:\nrun the tests/);

  await control.handleUpdate({ callback_query: { id: 'select-external', data: externalSessionButton, message: { chat: { id: 42 } } } });
  assert.match(sent.at(-1).text, /view only/i);
  await control.handleUpdate({ message: { chat: { id: 42 }, text: '/send should-not-run' } });
  assert.deepStrictEqual(queuedPrompts, []);
  assert.match(sent.at(-1).text, /view only/i);

  await control.handleUpdate({ message: { chat: { id: 7 }, text: '/start' } });
  assert.strictEqual(sent.at(-1).chat_id, '7');
  assert.match(sent.at(-1).text, /TELEGRAM_CHAT_ID=7/);

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
  const approvalMessage = sent.at(-1).text;
  control.notifyState(sessions[0], 'approval');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sent.at(-1).text, approvalMessage);
  const callbackData = sent.at(-1).reply_markup.inline_keyboard[1][0].callback_data;
  await control.handleUpdate({
    callback_query: {
      id: 'callback-1',
      data: callbackData,
      message: { message_id: 99, text: approvalMessage, chat: { id: 42 } },
    },
  });
  assert.deepStrictEqual(ensured, ['one', 'one']);
  assert.deepStrictEqual(writes.at(-1), { tile: 'one', data: '\x1b[B\r' });
  const callbackAnswer = sent.find((message) => message.callback_query_id === 'callback-1');
  assert.match(callbackAnswer.text, /Sent: Local/);
  assert.strictEqual(sent.at(-1).message_id, 99);
  assert.match(sent.at(-1).text, /Response sent: Local/);
  assert.ok(!sent.at(-1).reply_markup);
  const sentAfterAnswer = sent.length;
  control.notifyState(sessions[0], 'approval');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sent.length, sentAfterAnswer);
  control.stop();

  const approvalMessages = [];
  const approvalWrites = [];
  const twoQuestionControl = new TelegramControl({
    token: 'test-token',
    chatId: '42',
    listSessions: () => [sessions[0]],
    getHistory: () => ({
      pendingQuestions: [
        { question: 'Choose a runtime.', options: [{ label: 'Node' }, { label: 'Deno' }] },
        { question: 'Choose a region.', options: [{ label: 'India' }, { label: 'Europe' }] },
      ],
    }),
    ensureSession: async () => {},
    writeSession: (_tile, keys) => approvalWrites.push(keys),
    fetchImpl: async (_url, options) => {
      approvalMessages.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
  });
  twoQuestionControl.stopped = false;
  twoQuestionControl.notifyState(sessions[0], 'approval');
  await new Promise((resolve) => setImmediate(resolve));
  const twoQuestionMessage = approvalMessages.at(-1);
  assert.strictEqual(twoQuestionMessage.reply_markup.inline_keyboard.length, 2);
  const firstQuestion = twoQuestionMessage.reply_markup.inline_keyboard[0][0].callback_data;
  await twoQuestionControl.handleUpdate({ callback_query: {
    id: 'first-question', data: firstQuestion,
    message: { message_id: 11, text: twoQuestionMessage.text, reply_markup: twoQuestionMessage.reply_markup, chat: { id: 42 } },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(approvalWrites, ['\r']);
  const secondQuestionMessage = approvalMessages.at(-1);
  assert.strictEqual(secondQuestionMessage.reply_markup.inline_keyboard.length, 2);
  assert.match(secondQuestionMessage.reply_markup.inline_keyboard[0][0].text, /^2\. /);
  const secondQuestion = secondQuestionMessage.reply_markup.inline_keyboard[0][0].callback_data;
  await twoQuestionControl.handleUpdate({ callback_query: {
    id: 'second-question', data: secondQuestion,
    message: { message_id: 12, text: secondQuestionMessage.text, reply_markup: secondQuestionMessage.reply_markup, chat: { id: 42 } },
  } });
  assert.deepStrictEqual(approvalWrites, ['\r', '\r']);
  twoQuestionControl.stop();

  let failedApprovalSends = 0;
  const retryControl = new TelegramControl({
    token: 'test-token', chatId: '42', listSessions: () => [{ ...sessions[0], state: 'approval' }],
    getHistory: () => ({ pendingQuestions: [{ question: 'Retry?', options: [{ label: 'Yes' }] }] }),
    ensureSession: async () => {}, writeSession: () => {}, approvalRetryMs: 0,
    fetchImpl: async () => {
      failedApprovalSends += 1;
      return failedApprovalSends === 1
        ? { ok: false, status: 502, json: async () => ({ ok: false, description: 'Temporary failure' }) }
        : { ok: true, json: async () => ({ ok: true, result: {} }) };
    },
  });
  retryControl.stopped = false;
  retryControl.notifyState(sessions[0], 'approval');
  retryControl.notifyState(sessions[0], 'approval');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(failedApprovalSends, 2);
  retryControl.stop();

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
