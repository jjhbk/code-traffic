const assert = require('node:assert/strict');
const { Board } = require('../board');

let now = 1000;
const board = new Board({
  clock: () => now,
  liveness: { softLimitMs: 10, hardLimitMs: 20 },
});
board.register('owned', '/tmp/project', 'claude');
board.handleHook('working', 'owned', { cwd: '/tmp/project' });
assert.equal(board.sessions.get('owned').liveness, 'healthy');

now += 11;
const stale = board.checkLiveness();
assert.equal(board.sessions.get('owned').liveness, 'stale');
assert.equal(stale.at(-1).escalation, undefined);

now += 10;
const hard = board.checkLiveness();
assert.equal(board.sessions.get('owned').liveness, 'unknown');
assert.equal(hard.at(-1).escalation, true);
assert.equal(board.checkLiveness().length, 0, 'hard escalation is emitted once per stale episode');

board.handleHook('working', 'owned', { cwd: '/tmp/project' });
assert.equal(board.sessions.get('owned').liveness, 'healthy');
assert.equal(board.sessions.get('owned').hardEscalationAt, null);
board.processExited('owned', { code: 1, signal: null });
assert.equal(board.sessions.get('owned').processStatus, 'exited');
assert.equal(board.sessions.get('owned').liveness, 'unknown');
assert.equal(board.recordDelivery('owned', 'submitted', { requestId: 'r1' }), true);
assert.equal(board.sessions.get('owned').delivery.status, 'submitted');
console.log('phase A tests passed');
