const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { BrowserActionService } = require('../host/browser/service');
const { PolicyEngine } = require('../host/policy/engine');

assert.equal(new PolicyEngine().evaluate({ capability: 'calendar.update' }).requiresApproval, true);

(async () => {
  const store = new SqliteStore();
  const approvals = new ApprovalService({ store });
  let executions = 0;
  const service = new BrowserActionService({
    approvals,
    store,
    executor: { run: async () => { executions += 1; return { status: 'confirmed' }; } },
  });
  const recipe = { id: 'fixture.read.v1', origin: 'https://example.com', effects: 'read', inputs: {}, steps: [{ id: 'read', kind: 'read', target: 'title' }] };
  const request = service.prepare(recipe, {});
  const requestId = request.request_id || request.requestId;
  approvals.decide(requestId, 'allow', { principal: 'signal-box-user', surface: 'desktop' });
  await service.executeApproved(requestId);
  await assert.rejects(() => service.executeApproved(requestId), /already been consumed/);
  assert.equal(executions, 1);
  store.recordNotificationFeedback('digest-1', true, { channel: 'telegram' });
  assert.equal(store.notificationStats().feedback.useful, 1);
  store.close();
  console.log('architecture gap tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
