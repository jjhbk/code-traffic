const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { BrowserActionService } = require('../host/browser/service');
const { BrowserRecipeExecutor } = require('../host/browser/executor');
const { BridgeBrowserAdapter } = require('../host/browser/bridge-adapter');
const { BrowserBridge } = require('../host/browser/bridge');
const { PolicyEngine } = require('../host/policy/engine');
const { uberCabBooking } = require('../host/browser/recipes');

async function completeWithFixture(bridge, sessionId, run, { failStep = null } = {}) {
  let finished = false;
  const result = run.then((value) => { finished = true; return { value, error: null }; }, (error) => { finished = true; return { value: null, error }; });
  for (let attempt = 0; attempt < 100 && !finished; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const request = bridge.next({ sessionId });
    if (!request) continue;
    if (request.step.id === failStep) bridge.complete({ requestId: request.requestId, sessionId, origin: request.origin, error: 'Controlled page reported selector drift.' });
    else bridge.complete({ requestId: request.requestId, sessionId, origin: request.origin, result: request.step.id === 'quote' ? '$24' : { ok: true } });
  }
  assert.equal(finished, true, 'controlled browser fixture did not complete');
  const outcome = await result;
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

(async () => {
  const store = new SqliteStore({ clock: () => 1000 });
  const approvals = new ApprovalService({ store, clock: () => 1000 });
  const bridge = new BrowserBridge({ clock: () => 1000, ttlMs: 60_000 });
  const sessionId = 'browser-fixture-session';
  const adapter = new BridgeBrowserAdapter({ bridge, sessionId, origin: uberCabBooking.origin });
  const executor = new BrowserRecipeExecutor({ browser: adapter, policy: new PolicyEngine(), clock: () => 1000 });
  const service = new BrowserActionService({ approvals, executor, store, clock: () => 1000 });

  const request = service.prepare(uberCabBooking, { pickup: 'Home', destination: 'Airport', rideType: 'UberX', maxFare: 40 }, { sessionId });
  const requestId = request.request_id || request.requestId;
  approvals.decide(requestId, 'allow', { principal: 'signal-box-user', surface: 'desktop' });
  const result = await completeWithFixture(bridge, sessionId, service.executeApproved(requestId, { executor }));
  assert.equal(result.receipt.status, 'confirmed');
  assert.equal(store.getExecutionAttempt(result.attemptId).status, 'confirmed');
  assert.equal(store.getReceipt(result.receiptId).receipt.requestId, requestId);

  const failedRequest = service.prepare(uberCabBooking, { pickup: 'Home', destination: 'Airport', rideType: 'UberX', maxFare: 40 }, { sessionId });
  const failedId = failedRequest.request_id || failedRequest.requestId;
  approvals.decide(failedId, 'allow', { principal: 'signal-box-user', surface: 'desktop' });
  await assert.rejects(() => completeWithFixture(bridge, sessionId, service.executeApproved(failedId, { executor }), { failStep: 'destination' }), /selector drift/);
  assert.equal(store.getExecutionAttempts(failedId).at(-1).status, 'failed');
  const uncertainRequest = service.prepare(uberCabBooking, { pickup: 'Home', destination: 'Airport', rideType: 'UberX', maxFare: 40 }, { sessionId });
  const uncertainId = uncertainRequest.request_id || uncertainRequest.requestId;
  approvals.decide(uncertainId, 'allow', { principal: 'signal-box-user', surface: 'desktop' });
  await assert.rejects(() => completeWithFixture(bridge, sessionId, service.executeApproved(uncertainId, { executor }), { failStep: 'request' }), /selector drift/);
  const uncertainAttempt = store.getExecutionAttempts(uncertainId).at(-1);
  assert.equal(uncertainAttempt.status, 'unknown');
  assert.deepEqual(uncertainAttempt.details.checkpoint, {
    recipeId: uberCabBooking.id,
    commitStarted: true,
    commitStepId: 'request',
    completedStepIds: ['open', 'pickup', 'destination', 'ride', 'quote', 'fare-check'],
  });
  store.close();
  console.log('browser end-to-end fixture tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
