const { PolicyEngine } = require('../policy/engine');

class ApprovalService {
  constructor({ store, clock = () => Date.now(), policyVersion = null, policy = null } = {}) {
    if (!store) throw new Error('An approval store is required.');
    this.store = store;
    this.clock = clock;
    this.policy = policy || new PolicyEngine({ version: policyVersion || 'single-user-1' });
    this.policyVersion = policyVersion || this.policy.version;
  }

  request(actionProposal, { principal, surfaces = ['desktop'], expiresAt = this.clock() + 5 * 60 * 1000 } = {}) {
    const decisionPolicy = this.policy.evaluate(actionProposal, { surfaces });
    return this.store.createApproval({ action: { ...actionProposal, effects: actionProposal.effects || decisionPolicy.effects }, options: actionProposal.options || [{ optionId: 'allow', label: 'Allow once' }, { optionId: 'deny', label: 'Deny' }], principal, surfaces: decisionPolicy.surfaces, expiresAt, policyVersion: this.policyVersion });
  }

  decide(requestId, optionId, { principal, surface } = {}) {
    if (!principal || !surface) throw new Error('Approval identity is required.');
    return this.store.decide({ requestId, optionId, principal, surface });
  }

  execution(attempt) { return this.store.recordExecutionAttempt(attempt); }

  receipt(receipt) { return this.store.recordReceipt(receipt); }
}

module.exports = { ApprovalService };
