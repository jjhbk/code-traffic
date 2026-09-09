const assert = require('assert');
const { startCodexMonitor, terminalApprovalQuestion } = require('../codex-monitor');

const terminalQuestion = terminalApprovalQuestion('Would you like to run the following command?\n$ sudo apt-get install -y golang-go\nPress enter to confirm or esc to cancel');
assert.strictEqual(terminalQuestion.options[0].keys, 'y\r');
assert.strictEqual(terminalQuestion.options[2].keys, '\x1b');

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
