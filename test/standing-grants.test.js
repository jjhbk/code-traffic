const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { BrowserActionService } = require('../host/browser/service');
const { ProviderAutonomousActionService } = require('../host/actions/provider-autonomous-service');

(async () => {
  const store = new SqliteStore();
  const approvals = new ApprovalService({ store });
  let executions = 0;
  const service = new BrowserActionService({
    approvals,
    store,
    executor: { run: async () => { executions += 1; return { status: 'confirmed', provider: 'fixture' }; } },
  });
  const recipe = { id: 'fixture.auto-read.v1', origin: 'https://example.com', effects: 'read', inputs: {}, steps: [{ id: 'read', kind: 'read', target: 'title' }] };
  const grant = approvals.createStandingGrant({ capability: 'browser.read', effects: 'read' }, {
    principal: 'signal-box-user',
    surface: 'desktop',
    constraints: { recipeId: recipe.id, origin: recipe.origin },
    expiresAt: Date.now() + 60_000,
    maxUses: 1,
  });
  const mailGrant = approvals.createStandingGrant({ capability: 'gmail.send' }, {
    principal: 'signal-box-user',
    surface: 'desktop',
    constraints: { threadId: 'thread-provider' },
    expiresAt: Date.now() + 60_000,
  });
  let sent = 0;
  const providerService = new ProviderAutonomousActionService({ store, approvals, providers: {
    gmail: () => ({ sendReply: async (payload) => { sent += 1; assert.equal(payload.signalBoxAttemptId.length > 0, true); return { id: 'message-provider', threadId: payload.threadId }; }, reconcileReply: async () => ({ found: true, messageId: 'message-provider', threadId: 'thread-provider' }) }),
  } });
  const providerRun = await providerService.executeWithStandingGrant({ capability: 'gmail.send', destination: 'alex@example.com', threadId: 'thread-provider', content: { subject: 'Re: Handoff', body: 'Checking in.' } }, { grantId: mailGrant.grantId });
  assert.equal(providerRun.receipt.status, 'confirmed');
  assert.equal(store.getAutonomousRun(providerRun.runId).status, 'confirmed');
  assert.equal(sent, 1);
  const providerTask = store.saveTaskCandidate({ candidateId: 'provider-freshness-task', observationId: 'provider-freshness-observation', summary: 'Send fresh update', evidence: { start: 0, end: 1, text: 'Send fresh update' }, extractorVersion: 'test' });
  const providerTaskVersion = store.listTasks({ includeDismissed: true }).find((task) => task.taskId === providerTask.taskId).updatedAt;
  const freshnessGrant = approvals.createStandingGrant({ capability: 'gmail.send' }, { principal: 'signal-box-user', surface: 'desktop', constraints: { threadId: 'thread-provider' }, expiresAt: Date.now() + 60_000 });
  await assert.rejects(() => providerService.executeWithStandingGrant({ capability: 'gmail.send', destination: 'alex@example.com', threadId: 'thread-provider', taskId: providerTask.taskId, taskVersion: providerTaskVersion - 1, content: { subject: 'Re: Handoff', body: 'Stale.' } }, { grantId: freshnessGrant.grantId }), /stale/);
  const result = await service.executeWithStandingGrant(recipe, {}, { grantId: grant.grantId });
  assert.equal(result.receipt.status, 'confirmed');
  assert.equal(store.getAutonomousRun(result.runId).status, 'confirmed');
  assert.equal(executions, 1);
  assert.equal(store.listStandingGrants({ principal: 'signal-box-user' }).length, 3);
  assert.equal(store.listAutonomousRuns({ grantId: grant.grantId }).length, 1);
  await assert.rejects(() => service.executeWithStandingGrant(recipe, {}, { grantId: grant.grantId }), /usage limit/);
  const revoked = approvals.createStandingGrant({ capability: 'browser.read' }, { principal: 'signal-box-user', surface: 'desktop', constraints: {}, expiresAt: Date.now() + 60_000 });
  store.revokeStandingGrant(revoked.grantId);
  await assert.rejects(() => service.executeWithStandingGrant(recipe, {}, { grantId: revoked.grantId }), /not active/);
  const unknownGrant = approvals.createStandingGrant({ capability: 'browser.read' }, { principal: 'signal-box-user', surface: 'desktop', constraints: { recipeId: recipe.id }, expiresAt: Date.now() + 60_000 });
  const unknown = store.createAutonomousRun({ grantId: unknownGrant.grantId, action: { taskId: 'unknown-task', capability: 'browser.read', recipeId: recipe.id }, actionDigest: 'unknown-digest', status: 'unknown' });
  const reconciled = service.reconcileUnknownRun(unknown.runId, { evidence: 'Verified the provider confirmation in the browser.' });
  assert.equal(reconciled.status, 'confirmed');
  assert.equal(reconciled.receipt.verification, 'user-reconciled');
  assert.throws(() => service.reconcileUnknownRun(unknown.runId, { evidence: 'again' }), /Only an unknown/);
  store.close();
  console.log('standing grant tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
