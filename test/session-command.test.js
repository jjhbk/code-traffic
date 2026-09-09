const assert = require('assert');
const { sessionArgs } = require('../session-command');

assert.deepStrictEqual(sessionArgs('claude', null, false), []);
assert.deepStrictEqual(sessionArgs('codex', null, false), ['-c', 'disable_paste_burst=true']);
assert.deepStrictEqual(sessionArgs('claude', 'claude-id', true), ['--resume', 'claude-id']);
assert.deepStrictEqual(sessionArgs('codex', 'codex-id', true), ['resume', '-c', 'disable_paste_burst=true', 'codex-id']);
assert.deepStrictEqual(sessionArgs('claude', null, true), ['--continue']);
assert.deepStrictEqual(sessionArgs('codex', null, true), ['resume', '-c', 'disable_paste_burst=true', '--last']);
assert.deepStrictEqual(sessionArgs('codex', 'codex:/tmp/project', true), ['resume', '-c', 'disable_paste_burst=true', '--last']);
assert.deepStrictEqual(sessionArgs('terminal', null, false), []);
assert.deepStrictEqual(sessionArgs('terminal', 'ignored', true), []);

console.log('session command tests passed');
