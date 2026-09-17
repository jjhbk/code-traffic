class AvailabilityWorkflow {
  constructor({ store, workflows, clock = () => Date.now() } = {}) {
    if (!store || !workflows) throw new Error('Availability workflow requires store and workflows.');
    this.store = store;
    this.workflows = workflows;
    this.clock = clock;
  }

  start({ taskId = null, checkRecipeId, reservationRecipeId, inputs = {}, checkGrantId = null, reservationGrantId, intervalMs = 15 * 60 * 1000, maxChecks = 96 } = {}) {
    if (!checkRecipeId || !reservationRecipeId || !checkGrantId || !reservationGrantId || !Number.isInteger(intervalMs) || intervalMs < 1_000 || !Number.isInteger(maxChecks) || maxChecks < 1) throw new Error('Availability watcher requires recipes, check and reservation permissions, interval, and check limit.');
    const workflow = this.workflows.start({ workflowType: 'browser-availability', taskId, state: 'waiting_event', wakeAt: this.clock(), payload: { checkRecipeId, reservationRecipeId, inputs, checkGrantId, reservationGrantId, intervalMs, maxChecks, checks: 0 } });
    this.workflows.setStep(workflow.workflowId, { stepId: 'monitor', stepIndex: 0, state: 'waiting', details: { intervalMs, maxChecks } });
    this.scheduleCheck(workflow.workflowId, this.clock());
    return this.store.getWorkflow(workflow.workflowId);
  }

  scheduleCheck(workflowId, runAt) {
    return this.workflows.scheduleResume(workflowId, runAt, 'browser.availability.check');
  }

  async check(workflowId, { available, evidence = null, executeReservation } = {}) {
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow || workflow.workflowType !== 'browser-availability') throw new Error('Availability workflow not found.');
    if (workflow.state !== 'waiting_event') return workflow;
    const checks = Number(workflow.payload.checks || 0) + 1;
    const payload = { ...workflow.payload, checks, lastCheckAt: this.clock(), lastCheck: { available: Boolean(available), evidence } };
    this.store.updateWorkflow(workflowId, { state: 'evaluating', payload, details: { checks, available: Boolean(available) } });
    if (available) {
      if (typeof executeReservation !== 'function') {
        return this.store.updateWorkflow(workflowId, { state: 'needs_attention', payload: { ...payload, outcome: 'availability-confirmed-no-reservation-handler' }, details: { reason: 'reservation-handler-unavailable' } });
      }
      this.store.updateWorkflow(workflowId, { state: 'executing', payload, details: { reason: 'availability-confirmed' } });
      try {
        const result = await executeReservation({ workflow, payload });
        this.workflows.setStep(workflowId, { stepId: 'monitor', stepIndex: 0, state: 'completed', details: { checks, evidence } });
        return this.store.updateWorkflow(workflowId, { state: 'completed', payload: { ...payload, outcome: 'reserved', reservation: result }, details: { reason: 'reservation-completed', checks } });
      } catch (error) {
        return this.store.updateWorkflow(workflowId, { state: 'needs_attention', payload: { ...payload, outcome: 'reservation-failed', error: error.message }, details: { reason: 'reservation-failed', checks } });
      }
    }
    if (checks >= workflow.payload.maxChecks) {
      this.workflows.setStep(workflowId, { stepId: 'monitor', stepIndex: 0, state: 'failed', details: { checks, reason: 'check-limit-reached' } });
      return this.store.updateWorkflow(workflowId, { state: 'needs_attention', payload: { ...payload, outcome: 'availability-not-found' }, details: { reason: 'check-limit-reached', checks } });
    }
    const nextAt = this.clock() + workflow.payload.intervalMs;
    const waiting = this.store.updateWorkflow(workflowId, { state: 'waiting_event', wakeAt: nextAt, payload: { ...payload, nextCheckAt: nextAt }, details: { reason: 'availability-not-found', checks } });
    this.scheduleCheck(workflowId, nextAt);
    return waiting;
  }
}

module.exports = { AvailabilityWorkflow };
