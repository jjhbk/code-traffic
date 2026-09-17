function observationStart(observation) {
  const value = observation?.start || observation?.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokens(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3));
}

class MeetingPrepWorkflow {
  constructor({ store, workflows, clock = () => Date.now(), leadMs = 60 * 60 * 1000, horizonMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
    if (!store || !workflows) throw new Error('Meeting preparation requires store and workflow services.');
    this.store = store; this.workflows = workflows; this.clock = clock; this.leadMs = leadMs; this.horizonMs = horizonMs;
  }

  scheduleUpcoming(calendarObservations = [], { sourceObservations = calendarObservations, now = this.clock() } = {}) {
    const scheduled = []; const seen = new Set(); const allWorkflows = this.store.listWorkflows();
    for (const event of calendarObservations) {
      const startAt = observationStart(event);
      if (!event?.observationId) continue;
      const key = event.observationId; seen.add(key);
      const existing = allWorkflows.find((workflow) => workflow.workflowType === 'meeting-prep' && (workflow.payload.calendarObservationId === key || (event.id && workflow.payload.eventId === event.id)));
      if (isCancelled(event)) { if (existing) this.store.updateWorkflow(existing.workflowId, { state: 'cancelled', details: { reason: 'calendar-event-cancelled' } }); continue; }
      if (!startAt || startAt < now || startAt > now + this.horizonMs) continue;
      const prepAt = Math.max(now, startAt - this.leadMs);
      if (existing) {
        if (existing.state === 'completed' && Number(existing.payload.startAt) === startAt) continue;
        if (Number(existing.payload.startAt) !== startAt && existing.state === 'waiting_event') {
          this.store.updateWorkflow(existing.workflowId, { state: 'cancelled', details: { reason: 'calendar-event-rescheduled' } });
        } else if (existing.state === 'waiting_event' && existing.payload.calendarObservationId !== key) {
          this.store.updateWorkflow(existing.workflowId, { wakeAt: prepAt, payload: { ...existing.payload, calendarObservationId: key, startAt, subject: event.subject || existing.payload.subject, location: event.location || existing.payload.location } });
          this.workflows.scheduleResume(existing.workflowId, prepAt, 'meeting.prep');
          continue;
        }
        else continue;
      }
      const workflow = this.workflows.start({ workflowType: 'meeting-prep', state: 'waiting_event', wakeAt: prepAt, payload: { calendarObservationId: key, eventId: event.id || null, subject: event.subject || '(untitled meeting)', startAt, location: event.location || null, leadMs: this.leadMs } });
      this.workflows.setStep(workflow.workflowId, { stepId: 'wait-until-prep', stepIndex: 0, state: 'waiting', details: { prepAt, startAt } });
      this.workflows.scheduleResume(workflow.workflowId, prepAt, 'meeting.prep'); scheduled.push(workflow.workflowId);
    }
    return { scheduled, considered: seen.size };
  }

  prepare(workflowId, { observations = this.store.observations(), now = this.clock() } = {}) {
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow || workflow.workflowType !== 'meeting-prep' || workflow.state !== 'waiting_event') throw new Error('Meeting preparation workflow is not waiting.');
    const event = observations.find((item) => item.observationId === workflow.payload.calendarObservationId);
    if (!event || isCancelled(event)) return this.store.updateWorkflow(workflowId, { state: 'cancelled', payload: { ...workflow.payload, outcome: 'event-cancelled-or-removed' }, details: { reason: 'calendar-event-cancelled' } });
    const startAt = observationStart(event);
    if (!startAt || startAt < now) return this.store.updateWorkflow(workflowId, { state: 'needs_attention', payload: { ...workflow.payload, outcome: 'event-started-before-preparation' }, details: { reason: 'event-started-before-preparation' } });
    const subjectTokens = tokens(event.subject);
    const sources = observations.filter((item) => item.observationId !== event.observationId && item.provider !== 'google-calendar' && (subjectTokens.size === 0 || [...tokens(`${item.subject} ${item.body}`)].some((token) => subjectTokens.has(token)))).slice(0, 8);
    const brief = {
      title: event.subject || '(untitled meeting)', start: event.start || event.timestamp, end: event.end || null, location: event.location || null,
      agenda: event.description || null,
      sources: sources.map((item) => ({ observationId: item.observationId, provider: item.provider || null, subject: item.subject || null, excerpt: String(item.body || '').slice(0, 500) })),
      generatedAt: now,
    };
    this.workflows.setStep(workflowId, { stepId: 'prepare-brief', stepIndex: 1, state: 'completed', details: { sourceCount: brief.sources.length } });
    const notification = this.store.enqueueNotification({ notificationId: `meeting-prep:${workflow.payload.calendarObservationId}:${workflow.payload.startAt}`, dateKey: `meeting-prep:${workflow.payload.calendarObservationId}:${workflow.payload.startAt}`, notificationClass: 'meeting-prep', items: [{ workflowId, summary: brief.title, reason: 'Meeting brief ready', evidence: brief }] });
    return this.store.updateWorkflow(workflowId, { state: 'completed', payload: { ...workflow.payload, outcome: 'brief-ready', brief, notificationId: notification?.notificationId || null }, details: { reason: 'brief-ready', sourceCount: brief.sources.length } });
  }
}

function isCancelled(observation) {
  return String(observation?.status || '').toLowerCase() === 'cancelled' || (observation?.labels || []).some((label) => String(label).toLowerCase() === 'cancelled');
}

module.exports = { MeetingPrepWorkflow, observationStart, isCancelled };
