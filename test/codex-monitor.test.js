const assert = require('assert');
const { startCodexMonitor } = require('../codex-monitor');

const session = { key: 'codex-1', tile: 'codex-1', agent: 'codex', state: 'working' };
let pending = [{ question: 'Which option?', options: [{ label: 'A' }] }];
const approvals = [];
const stop = startCodexMonitor({
  listSessions: () => [session],
  getHistory: () => ({ pendingQuestions: pending }),
  onApproval: (value) => approvals.push(value.tile),
  intervalMs: 10,
});

setTimeout(() => {
  assert.deepStrictEqual(approvals, ['codex-1']);
  session.state = 'approval';
  pending = [];
  setTimeout(() => {
    pending = [{ question: 'A second question?', options: [] }];
    setTimeout(() => {
      stop();
      assert.deepStrictEqual(approvals, ['codex-1', 'codex-1']);
      console.log('codex monitor tests passed');
    }, 25);
  }, 25);
}, 25);
