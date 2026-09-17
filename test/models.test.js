const assert = require('node:assert/strict');
const { EntityVault, PrivacyGateway } = require('../host/privacy/gateway');
const { ModelRouter, validateRanking, validateNextStep, validateDraftReply, validateObligations } = require('../host/models/router');
const { OllamaClient, OpenAICompatibleClient } = require('../host/models/clients');
const { IsolatedFrontierClient } = require('../host/models/frontier-gateway');

const tasks = [{ taskId: 'task-1', summary: 'Reply to alice@example.com', owner: 'self', blocker: 'counterparty', counterparty: 'alice@example.com', dueDate: 'friday', confidence: 'medium' }, { taskId: 'task-2', summary: 'Read notes', owner: 'self' }];
let captured;
const local = new OllamaClient({ fetchImpl: async (_url, options) => {
  if (_url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen3:4b-instruct' }] }) };
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
  assert.throws(() => validateNextStep({ decision: 'draft_follow_up', reason: 'send it', requiresApproval: false }), /requires approval/);
  assert.equal(validateDraftReply({ subject: 'Re: Handoff', body: 'Checking in.' }).subject, 'Re: Handoff');
  const planner = new ModelRouter({
    privacyGateway: new PrivacyGateway({ vault: new EntityVault() }),
    localClient: { complete: async ({ schema, prompt }) => {
      if (schema.required.includes('entities')) return { entities: [] };
      assert.equal(schema.required.includes('decision'), true);
      assert.doesNotMatch(prompt, /alice@example.com/);
      return { decision: 'draft_follow_up', reason: 'The counterparty is blocking progress.', requiresApproval: true };
    } },
    mode: 'local',
  });
  const plan = await planner.proposeNextStep(tasks[0], [{ sourceId: 'mail-1', summary: 'Reply to alice@example.com', status: 'active' }]);
  assert.equal(plan.decision, 'draft_follow_up');
  assert.equal(planner.diagnostics().metrics.lastDecision.status, 'ok');
  const source = 'Launch\nI will send the contract by Friday.';
  const structured = new ModelRouter({
    privacyGateway: new PrivacyGateway({ vault: new EntityVault() }),
    localClient: { complete: async ({ schema }) => {
      assert.equal(schema.required.includes('obligations'), true);
      return { obligations: [{ summary: 'Send the contract', owner: 'self', blocker: 'counterparty', counterparty: 'client@example.com', dueDate: 'friday', dueDateBasis: 'message-text', confidence: 'high', evidenceText: 'I will send the contract by Friday.', evidenceStart: 7, evidenceEnd: source.length }] };
    } },
    mode: 'local',
  });
  const extracted = await structured.extractObligations({ subject: 'Launch', body: 'I will send the contract by Friday.', direction: 'outgoing' });
  assert.equal(extracted.obligations.length, 1);
  assert.deepEqual(validateObligations({ obligations: [{ summary: 'bad', owner: 'self', blocker: 'self', confidence: 'high', evidenceText: 'not present', evidenceStart: 0, evidenceEnd: 11 }] }, source).obligations, []);
  const frontier = new OpenAICompatibleClient({ model: 'frontier-test', apiKey: 'secret', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"items":[]}' } }] }) };
  } });
  const frontierRouter = new ModelRouter({ privacyGateway: new PrivacyGateway(), localClient: { available: async () => true, complete: async ({ system }) => system.includes('named entities') ? { entities: [] } : { items: [] } }, frontierClient: frontier, mode: 'frontier' });
  assert.equal((await frontierRouter.rank(tasks)).source, 'frontier');
  const entities = await router.recognizeEntities('Meet Priya at Acme Labs.');
  assert.deepEqual(entities, []);
  const availability = await new ModelRouter({ privacyGateway: new PrivacyGateway(), localClient: new OllamaClient({ model: 'missing', fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) }), mode: 'local' }).availability();
  assert.equal(availability.localAvailable, false);
  const unavailable = await new ModelRouter({ privacyGateway: new PrivacyGateway(), localClient: new OllamaClient({ model: 'missing', fetchImpl: async () => { throw new Error('connection refused'); } }), mode: 'local' }).availability();
  assert.equal(unavailable.localAvailable, false);
  assert.equal(unavailable.localError, 'ollama-unreachable');
  const probeRouter = new ModelRouter({
    privacyGateway: new PrivacyGateway(),
    localClient: {
      model: 'probe-model',
      complete: async ({ system, prompt }) => system.includes('named entities')
        ? { entities: [{ type: 'person', value: 'Morgan', start: prompt.indexOf('Morgan'), end: prompt.indexOf('Morgan') + 6 }] }
        : { items: [] },
    },
    mode: 'local',
  });
  const probe = await probeRouter.probe();
  assert.equal(probe.localCall, true);
  assert.equal(probe.redacted, true);
  assert.doesNotMatch(probe.sample, /Morgan|diagnostic\.person@example\.com/);
  assert.equal(probeRouter.diagnostics().metrics.lastPrivacyCheck.redacted, true);
  const blockedFrontier = new ModelRouter({ privacyGateway: new PrivacyGateway(), localClient: { available: async () => false }, frontierClient: frontier, mode: 'frontier' });
  assert.equal((await blockedFrontier.rank(tasks)).reason, 'local-privacy-model-unavailable');
  assert.equal(new ModelRouter({ privacyGateway: new PrivacyGateway(), mode: 'frontier' }).status().active, false);
  const child = { connected: true, killed: false, on(event, handler) { if (event === 'message') this.message = handler; if (event === 'exit') this.exit = handler; }, send(message) { this.message({ id: message.id, result: { items: [] } }); }, kill() { this.killed = true; } };
  const isolated = new IsolatedFrontierClient({ model: 'frontier-test', apiKey: 'secret', forkImpl: () => child });
  assert.deepEqual(await isolated.complete({ prompt: 'safe' }), { items: [] });
  isolated.close();
  console.log('model routing tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
