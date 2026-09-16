const assert = require('assert');
const { CLAUDE_SAFE_TOOLS, sessionArgs } = require('../session-command');

assert.deepStrictEqual(sessionArgs('claude', null, false), ['--allowed-tools', ...CLAUDE_SAFE_TOOLS]);
assert.deepStrictEqual(sessionArgs('codex', null, false), ['-a', 'never', '-c', 'disable_paste_burst=true']);
assert.deepStrictEqual(sessionArgs('claude', 'claude-id', true), ['--allowed-tools', ...CLAUDE_SAFE_TOOLS, '--resume', 'claude-id']);
assert.deepStrictEqual(sessionArgs('codex', 'codex-id', true), ['resume', '-a', 'never', '-c', 'disable_paste_burst=true', 'codex-id']);
assert.deepStrictEqual(sessionArgs('claude', null, true), ['--allowed-tools', ...CLAUDE_SAFE_TOOLS, '--continue']);
assert.deepStrictEqual(sessionArgs('codex', null, true), ['resume', '-a', 'never', '-c', 'disable_paste_burst=true', '--last']);
assert.deepStrictEqual(sessionArgs('codex', 'codex:/tmp/project', true), ['resume', '-a', 'never', '-c', 'disable_paste_burst=true', '--last']);
assert.deepStrictEqual(sessionArgs('terminal', null, false), []);
assert.deepStrictEqual(sessionArgs('terminal', 'ignored', true), []);

console.log('session command tests passed');
