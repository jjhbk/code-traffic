const assert = require('node:assert/strict');
const { EntityVault, PrivacyGateway } = require('../host/privacy/gateway');
const { ModelRouter, validateRanking } = require('../host/models/router');
const { OllamaClient, OpenAICompatibleClient } = require('../host/models/clients');

const tasks = [{ taskId: 'task-1', summary: 'Reply to alice@example.com', owner: 'self', blocker: 'counterparty', counterparty: 'alice@example.com', dueDate: 'friday', confidence: 'medium' }, { taskId: 'task-2', summary: 'Read notes', owner: 'self' }];
let captured;
const local = new OllamaClient({ fetchImpl: async (_url, options) => {
  captured = JSON.parse(options.body);
  return { ok: true, json: async () => ({ message: { content: JSON.stringify({ items: [{ taskId: 'task-1', score: 0.91, reason: 'you owe this and it is due Friday' }] }) } }) };
} });
const router = new ModelRouter({ privacyGateway: new PrivacyGateway({ vault: new EntityVault() }), localClient: local, mode: 'local' });
(async () => {
  const result = await router.rank(tasks);
  assert.equal(result.source, 'local');
  assert.equal(result.items[0].taskId, 'task-1');
  assert.doesNotMatch(captured.messages[1].content, /alice@example.com/);
  assert.equal(validateRanking({ items: [{ taskId: 'unknown', score: 1, reason: 'bad' }, { taskId: 'task-2', score: 2, reason: 'bad' }] }, tasks).length, 0);
  const frontier = new OpenAICompatibleClient({ model: 'frontier-test', apiKey: 'secret', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"items":[]}' } }] }) };
  } });
  const frontierRouter = new ModelRouter({ privacyGateway: new PrivacyGateway(), frontierClient: frontier, mode: 'frontier' });
  assert.equal((await frontierRouter.rank(tasks)).source, 'frontier');
  assert.equal(new ModelRouter({ privacyGateway: new PrivacyGateway(), mode: 'frontier' }).status().active, false);
  console.log('model routing tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
