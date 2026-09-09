const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const wsl = Boolean(environment.WSL_DISTRO_NAME);
const sandboxHelperPath = path.join(path.dirname(electron), 'chrome-sandbox');

function needsNoSandbox() {
  if (process.platform !== 'linux') return false;
  if (wsl) return true;

  try {
    const stats = fs.statSync(sandboxHelperPath);
    const hasSetuidBit = Boolean(stats.mode & 0o4000);
    return stats.uid !== 0 || !hasSetuidBit;
  } catch {
    return true;
  }
}

const noSandbox = needsNoSandbox();
if (noSandbox && !wsl) {
  console.warn(
    `Electron sandbox helper is not configured at ${sandboxHelperPath}; launching with --no-sandbox.`
  );
}
if (noSandbox) {
  environment.SIGNAL_BOX_NO_SANDBOX = '1';
}

const argumentsForElectron = [
  ...(noSandbox ? ['--no-sandbox'] : []),
  ...(wsl ? ['--disable-gpu', '--disable-gpu-compositing'] : []),
  '.',
];
const child = spawn(electron, argumentsForElectron, {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
