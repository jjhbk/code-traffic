const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCodexSessionId } = require('../codex-sessions');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-codex-'));
const first = path.join(directory, 'first.jsonl');
const second = path.join(directory, 'nested', 'second.jsonl');
fs.mkdirSync(path.dirname(second), { recursive: true });
fs.writeFileSync(first, `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'first-id', cwd: '/project' } })}\n`);
fs.writeFileSync(second, `${JSON.stringify({ type: 'session_meta', payload: { session_id: 'second-id', cwd: '/project' } })}\n`);
const now = Date.now() / 1000;
fs.utimesSync(first, now - 10, now - 10);
fs.utimesSync(second, now, now);

assert.strictEqual(resolveCodexSessionId('first-id', '/project', directory), 'first-id');
assert.strictEqual(resolveCodexSessionId('missing-id', '/project', directory), 'second-id');
assert.strictEqual(resolveCodexSessionId(null, '/unknown', directory), null);

fs.rmSync(directory, { recursive: true });
console.log('codex session tests passed');
