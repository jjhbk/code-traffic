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
  assert.deepEqual(await replanTask({ store, proactivity, taskId: waiting.taskId }), { taskId: waiting.taskId, decision: 'wait', notified: false });
  assert.deepEqual(await replanTask({ store, proactivity, taskId: 'missing-task' }), { skipped: true, reason: 'task-not-found' });
  store.close();
  console.log('replan tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
