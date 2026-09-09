const { spawn } = require('child_process');

function queueArgs(threadId, message) {
  if (!threadId) throw new Error('The Codex session does not have a valid thread ID yet.');
  if (!message) throw new Error('The Codex prompt is empty.');
  return ['queue', '--thread', threadId, '--message', message];
}

function queuePrompt({ binary, threadId, message, cwd, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, queueArgs(threadId, message), {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || `Codex queue exited with code ${code}.`));
    });
  });
}

module.exports = { queueArgs, queuePrompt };
