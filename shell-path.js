const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');

const run = promisify(execFile);

async function restoreShellPath({ platform = process.platform, env = process.env, home = os.homedir(), execute = run } = {}) {
  if (platform !== 'darwin') return;
  let shellPath = '';
  try {
    // Interactive login mode also loads PATH changes from .zshrc / nvm.
    // Delimit the value so shell startup banners cannot become PATH entries.
    const { stdout } = await execute(env.SHELL || '/bin/zsh', [
      '-ilc', 'printf "\\0SIGNAL_BOX_PATH\\0%s\\0" "$PATH"',
    ], { env, cwd: home, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    shellPath = stdout.split('\0SIGNAL_BOX_PATH\0')[1]?.split('\0')[0] || '';
  } catch (_) {
    // A broken or slow shell profile must not prevent the app from opening.
  }
  const fallback = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  env.PATH = [...new Set([
    ...shellPath.split(':'), ...(env.PATH || '').split(':'), ...fallback,
  ].filter((entry) => path.posix.isAbsolute(entry)))].join(':');
}

module.exports = { restoreShellPath };
