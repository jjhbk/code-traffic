const assert = require('assert');
const { EventEmitter } = require('events');
const { queueArgs, queuePrompt } = require('../codex-control');

assert.deepStrictEqual(queueArgs('thread-1', 'fix it'), ['queue', '--thread', 'thread-1', '--message', 'fix it']);
assert.throws(() => queueArgs('', 'fix it'), /thread ID/);

(async () => {
  let invocation;
  const spawnImpl = (binary, args, options) => {
    invocation = { binary, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  };
  await queuePrompt({ binary: '/bin/codex', threadId: 'thread-1', message: 'fix it', cwd: '/workspace', spawnImpl });
  assert.strictEqual(invocation.binary, '/bin/codex');
  assert.deepStrictEqual(invocation.args, ['queue', '--thread', 'thread-1', '--message', 'fix it']);
  assert.strictEqual(invocation.options.cwd, '/workspace');
  console.log('codex control tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
