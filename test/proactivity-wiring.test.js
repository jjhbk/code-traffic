const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ProactivityService } = require('../host/proactivity/service');

const store = new SqliteStore();
const service = new ProactivityService({ store });
const decisions = service.evaluate([
  { taskId: 'due', status: 'active', dueDate: 'today' },
  { taskId: 'unclear', status: 'active', confidence: 'low' },
]);
assert.deepEqual(decisions.map((item) => item.type), ['digest', 'clarify']);
assert.equal(decisions.find((item) => item.taskId === 'due').requiresApproval, false);
store.close();
console.log('proactivity wiring tests passed');
