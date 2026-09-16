const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');

const store = new SqliteStore();
store.setSuppression('counterparty', 'client@example.com', null, 'user');
assert.equal(store.listSuppressions()[0].scopeKey, 'client@example.com');
store.recordNotificationFeedback('n1', false, { channel: 'test' });
assert.equal(store.notificationStats().feedback.notUseful, 1);
assert.equal(store.listNotifications().length, 0);
store.removeSuppression('counterparty', 'client@example.com');
assert.equal(store.listSuppressions().length, 0);
store.close();
console.log('feedback tests passed');
