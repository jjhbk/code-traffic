const assert = require('node:assert/strict');
const { resolveDueAt } = require('../host/tasks/dates');

const spring = resolveDueAt('tomorrow', '2026-03-07T12:00:00-05:00', 'America/New_York');
assert.equal(new Date(spring).toISOString(), '2026-03-09T03:59:59.999Z');

const friday = resolveDueAt('friday', '2026-09-18T10:00:00-04:00', 'America/New_York');
assert.equal(new Date(friday).toISOString(), '2026-09-19T03:59:59.999Z');

assert.equal(resolveDueAt('next week', '2026-09-17T10:00:00Z', 'UTC'), null);
console.log('task date tests passed');
