const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCodexSessionId } = require('../codex-sessions');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-codex-'));
const first = path.join(directory, 'first.jsonl');
const second = path.join(directory, 'nested', 'second.jsonl');
const project = path.join(directory, 'project');
const alias = path.join(directory, 'project-link');
fs.mkdirSync(path.dirname(second), { recursive: true });
fs.mkdirSync(project);
fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(first, `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'first-id', cwd: '/project' } })}\n`);
fs.writeFileSync(second, `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'second-id', cwd: '/project' } })}\n`);
fs.writeFileSync(path.join(directory, 'linked.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'linked-id', cwd: project } })}\n`);
const now = Date.now() / 1000;
fs.utimesSync(first, now - 10, now - 10);
fs.utimesSync(second, now, now);

assert.strictEqual(resolveCodexSessionId('first-id', '/project', directory), 'first-id');
assert.strictEqual(resolveCodexSessionId('missing-id', '/project', directory), null);
assert.strictEqual(resolveCodexSessionId(null, '/project', directory), null);
assert.strictEqual(resolveCodexSessionId('first-id', '/other-project', directory), null);
assert.strictEqual(resolveCodexSessionId(null, '/unknown', directory), null);
assert.strictEqual(resolveCodexSessionId('linked-id', project, directory), 'linked-id');
assert.strictEqual(resolveCodexSessionId('linked-id', alias, directory), 'linked-id');
assert.strictEqual(resolveCodexSessionId('linked-id', '/other-project', directory), null);

fs.rmSync(directory, { recursive: true });
console.log('codex session tests passed');
