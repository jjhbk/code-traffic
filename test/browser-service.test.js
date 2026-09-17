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
  const uncertain = service.prepare(uberCabBooking, { pickup: 'Home', destination: 'Airport', rideType: 'UberX', maxFare: 40 });
  const uncertainId = uncertain.request_id || uncertain.requestId;
  approvals.decide(uncertainId, 'allow', { principal: 'signal-box-user', surface: 'desktop' });
  await assert.rejects(() => service.executeApproved(uncertainId, {
    executor: { run: async () => { const error = new Error('network timeout after request'); error.outcomeStatus = 'unknown'; throw error; } },
  }), /network timeout/);
  assert.equal(store.getExecutionAttempts(uncertainId)[0].status, 'unknown');
  const grant = approvals.createStandingGrant({ capability: 'browser.commit' }, { principal: 'signal-box-user', surface: 'desktop', constraints: { recipeId: uberCabBooking.id }, expiresAt: Date.now() + 60_000 });
  const inFlight = await service.executeWithStandingGrant(uberCabBooking, { pickup: 'Home', destination: 'Airport', rideType: 'UberX', maxFare: 40 }, { grantId: grant.grantId, workflowId: 'missing-workflow', executor: { run: async () => ({ status: 'confirmed' }) } });
  const recoveryJob = store.exportData().data.jobs.find((job) => job.kind === 'assistant.recover-browser-run' && JSON.parse(job.payload_json).runId === inFlight.runId);
  assert.ok(recoveryJob, 'browser authorization persists a recovery job');
  const recovered = await service.recoverInFlightRun(inFlight.runId);
  assert.equal(recovered.status, 'confirmed', 'completed browser runs are not downgraded during recovery');
  store.close();
  console.log('browser action service tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
