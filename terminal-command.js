const { spawn } = require('child_process');

function cleanCommandOutput(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
}

function runTerminalCommand({ command, cwd, shell, platform = process.platform, env = process.env, onSpawn, maxOutput = 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const args = platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    const child = spawn(shell, args, {
      cwd,
      env,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child);

    let output = '';
    let truncated = false;
    const append = (chunk) => {
      const remaining = maxOutput - output.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = String(chunk);
      output += text.slice(0, remaining);
      if (text.length > remaining) truncated = true;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      output: cleanCommandOutput(output),
      code,
      signal,
      truncated,
    }));
  });
}

module.exports = { cleanCommandOutput, runTerminalCommand };
