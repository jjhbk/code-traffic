const fs = require('fs');
const path = require('path');

const outputRoot = path.resolve(process.argv[2] || path.join(process.cwd(), 'out'));

function findPackagedRoots(directory) {
  if (!fs.existsSync(directory)) return [];
  const roots = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(candidate, 'resources'))) roots.push(candidate);
    else roots.push(...findPackagedRoots(candidate));
  }
  return roots;
}

const roots = findPackagedRoots(outputRoot);
if (!roots.length) throw new Error(`No packaged application directory with resources found under ${outputRoot}.`);
for (const root of roots) {
  for (const relative of ['resources/browser-extension/manifest.json', 'resources/codex-notify.js']) {
    const filename = path.join(root, relative);
    if (!fs.existsSync(filename) || fs.statSync(filename).size === 0) throw new Error(`Packaged resource is missing: ${filename}`);
  }
}
console.log(`Packaged resource checks passed for ${roots.length} application${roots.length === 1 ? '' : 's'}.`);
