const ACTIVE_STATES = new Set(['ready', 'evaluating', 'awaiting_input', 'awaiting_approval', 'executing', 'waiting_event', 'verifying', 'needs_attention']);

class WorkflowService {
  constructor({ store } = {}) {
    if (!store) throw new Error('Workflow service requires a store.');
    this.store = store;
  }

  start(definition) { return this.store.createWorkflow(definition); }

  transition(workflowId, state, details = {}) {
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow) throw new Error('Workflow not found.');
    if (state === 'cancelled' && ['completed', 'cancelled'].includes(workflow.state)) throw new Error(`Workflow is already ${workflow.state}.`);
    if (!ACTIVE_STATES.has(workflow.state) && state !== 'cancelled') throw new Error('Completed workflows cannot transition.');
    return this.store.updateWorkflow(workflowId, { state, details });
  }

  cancel(workflowId, reason = 'user-cancelled') {
    return this.transition(workflowId, 'cancelled', { reason });
  }

  setStep(workflowId, step) { return this.store.upsertWorkflowStep(workflowId, step); }

  resume(workflowId) {
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow) throw new Error('Workflow not found.');
    if (workflow.state !== 'waiting_event') return workflow;
    return this.store.updateWorkflow(workflowId, { state: 'needs_attention', payload: { ...workflow.payload, wakeReason: 'response-window-expired' }, details: { reason: 'response-window-expired' } });
  }

  scheduleResume(workflowId, runAt, kind = 'workflow.resume') {
    if (!Number.isFinite(runAt)) throw new Error('Workflow resume time is required.');
    return this.store.enqueueJob({ kind, payload: { workflowId }, runAt, dedupeKey: `${kind}:${workflowId}:${runAt}` });
  }
}

module.exports = { WorkflowService, ACTIVE_STATES };
