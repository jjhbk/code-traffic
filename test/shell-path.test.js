const assert = require('node:assert/strict');
const { restoreShellPath } = require('../shell-path');

async function main() {
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', KEEP: 'unchanged' };
  await restoreShellPath({ platform: 'darwin', env, home: '/Users/test', execute: async (shell, args, options) => {
    assert.equal(shell, '/bin/zsh');
    assert.equal(args[0], '-ilc');
    assert.equal(options.timeout, 5000);
    return { stdout: 'Welcome!\n\0SIGNAL_BOX_PATH\0/Users/test/.nvm/versions/node/v22/bin:/custom path/bin:/usr/bin\0\nGoodbye!' };
  } });
  assert.equal(env.PATH.split(':')[0], '/Users/test/.nvm/versions/node/v22/bin');
  assert.ok(env.PATH.includes('/custom path/bin'));
  assert.ok(env.PATH.includes('/Users/test/.local/bin'));
  assert.ok(env.PATH.includes('/opt/homebrew/bin'));
  assert.ok(!env.PATH.includes('Welcome'));
  assert.ok(!env.PATH.includes('Goodbye'));
  assert.equal(env.PATH.split(':').filter((entry) => entry === '/usr/bin').length, 1);
  assert.equal(env.KEEP, 'unchanged');

  for (const execute of [async () => { throw new Error('timeout'); }, async () => ({ stdout: 'banner only' })]) {
    const fallbackEnv = { PATH: '/existing/bin' };
    await restoreShellPath({ platform: 'darwin', env: fallbackEnv, home: '/Users/test', execute });
    assert.ok(fallbackEnv.PATH.startsWith('/existing/bin:'));
    assert.ok(fallbackEnv.PATH.includes('/usr/local/bin'));
  }
  const untouched = { PATH: 'original' };
  await restoreShellPath({ platform: 'win32', env: untouched, execute: () => { throw new Error('Must not run'); } });
  assert.equal(untouched.PATH, 'original');
  console.log('Shell PATH tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
