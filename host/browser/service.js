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
      this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: 'failed', details: { error: error.message, surface } });
      throw error;
    }
  }
}

module.exports = { BrowserActionService };
