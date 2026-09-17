const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ProactivityService } = require('../host/proactivity/service');

(async () => {
  const store = new SqliteStore();
  let calls = 0;
  let clockNow = 100_000;
  const service = new ProactivityService({
    store,
    clock: () => clockNow,
    modelCooldownMs: 1_000,
    modelMaxCalls: 1,
    modelRouter: {
      proposeNextStep: async (task) => {
        calls += 1;
        if (task.taskId === 'follow-up') return { decision: 'draft_follow_up', reason: 'Model found a useful follow-up opportunity.', requiresApproval: true, source: 'fixture-model' };
        throw new Error('model unavailable');
      },
    },
  });
  const decisions = await service.evaluateAsync([
    { taskId: 'follow-up', status: 'active', summary: 'Check in', owner: 'uncertain', blocker: 'uncertain' },
    { taskId: 'deadline', status: 'active', dueDate: 'today' },
    { taskId: 'fallback', status: 'active', summary: 'No trigger' },
  ]);
  assert.equal(decisions[0].type, 'draft_follow_up');
  assert.equal(decisions[0].requiresApproval, true);
  assert.equal(decisions[1].type, 'digest', 'deterministic deadline policy remains authoritative');
  assert.equal(decisions[2].type, 'wait', 'model failure falls back to deterministic waiting');
  assert.equal(calls, 1, 'model budget bounds calls per evaluation');
  const unsafeService = new ProactivityService({
    store,
    modelRouter: { proposeNextStep: async () => ({ decision: 'execute_browser', reason: 'Run a booking now.', requiresApproval: false }) },
  });
  const unsafe = await unsafeService.evaluateAsync([{ taskId: 'unsafe', status: 'active', summary: 'Book a ride' }]);
  assert.equal(unsafe[0].type, 'wait', 'model output cannot authorize an external browser action');
  const cached = await service.evaluateAsync([{ taskId: 'follow-up', status: 'active', summary: 'Check in', owner: 'uncertain', blocker: 'uncertain' }]);
  assert.equal(cached[0].type, 'draft_follow_up');
  assert.equal(calls, 1, 'unchanged tasks use the model decision cooldown cache');
  clockNow += 1_001;
  await service.evaluateAsync([{ taskId: 'follow-up', status: 'active', summary: 'Check in', owner: 'uncertain', blocker: 'uncertain' }]);
  assert.equal(calls, 2, 'expired cooldown permits a fresh model proposal');
  store.close();
  console.log('proactivity model tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
