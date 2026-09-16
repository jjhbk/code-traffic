const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test'))
  .filter((file) => file.endsWith('.test.js'))
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(root, 'test', file)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`All ${files.length} Signal Box tests passed.`);
