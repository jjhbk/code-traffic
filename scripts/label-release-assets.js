const fs = require('fs');
const path = require('path');

const architecture = process.argv[2];
if (!architecture) throw new Error('Usage: node scripts/label-release-assets.js <architecture>');

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

for (const file of files(path.join(process.cwd(), 'out', 'make'))) {
  const extension = path.extname(file);
  const target = `${file.slice(0, -extension.length)}-${architecture}${extension}`;
  fs.renameSync(file, target);
}
