const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function findFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? findFiles(file, predicate) : predicate(file) ? [file] : [];
  });
}

function findDirectories(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (!entry.isDirectory()) return [];
    return predicate(file) ? [file] : findDirectories(file, predicate);
  });
}

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'make', '--', `--arch=${architecture}`]);

if (process.platform === 'linux') {
  const makeDirectory = path.join(root, 'out', 'make');
  const apt = spawnSync('sh', ['-c', 'command -v apt-get'], { encoding: 'utf8' }).status === 0;
  const packageManager = apt ? 'apt-get'
    : spawnSync('sh', ['-c', 'command -v dnf'], { encoding: 'utf8' }).status === 0 ? 'dnf' : 'yum';
  const packageFile = findFiles(makeDirectory, (file) => apt ? file.endsWith('.deb') : file.endsWith('.rpm'))[0];
  if (!packageFile) throw new Error(`No Linux ${apt ? '.deb' : '.rpm'} package was produced.`);
  const packageArguments = apt ? ['install', '--reinstall', '-y', packageFile] : ['install', '-y', packageFile];
  run('sudo', [packageManager, ...packageArguments]);
} else if (process.platform === 'darwin') {
  const zip = findFiles(path.join(root, 'out', 'make'), (file) => file.endsWith('.zip'))[0];
  if (!zip) throw new Error('No macOS .zip package was produced.');
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-'));
  try {
    run('ditto', ['-x', '-k', zip, temporaryDirectory]);
    const app = findDirectories(temporaryDirectory, (file) => file.endsWith('Signal Box.app'))[0];
    if (!app) throw new Error('The macOS package did not contain Signal Box.app.');
    run('ditto', [app, '/Applications/Signal Box.app']);
    run('open', ['/Applications/Signal Box.app']);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} else if (process.platform === 'win32') {
  const installer = findFiles(path.join(root, 'out', 'make'), (file) => file.endsWith('.exe'))[0];
  if (!installer) throw new Error('No Windows installer was produced.');
  run(installer, []);
} else {
  throw new Error(`Unsupported local installation platform: ${process.platform}`);
}

console.log('Signal Box local installation completed.');
