const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ProactivityService } = require('../host/proactivity/service');

(async () => {
  const store = new SqliteStore();
  let calls = 0;
  const service = new ProactivityService({
    store,
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
  assert.equal(calls, 2, 'model is only called for deterministic no-trigger tasks');
  store.close();
  console.log('proactivity model tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
