const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');

let now = 10_000;
const store = new SqliteStore({ clock: () => now });
const person = store.upsertContext({ recordType: 'person', recordKey: 'alex@example.com', value: { name: 'Alex' }, source: { observationId: 'mail-1' }, confidence: 'medium' });
assert.equal(person.confirmed, false);
assert.deepEqual(store.getContext('person', 'alex@example.com').value, { name: 'Alex' });
store.upsertContext({ recordType: 'preference', recordKey: 'follow-up-window', value: { hours: 48 }, confirmed: true, confidence: 'high', source: { channel: 'desktop' } });
assert.equal(store.listContext({ recordType: 'preference' })[0].confirmed, true);
store.upsertContext({ recordType: 'fact', recordKey: 'temporary', value: true, validUntil: now + 100, source: { test: true } });
now += 101;
assert.equal(store.getContext('fact', 'temporary'), null);
assert.equal(store.listContext({ includeExpired: true }).length, 3);
assert.equal(store.deleteContext('person', 'alex@example.com'), true);
assert.equal(store.getContext('person', 'alex@example.com'), null);
assert.equal(store.exportData().data.context_records.length, 2);
store.close();
console.log('context store tests passed');
