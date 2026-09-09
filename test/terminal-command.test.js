const assert = require('assert');
const { cleanCommandOutput, runTerminalCommand } = require('../terminal-command');

assert.strictEqual(cleanCommandOutput('\x1b[31mred\x1b[0m\r\nclean\x00'), 'red\nclean');

(async () => {
  const platform = process.platform;
  const shell = platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  const command = platform === 'win32' ? 'echo terminal-output' : "printf 'terminal-output'";
  const result = await runTerminalCommand({ command, cwd: process.cwd(), shell, platform });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.output, 'terminal-output');
  assert.strictEqual(result.truncated, false);
  console.log('terminal command tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
