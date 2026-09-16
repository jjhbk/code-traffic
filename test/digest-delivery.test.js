const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');

const store = new SqliteStore();
const created = store.reserveDigest({ dateKey: '2026-09-16', items: [{ taskId: 't1', summary: 'Send update', reasons: ['due today'] }], cap: 5 });
const claimed = store.claimNotification();
assert.equal(claimed.notificationId, created.notificationId);
assert.equal(store.claimNotification(), null);
assert.equal(store.completeNotification(claimed.notificationId, 'sent', { channel: 'test' }).status, 'sent');
assert.equal(store.claimNotification(), null);
store.close();
console.log('digest delivery tests passed');
