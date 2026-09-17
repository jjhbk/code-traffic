const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ProactivityService } = require('../host/proactivity/service');

let now = 100_000;
const store = new SqliteStore({ clock: () => now });
const service = new ProactivityService({ store, followUpAfterMs: 1_000 });
const frontier = service.selectAutomaticDecisions([
  { taskId: 'auto-1', type: 'execute_browser' },
  { taskId: 'auto-2', type: 'execute_browser' },
  { taskId: 'auto-3', type: 'execute_browser' },
  { taskId: 'wait-1', type: 'wait' },
]);
assert.deepEqual(frontier.selected.map((decision) => decision.taskId), ['auto-1', 'auto-2', 'auto-3']);
assert.deepEqual(frontier.deferred, [], 'the default action frontier accepts three automatic actions per cycle');
assert.deepEqual(service.selectAutomaticDecisions([
  { taskId: 'auto-1', type: 'execute_browser' },
  { taskId: 'auto-2', type: 'execute_browser' },
], { maxActions: 1 }).deferred.map((decision) => decision.taskId), ['auto-2']);
const decide = (task) => service.decide(task, { now });
assert.equal(decide({ taskId: 'a', status: 'active', dueDate: 'today' }).type, 'digest');
assert.equal(decide({ taskId: 'removed', status: 'active', sourceUnavailable: true, dueDate: 'today' }).reason, 'source-unavailable');
assert.equal(decide({ taskId: 'deadline', status: 'active', dueDate: 'friday', dueAt: now + 60_000 }).reason, 'deadline-within-24-hours');
assert.equal(decide({ taskId: 'b', status: 'active', confidence: 'low' }).type, 'clarify');
assert.equal(decide({ taskId: 'c', status: 'active', owner: 'counterparty', blocker: 'self', updatedAt: now - 2_000, counterparty: 'alex@example.com' }).type, 'draft_follow_up');
store.setSuppression('counterparty', 'alex@example.com');
assert.equal(decide({ taskId: 'c', status: 'active', owner: 'counterparty', blocker: 'self', updatedAt: now - 2_000, counterparty: 'alex@example.com' }).type, 'wait');
assert.equal(decide({ taskId: 'd', status: 'snoozed', snoozedUntil: now + 100 }).reason, 'task-snoozed');
store.saveTaskCandidate({ candidateId: 'blocked-task', observationId: 'blocked-observation', summary: 'Prepare proposal', evidence: { start: 0, end: 1, text: 'Prepare proposal' }, extractorVersion: 'test' });
store.saveTaskCandidate({ candidateId: 'dependency-task', observationId: 'dependency-observation', summary: 'Get pricing', evidence: { start: 0, end: 1, text: 'Get pricing' }, extractorVersion: 'test' });
store.addTaskRelation('blocked-task', 'dependency-task', 'depends_on', { reason: 'pricing is required' });
const blocked = decide({ taskId: 'blocked-task', status: 'active', dueDate: 'today' });
assert.equal(blocked.type, 'wait');
assert.equal(blocked.reason, 'blocked-by-dependency');
assert.deepEqual(blocked.blockingTaskIds, ['dependency-task']);
store.setTaskStatus('dependency-task', 'done', { reason: 'received' });
assert.equal(decide({ taskId: 'blocked-task', status: 'active', dueDate: 'today' }).type, 'digest');
store.saveTaskCandidate({ candidateId: 'automatic-task', observationId: 'automatic-observation', summary: 'Check availability', evidence: { start: 0, end: 1, text: 'Check availability' }, extractorVersion: 'test', automation: { type: 'browser', capability: 'browser.read', recipeId: 'fixture.availability.v1', origin: 'https://example.com', inputs: { destination: 'Airport' } } });
const automaticTask = store.listTasks({ includeDismissed: true }).find((task) => task.taskId === 'automatic-task');
const grant = store.createStandingGrant({ principal: 'signal-box-user', capability: 'browser.read', surface: 'desktop', constraints: { recipeId: 'fixture.availability.v1', origin: 'https://example.com', inputs: { destination: 'Airport' } }, expiresAt: now + 60_000, policyVersion: 'single-user-1' });
const automatic = decide(automaticTask);
assert.equal(automatic.type, 'execute_browser');
assert.equal(automatic.grantId, grant.grantId);
store.createWorkflow({ workflowType: 'browser-action', taskId: automaticTask.taskId, state: 'executing', payload: {} });
assert.equal(decide(automaticTask).reason, 'automation-in-progress');
store.updateWorkflow(store.listWorkflows({ taskId: automaticTask.taskId, activeOnly: true })[0].workflowId, { state: 'completed' });
store.createAutonomousRun({ grantId: grant.grantId, action: { taskId: automaticTask.taskId, capability: 'browser.read', recipeId: 'fixture.availability.v1' }, actionDigest: 'digest-automatic', status: 'confirmed' });
assert.equal(decide(automaticTask).reason, 'automation-completed');
store.saveTaskCandidate({ candidateId: 'unknown-automatic-task', observationId: 'unknown-automatic-observation', summary: 'Reserve appointment', evidence: { start: 0, end: 1, text: 'Reserve appointment' }, extractorVersion: 'test', automation: { type: 'browser', capability: 'browser.commit', recipeId: 'fixture.reserve.v1', origin: 'https://example.com', inputs: {} } });
const unknownTask = store.listTasks({ includeDismissed: true }).find((task) => task.taskId === 'unknown-automatic-task');
const unknownGrant = store.createStandingGrant({ principal: 'signal-box-user', capability: 'browser.commit', surface: 'desktop', constraints: { recipeId: 'fixture.reserve.v1', origin: 'https://example.com' }, expiresAt: now + 60_000, policyVersion: 'single-user-1' });
store.createAutonomousRun({ grantId: unknownGrant.grantId, action: { taskId: unknownTask.taskId, capability: 'browser.commit', recipeId: 'fixture.reserve.v1' }, actionDigest: 'digest-unknown', status: 'unknown' });
assert.equal(decide(unknownTask).type, 'suggest_resolution');
assert.equal(decide(unknownTask).reason, 'automation-outcome-unknown');
const attention = service.enqueueAttentionNotifications([unknownTask], [decide(unknownTask)]);
assert.equal(attention.length, 1);
assert.equal(attention[0].notificationClass, 'assistant-attention');
assert.equal(service.enqueueAttentionNotifications([unknownTask], [decide(unknownTask)]).length, 0, 'attention notifications are deduplicated');
store.close();
console.log('proactivity tests passed');
