const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ProactivityService } = require('../host/proactivity/service');

let now = 100_000;
const store = new SqliteStore({ clock: () => now });
const service = new ProactivityService({ store, followUpAfterMs: 1_000 });
const decide = (task) => service.decide(task, { now });
assert.equal(decide({ taskId: 'a', status: 'active', dueDate: 'today' }).type, 'digest');
assert.equal(decide({ taskId: 'b', status: 'active', confidence: 'low' }).type, 'clarify');
assert.equal(decide({ taskId: 'c', status: 'active', owner: 'counterparty', blocker: 'self', updatedAt: now - 2_000, counterparty: 'alex@example.com' }).type, 'draft_follow_up');
store.setSuppression('counterparty', 'alex@example.com');
assert.equal(decide({ taskId: 'c', status: 'active', owner: 'counterparty', blocker: 'self', updatedAt: now - 2_000, counterparty: 'alex@example.com' }).type, 'wait');
assert.equal(decide({ taskId: 'd', status: 'snoozed', snoozedUntil: now + 100 }).reason, 'task-snoozed');
store.close();
console.log('proactivity tests passed');
