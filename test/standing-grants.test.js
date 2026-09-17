const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { BrowserActionService } = require('../host/browser/service');

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
  const result = await service.executeWithStandingGrant(recipe, {}, { grantId: grant.grantId });
  assert.equal(result.receipt.status, 'confirmed');
  assert.equal(store.getAutonomousRun(result.runId).status, 'confirmed');
  assert.equal(executions, 1);
  assert.equal(store.listStandingGrants({ principal: 'signal-box-user' }).length, 1);
  assert.equal(store.listAutonomousRuns({ grantId: grant.grantId }).length, 1);
  await assert.rejects(() => service.executeWithStandingGrant(recipe, {}, { grantId: grant.grantId }), /usage limit/);
  const revoked = approvals.createStandingGrant({ capability: 'browser.read' }, { principal: 'signal-box-user', surface: 'desktop', constraints: {}, expiresAt: Date.now() + 60_000 });
  store.revokeStandingGrant(revoked.grantId);
  await assert.rejects(() => service.executeWithStandingGrant(recipe, {}, { grantId: revoked.grantId }), /not active/);
  store.close();
  console.log('standing grant tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
