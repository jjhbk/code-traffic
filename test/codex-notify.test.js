const assert = require('assert');
const { stateFor } = require('../codex-notify');

assert.strictEqual(stateFor({ type: 'approval-requested' }), 'approval');
assert.strictEqual(stateFor({ type: 'agent-turn-complete', 'last-assistant-message': 'Which option should I use?' }), 'done');
assert.strictEqual(stateFor({ type: 'agent-turn-complete', last_assistant_message: 'Please provide your choice.' }), 'approval');
assert.strictEqual(stateFor({ type: 'agent-turn-complete', 'last-assistant-message': 'Implementation complete.' }), 'done');
assert.strictEqual(stateFor({ type: 'turn-start' }), 'working');
assert.strictEqual(stateFor({ type: 'token-count' }), 'working');

console.log('codex notification tests passed');
