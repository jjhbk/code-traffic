const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { WorkflowService } = require('../host/workflows/service');
const { MeetingPrepWorkflow } = require('../host/workflows/meeting-prep');

(() => {
  let now = Date.parse('2026-09-17T12:00:00Z');
  const store = new SqliteStore({ clock: () => now }); const workflows = new WorkflowService({ store });
  const prep = new MeetingPrepWorkflow({ store, workflows, clock: () => now, leadMs: 60 * 60 * 1000 });
  const calendar = { observationId: 'calendar-observation-1', messageId: 'calendar-message-1', threadId: 'calendar:event-1', provider: 'google-calendar', id: 'event-1', subject: 'Launch review', body: 'Launch review\nStarts: 2026-09-17T14:00:00Z', start: '2026-09-17T14:00:00Z', end: '2026-09-17T15:00:00Z', location: 'Room A' };
  const source = { observationId: 'mail-observation-1', messageId: 'mail-message-1', threadId: 'mail:thread-1', provider: 'gmail', subject: 'Launch review notes', body: 'The launch review agenda is ready.' };
  store.saveObservation(calendar, 'calendar:test'); store.saveObservation(source, 'gmail:test');
  const started = prep.scheduleUpcoming([calendar], { now });
  assert.equal(started.scheduled.length, 1); const workflow = store.getWorkflow(started.scheduled[0]); assert.equal(workflow.state, 'waiting_event');
  const job = store.claimJobs({ now: workflow.wakeAt, workerId: 'meeting-prep' })[0]; assert.equal(job.kind, 'meeting.prep');
  const completed = prep.prepare(workflow.workflowId, { observations: store.observations(), now: workflow.wakeAt });
  assert.equal(completed.state, 'completed'); assert.equal(completed.payload.brief.sources.length, 1); assert.equal(store.listPendingNotifications({ notificationClass: 'meeting-prep' }).length, 1);
  const second = prep.scheduleUpcoming([calendar], { now: workflow.wakeAt }); assert.equal(second.scheduled.length, 0);
  store.close(); console.log('meeting prep tests passed');
})();
