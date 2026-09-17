const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');

const store = new SqliteStore({ clock: () => 10_000 });
const task = store.saveTaskCandidate({
  candidateId: 'context-task',
  observationId: 'context-observation',
  summary: 'Pick up the return',
  contextTrigger: { type: 'arrival', placeKey: 'home' },
  evidence: { start: 0, end: 20, text: 'Pick up the return when you arrive home.' },
  extractorVersion: 'test',
});
const approval = store.createApproval({
  action: { taskId: task.taskId, capability: 'gmail.send' },
  options: [{ optionId: 'allow', label: 'Allow' }],
  principal: 'signal-box-user',
  expiresAt: 20_000,
});

store.upsertContext({ recordType: 'place', recordKey: 'home', value: { label: 'Home', latitude: 1, longitude: 2, radiusMeters: 100 }, confirmed: true, confidence: 'high' });
const firstJob = store.exportData().data.jobs.find((job) => job.kind === 'assistant.replan');
assert.ok(firstJob, 'context changes enqueue a replan');
assert.equal(JSON.parse(firstJob.payload_json).reason, 'context-updated');
assert.equal(store.getApproval(approval.request_id).status, 'cancelled', 'context changes invalidate stale approvals');

store.upsertContext({ recordType: 'place', recordKey: 'home', value: { label: 'Home', latitude: 3, longitude: 4, radiusMeters: 100 }, confirmed: true, confidence: 'high' });
assert.equal(store.exportData().data.jobs.filter((job) => job.kind === 'assistant.replan').length, 1, 'active context replans are deduplicated');

const claimed = store.claimJobs({ workerId: 'context-test-worker', now: 10_000, kinds: ['assistant.replan'] });
assert.equal(claimed.length, 1);
store.completeJob(firstJob.job_id, claimed[0].leaseToken, { status: 'completed' });
// The completed job is no longer active, so forgetting the place can enqueue a fresh replan.
assert.equal(store.deleteContext('place', 'home'), true);
const replans = store.exportData().data.jobs.filter((job) => job.kind === 'assistant.replan');
assert.equal(replans.length, 2);
assert.equal(JSON.parse(replans.at(-1).payload_json).reason, 'context-deleted');
const clearedTask = store.listTasks({ includeDismissed: true }).find((item) => item.taskId === task.taskId);
assert.equal(clearedTask.contextTrigger, null, 'forgetting a place removes the task arrival dependency');
assert.ok(store.exportData().data.jobs.some((job) => job.kind === 'assistant.proactive-actions' && JSON.parse(job.payload_json).taskId === task.taskId), 'forgetting context schedules immediate proactive reevaluation');
store.close();
console.log('context invalidation tests passed');
