const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ProactivityService } = require('../host/proactivity/service');
const { replanTask } = require('../host/proactivity/replan');

(async () => {
  const store = new SqliteStore({ clock: () => 200_000 });
  const proactivity = new ProactivityService({ store, clock: () => 200_000 });
  store.saveTaskCandidate({ candidateId: 'replan-due', observationId: 'replan-observation', summary: 'Send the revised proposal', dueDate: 'today', evidence: { start: 0, end: 7, text: 'proposal' }, extractorVersion: 'test' });
  const actionable = await replanTask({ store, proactivity, taskId: 'replan-due', reason: 'task-corrected' });
  assert.equal(actionable.decision, 'digest');
  assert.equal(actionable.notified, true);
  assert.equal(store.listPendingNotifications({ notificationClass: 'assistant-replan' }).length, 1);
  const duplicate = await replanTask({ store, proactivity, taskId: 'replan-due', reason: 'task-corrected' });
  assert.equal(duplicate.notified, false, 'the same task version and decision are deduplicated');
const waiting = store.saveTaskCandidate({ candidateId: 'replan-wait', observationId: 'replan-wait-observation', summary: 'Someday task', evidence: { start: 0, end: 7, text: 'Someday' }, extractorVersion: 'test' });
const proactiveJobs = store.exportData().data.jobs.filter((job) => job.kind === 'assistant.proactive-actions' && JSON.parse(job.payload_json).taskId === waiting.taskId);
assert.equal(proactiveJobs.length, 1, 'new tasks enqueue an immediate durable proactive evaluation');
assert.equal(JSON.parse(proactiveJobs[0].payload_json).taskVersion, store.listTasks({ includeDismissed: true }).find((task) => task.taskId === waiting.taskId).updatedAt);
store.correctTask(waiting.taskId, { summary: 'Updated someday task' });
assert.equal(store.exportData().data.jobs.filter((job) => job.kind === 'assistant.proactive-actions' && JSON.parse(job.payload_json).taskId === waiting.taskId).length, 2, 'task corrections enqueue a versioned proactive evaluation');
  assert.deepEqual(await replanTask({ store, proactivity, taskId: waiting.taskId }), { taskId: waiting.taskId, decision: 'wait', notified: false });
  assert.deepEqual(await replanTask({ store, proactivity, taskId: 'missing-task' }), { skipped: true, reason: 'task-not-found' });
  store.close();
  console.log('replan tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
