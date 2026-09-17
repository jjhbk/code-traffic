const { PolicyEngine } = require('../policy/engine');

class ApprovalService {
  constructor({ store, clock = () => Date.now(), policyVersion = null, policy = null, registry = null } = {}) {
    if (!store) throw new Error('An approval store is required.');
    this.store = store;
    this.clock = clock;
    this.policy = policy || new PolicyEngine({ version: policyVersion || 'single-user-1' });
    this.registry = registry;
    this.policyVersion = policyVersion || this.policy.version;
  }

  request(actionProposal, { principal, surfaces = ['desktop'], expiresAt = this.clock() + 5 * 60 * 1000 } = {}) {
    this.registry?.validateAction(actionProposal);
    const decisionPolicy = this.policy.evaluate(actionProposal, { surfaces });
    return this.store.createApproval({ action: { ...actionProposal, effects: actionProposal.effects || decisionPolicy.effects }, options: actionProposal.options || [{ optionId: 'allow', label: 'Allow once' }, { optionId: 'deny', label: 'Deny' }], principal, surfaces: decisionPolicy.surfaces, expiresAt, policyVersion: this.policyVersion });
  }

  createStandingGrant(actionProposal, { principal, surface = 'desktop', constraints = {}, expiresAt, maxUses = null, cooldownMs = 0 } = {}) {
    const decisionPolicy = this.policy.evaluate({ ...actionProposal, autonomous: false }, { surfaces: [surface] });
    // Standing grants are consumed by the autonomous browser runner. Provider
    // writes still require an explicit, one-time approval until they have a
    // durable workflow, postcondition, and reconciliation path of their own.
    if (!decisionPolicy.capability.startsWith('browser.')) {
      throw new Error('Standing permissions are currently available only for browser actions.');
    }
    return this.store.createStandingGrant({ principal, capability: decisionPolicy.capability, surface, constraints, expiresAt, maxUses, cooldownMs, policyVersion: this.policyVersion });
  }

  authorizeStanding(action, { grantId, principal, surface = 'desktop' } = {}) {
    this.registry?.validateAction(action);
    this.policy.evaluate({ ...action, autonomous: false }, { surfaces: [surface] });
    return this.store.consumeStandingGrant(grantId, action, { principal, surface, policyVersion: this.policyVersion, now: this.clock() });
  }

  decide(requestId, optionId, { principal, surface } = {}) {
    if (!principal || !surface) throw new Error('Approval identity is required.');
    return this.store.decide({ requestId, optionId, principal, surface });
  }

  cancel(requestId, reason = 'invalidated') { return this.store.cancelApproval(requestId, reason); }

  getApproval(requestId) { return this.store.getApproval(requestId); }

  execution(attempt) { return this.store.recordExecutionAttempt(attempt); }

  claimExecution(attempt) { return this.store.claimExecutionAttempt(attempt); }

  receipt(receipt) { return this.store.recordReceipt(receipt); }
}

module.exports = { ApprovalService };
