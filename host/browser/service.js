const { validateRecipe, digest } = require('./recipes');

class BrowserActionService {
  constructor({ approvals, executor, store, clock = () => Date.now() } = {}) {
    if (!approvals || !store) throw new Error('Browser action service requires approvals and store.');
    this.approvals = approvals; this.executor = executor; this.store = store; this.clock = clock;
  }

  prepare(recipe, inputs, { principal = 'signal-box-user', surfaces = ['desktop', 'telegram'], expiresAt = this.clock() + 10 * 60 * 1000, sessionId = null } = {}) {
    const checked = validateRecipe(recipe);
    const action = { capability: `browser.${checked.effects}`, autonomous: false, recipeId: checked.id, recipeDigest: checked.digest, recipe: checked, sessionId, origin: checked.origin, inputs: { ...inputs }, consequences: `Run the ${checked.id} browser recipe at ${checked.origin}.`, options: [{ optionId: 'allow', label: 'Run once' }, { optionId: 'deny', label: 'Cancel' }] };
    return this.approvals.request(action, { principal, surfaces, expiresAt });
  }

  async executeApproved(requestId, { principal = 'signal-box-user', surface = 'desktop', executor = this.executor } = {}) {
    if (!executor) throw new Error('A browser executor is required.');
    const request = this.store.getApproval(requestId);
    if (!request || request.status !== 'resolved') throw new Error('Browser approval is not resolved.');
    const decision = this.store.getDecision(requestId);
    if (!decision || decision.optionId !== 'allow') throw new Error('Browser action was not approved.');
    const action = request.action;
    const attempt = this.approvals.claimExecution({ requestId, details: { capability: action.capability, recipeId: action.recipeId, surface } });
    this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: 'authorized', details: { decisionId: decision.decisionId, surface } });
    try {
      this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: 'dispatched', details: { recipeId: action.recipeId, surface } });
      const receipt = await executor.run(action.recipe, action.inputs, { approve: async () => true });
      this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: 'confirmed', details: { receiptStatus: receipt.status, surface } });
      const saved = this.approvals.receipt({ attemptId: attempt.attemptId, receipt: { ...receipt, requestId, actionDigest: digest(action) } });
      return { attemptId: attempt.attemptId, receiptId: saved.receiptId, receipt };
    } catch (error) {
      const outcomeStatus = error.outcomeStatus === 'unknown' ? 'unknown' : 'failed';
      this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: outcomeStatus, details: { error: error.message, surface, checkpoint: error.browserCheckpoint || null } });
      throw error;
    }
  }

  async executeWithStandingGrant(recipe, inputs, { grantId, principal = 'signal-box-user', surface = 'desktop', taskId = null, executor = this.executor } = {}) {
    if (!grantId || !executor) throw new Error('A standing grant and browser executor are required.');
    const checked = validateRecipe(recipe);
    const action = { capability: `browser.${checked.effects}`, autonomous: true, recipeId: checked.id, recipeDigest: checked.digest, origin: checked.origin, inputs: { ...inputs }, effects: checked.effects, taskId };
    this.approvals.authorizeStanding(action, { grantId, principal, surface });
    const actionDigest = digest(action);
    const run = this.store.createAutonomousRun({ grantId, action, actionDigest, details: { capability: action.capability, recipeId: action.recipeId, surface } });
    this.store.updateAutonomousRun(run.runId, 'authorized', { details: { principal, surface } });
    try {
      this.store.updateAutonomousRun(run.runId, 'dispatched', { details: { surface } });
      const receipt = await executor.run(checked, inputs, { approve: async () => true });
      this.store.updateAutonomousRun(run.runId, 'confirmed', { details: { receiptStatus: receipt.status, surface }, receipt: { ...receipt, runId: run.runId, grantId, actionDigest } });
      return { runId: run.runId, receipt };
    } catch (error) {
      const status = error.outcomeStatus === 'unknown' ? 'unknown' : 'failed';
      this.store.updateAutonomousRun(run.runId, status, { details: { error: error.message, surface, checkpoint: error.browserCheckpoint || null } });
      throw error;
    }
  }

  reconcileUnknownRun(runId, { evidence, principal = 'signal-box-user' } = {}) {
    const cleanEvidence = String(evidence || '').trim();
    if (!cleanEvidence || cleanEvidence.length > 2_000) throw new Error('A concise verification note is required.');
    const run = this.store.getAutonomousRun(runId);
    if (!run || run.status !== 'unknown') throw new Error('Only an unknown autonomous run can be reconciled.');
    const grant = this.store.getStandingGrant(run.grantId);
    if (!grant || grant.principal !== principal) throw new Error('The autonomous run is not owned by this user.');
    const details = { ...run.details, reconciliation: { source: 'user', principal, evidence: cleanEvidence, reconciledAt: this.clock() } };
    return this.store.updateAutonomousRun(runId, 'confirmed', {
      details,
      receipt: { status: 'confirmed', verification: 'user-reconciled', evidence: cleanEvidence, runId, actionDigest: run.actionDigest },
    });
  }
}

module.exports = { BrowserActionService };
