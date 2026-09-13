const fs = require('fs/promises');
const path = require('path');

// Run on the staged app after rebuilding/pruning, before archiving or signing.
async function preparePtyHelpers(buildPath) {
  const root = path.join(buildPath, 'node_modules', 'node-pty');
  let count = 0;
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && entry.name === 'spawn-helper') {
        await fs.chmod(filename, 0o755);
        count++;
      }
    }
  }
  await visit(root);
  if (!count) throw new Error('Cannot package macOS terminals: node-pty spawn-helper is missing.');
}

module.exports = { preparePtyHelpers };
