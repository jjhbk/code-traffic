class ApprovalService {
  constructor({ store, clock = () => Date.now(), policyVersion = '1' } = {}) {
    if (!store) throw new Error('An approval store is required.');
    this.store = store;
    this.clock = clock;
    this.policyVersion = policyVersion;
  }

  request(actionProposal, { principal, surfaces = ['desktop'], expiresAt = this.clock() + 5 * 60 * 1000 } = {}) {
    if (!actionProposal?.capability || actionProposal.capability === 'unknown') throw new Error('Unknown capabilities cannot be approved.');
    if (actionProposal.autonomous === true) throw new Error('Autonomous write grants are disabled.');
    return this.store.createApproval({ action: actionProposal, options: actionProposal.options || [{ optionId: 'allow', label: 'Allow once' }, { optionId: 'deny', label: 'Deny' }], principal, surfaces, expiresAt, policyVersion: this.policyVersion });
  }

  decide(requestId, optionId, { principal, surface } = {}) {
    if (!principal || !surface) throw new Error('Approval identity is required.');
    return this.store.decide({ requestId, optionId, principal, surface });
  }

  execution(attempt) { return this.store.recordExecutionAttempt(attempt); }

  receipt(receipt) { return this.store.recordReceipt(receipt); }
}

module.exports = { ApprovalService };
