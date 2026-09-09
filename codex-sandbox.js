const { execFile } = require('child_process');
const { promisify } = require('util');

const runFile = promisify(execFile);

async function checkCodexSandbox(binary, cwd, env = process.env) {
  if (process.platform !== 'linux') return;
  try {
    // Use Codex's own helper selection and configured permissions. Check before
    // opening the TUI so a broken sandbox cannot become repeated approvals.
    await runFile(binary, ['sandbox', '--', '/bin/true'], {
      cwd, env, timeout: 15000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw new Error(`Codex could not start its Linux sandbox.\n\n${detail}\n\nIf this mentions bwrap, loopback, or user namespaces, check the Bubblewrap AppArmor profile (README: Codex permission errors). Changing approval settings will not repair sandbox startup.`);
  }
}

module.exports = { checkCodexSandbox };
