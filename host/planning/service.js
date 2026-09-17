class PlanningService {
  constructor({ workflows, browserActions, registry = null } = {}) {
    if (!workflows || !browserActions) throw new Error('Planning service requires workflow and browser action services.');
    this.workflows = workflows;
    this.browserActions = browserActions;
    this.registry = registry;
  }

  async executeDecision({ decision, recipe, inputs = {}, grantId, taskId = null, taskVersion = decision?.taskVersion ?? null, principal = 'signal-box-user', surface = 'desktop', executor = null } = {}) {
    if (!decision || decision.type !== 'execute_browser' || decision.requiresApproval !== false) throw new Error('Only explicitly authorized browser decisions can execute automatically.');
    if (!recipe?.id || !grantId) throw new Error('An automatic browser decision requires a recipe and standing grant.');
    const registeredRecipe = this.registry ? this.registry.browserRecipe(recipe.id, recipe.digest || null) : recipe;
    const workflow = this.workflows.start({ workflowType: 'browser-action', taskId, state: 'evaluating', payload: { recipeId: registeredRecipe.id, inputs, grantId, principal, surface, taskVersion, decisionReason: decision.reason || null } });
    this.workflows.setStep(workflow.workflowId, { stepId: 'authorize', stepIndex: 0, state: 'completed', details: { grantId } });
    this.workflows.transition(workflow.workflowId, 'executing', { recipeId: registeredRecipe.id, grantId });
    this.workflows.setStep(workflow.workflowId, { stepId: 'execute', stepIndex: 1, state: 'running', details: { recipeId: registeredRecipe.id } });
    try {
      const result = await this.browserActions.executeWithStandingGrant(registeredRecipe, inputs, { grantId, principal, surface, taskId, taskVersion, workflowId: workflow.workflowId, executor: executor || undefined });
      this.storeWorkflow(workflow.workflowId, 'completed', { ...workflow.payload, outcome: 'confirmed', runId: result.runId, receipt: result.receipt }, { runId: result.runId });
      this.workflows.setStep(workflow.workflowId, { stepId: 'execute', stepIndex: 1, state: 'completed', details: { runId: result.runId, receipt: result.receipt } });
      return this.workflows.store.getWorkflow(workflow.workflowId);
    } catch (error) {
      const current = this.workflows.store.getWorkflow(workflow.workflowId);
      const attention = this.storeWorkflow(workflow.workflowId, 'needs_attention', { ...current.payload, outcome: error.code === 'EXECUTION_UNKNOWN' ? 'unknown' : 'failed', error: error.message }, { error: error.message });
      this.workflows.setStep(workflow.workflowId, { stepId: 'execute', stepIndex: 1, state: 'failed', details: { error: error.message } });
      throw Object.assign(error, { workflowId: attention.workflowId });
    }
  }

  storeWorkflow(workflowId, state, payload, details) {
    return this.workflows.store.updateWorkflow(workflowId, { state, payload, details });
  }
}

module.exports = { PlanningService };
