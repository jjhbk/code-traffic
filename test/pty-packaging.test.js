const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const asar = require('@electron/asar');
const config = require('../forge.config');
const { AutoUnpackNativesPlugin } = require('@electron-forge/plugin-auto-unpack-natives');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-pty-test-'));
  try {
    const staging = path.join(temp, 'app');
    const relative = 'node_modules/node-pty/prebuilds/darwin-arm64';
    const directory = path.join(staging, relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'spawn-helper'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    await fs.writeFile(path.join(directory, 'pty.node'), 'native fixture');
    const hook = promisify(config.packagerConfig.afterPrune[0]);
    await hook(staging, '44.3.0', 'darwin', 'arm64');
    await new AutoUnpackNativesPlugin().resolveForgeConfig(config);
    const archive = path.join(temp, 'app.asar');
    await asar.createPackageWithOptions(staging, archive, config.packagerConfig.asar);
    for (const name of ['spawn-helper', 'pty.node']) {
      const archiveEntry = path.join(relative, name);
      assert.equal(asar.statFile(archive, archiveEntry).unpacked, true);
      await fs.access(path.join(`${archive}.unpacked`, relative, name));
    }
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(`${archive}.unpacked`, relative, 'spawn-helper'))).mode & 0o777, 0o755);
    }
    await fs.unlink(path.join(directory, 'spawn-helper'));
    await assert.rejects(hook(staging, '44.3.0', 'darwin', 'arm64'), /spawn-helper is missing/);
    await hook(staging, '44.3.0', 'linux', 'x64');
    console.log('PTY packaging tests passed');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
