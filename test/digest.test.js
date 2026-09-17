const assert = require('node:assert/strict');
const { DigestScheduler, dateKey } = require('../host/scheduling/digest');
const { SqliteStore } = require('../host/store/sqlite-store');

const store = new SqliteStore();
const scheduler = new DigestScheduler({ store, timeZone: 'America/New_York', dailyCap: 2, cadenceMinutes: 0, clock: () => Date.parse('2026-09-16T13:00:00Z') });
assert.equal(dateKey(Date.parse('2026-09-16T13:00:00Z'), 'America/New_York'), '2026-09-16');
const tasks = [
  { taskId: 'later', summary: 'Later', status: 'active', dueDate: 'friday', owner: 'counterparty' },
  { taskId: 'today', summary: 'Today', status: 'active', dueDate: 'today', owner: 'self' },
  { taskId: 'tomorrow', summary: 'Tomorrow', status: 'active', dueDate: 'tomorrow', owner: 'self' },
];
const first = scheduler.prepare(tasks);
assert.deepEqual(first.items.map((item) => item.taskId), ['today', 'tomorrow']);
assert.equal(scheduler.prepare(tasks), null, 'daily cap prevents a second digest reservation');
const deadlineStore = new SqliteStore();
const deadlineNow = Date.parse('2026-09-16T13:00:00Z');
const deadlineScheduler = new DigestScheduler({ store: deadlineStore, timeZone: 'America/New_York', dailyCap: 1, cadenceMinutes: 0, clock: () => deadlineNow });
const deadlineDigest = deadlineScheduler.prepare([{ taskId: 'deadline', summary: 'Deadline', status: 'active', dueDate: 'friday', dueAt: deadlineNow + 2 * 60 * 60 * 1000 }]);
assert.equal(deadlineDigest.items[0].taskId, 'deadline');
assert.equal(deadlineDigest.items[0].reasons[0], 'due within 24 hours');
deadlineStore.close();
const quiet = new DigestScheduler({ store, timeZone: 'America/New_York', quietStart: '21:00', quietEnd: '07:00', clock: () => Date.parse('2026-09-16T02:00:00Z') });
assert.equal(quiet.isQuiet(), true);
assert.equal(quiet.prepare(tasks), null);
store.setSuppression('counterparty', 'client@example.com');
assert.equal(scheduler.prepare([{ taskId: 'suppressed', summary: 'Suppressed', status: 'active', owner: 'self', counterparty: 'client@example.com' }]), null);
const scheduledStore = new SqliteStore();
const scheduled = new DigestScheduler({ store: scheduledStore, timeZone: 'America/New_York', digestAt: '08:30', cadenceMinutes: 0, clock: () => Date.parse('2026-09-16T13:00:00Z') });
assert.equal(scheduled.isDue(), true);
assert.equal(scheduled.isScheduledDue(), true);
assert.equal(scheduled.prepareScheduled([{ taskId: 'scheduled', summary: 'Scheduled', status: 'active', dueDate: 'today', owner: 'self' }]).items[0].taskId, 'scheduled');
assert.equal(scheduled.isScheduledDue(), false);
assert.equal(scheduled.prepareScheduled([{ taskId: 'scheduled-2', summary: 'Second', status: 'active', owner: 'self' }]), null, 'scheduled digest is reserved once per day');
scheduledStore.close();
const intervalStore = new SqliteStore();
let intervalNow = Date.parse('2026-09-16T13:00:00Z');
const hourly = new DigestScheduler({ store: intervalStore, timeZone: 'America/New_York', dailyCap: 2, cadenceMinutes: 60, clock: () => intervalNow });
assert.equal(hourly.prepareScheduled([{ taskId: 'hour-1', summary: 'Hourly', status: 'active', owner: 'self' }]).items[0].taskId, 'hour-1');
assert.equal(hourly.prepareScheduled([{ taskId: 'hour-2', summary: 'Same slot', status: 'active', owner: 'self' }]), null, 'interval digest is reserved once per slot');
intervalNow += 60 * 60 * 1000;
assert.equal(hourly.prepareScheduled([{ taskId: 'hour-3', summary: 'Next hour', status: 'active', owner: 'self' }]).items[0].taskId, 'hour-3');
assert.equal(intervalStore.reserveDigest({ dateKey: 'manual', budgetDateKey: '2026-09-16', items: [{ taskId: 'cap-1' }], cap: 5 }), null, 'daily cap applies across interval slots');
intervalStore.close();
store.close();
console.log('digest tests passed');
