const assert = require('node:assert/strict');
const { DEFAULTS, livenessFor } = require('../liveness');

const session = { state: 'working', since: 1000, lastObservedAt: 1000 };
assert.equal(livenessFor(session, 1000).status, 'healthy');
assert.equal(livenessFor(session, 1000 + DEFAULTS.softLimitMs).status, 'stale');
assert.equal(livenessFor(session, 1000 + DEFAULTS.hardLimitMs).status, 'unknown');
assert.equal(livenessFor({ ...session, state: 'done' }, 1000 + DEFAULTS.hardLimitMs).status, 'inactive');
console.log('liveness tests passed');
