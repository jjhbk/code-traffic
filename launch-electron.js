const { spawn } = require('child_process');

const electron = require('electron');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const wsl = Boolean(environment.WSL_DISTRO_NAME);
const argumentsForElectron = [...(wsl ? ['--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'] : []), '.'];
const child = spawn(electron, argumentsForElectron, {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
