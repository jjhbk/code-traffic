const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { BrowserActionService } = require('../host/browser/service');
const { uberCabBooking } = require('../host/browser/recipes');

(async () => {
  const store = new SqliteStore({ clock: () => 1000 });
  const approvals = new ApprovalService({ store, clock: () => 1000 });
  const executor = { run: async (_recipe, _inputs, { approve }) => { assert.equal(await approve(), true); return { status: 'confirmed', recipeId: uberCabBooking.id }; } };
  const service = new BrowserActionService({ approvals, executor, store, clock: () => 1000 });
  const request = service.prepare(uberCabBooking, { pickup: 'Home', destination: 'Airport', rideType: 'UberX', maxFare: 40 });
  const requestId = request.request_id || request.requestId;
  assert.equal(store.getApproval(requestId).status, 'pending');
  approvals.decide(requestId, 'allow', { principal: 'signal-box-user', surface: 'desktop' });
  const result = await service.executeApproved(requestId, { executor });
  assert.equal(result.receipt.status, 'confirmed');
  assert.equal(store.getExecutionAttempt(result.attemptId).status, 'confirmed');
  assert.equal(store.getDecision(requestId).optionId, 'allow');
  store.close();
  console.log('browser action service tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
