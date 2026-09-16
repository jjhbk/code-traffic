const fs = require('fs');
const path = require('path');

const required = [
  ['branding/signal-box.png', 'Linux/runtime icon'],
  ['branding/signal-box.ico', 'Windows installer icon'],
  ['branding/signal-box.icns', 'macOS application icon'],
];

for (const [relative, label] of required) {
  const filename = path.join(process.cwd(), relative);
  if (!fs.existsSync(filename) || fs.statSync(filename).size < 1024) throw new Error(`${label} is missing or too small: ${relative}`);
}

const forge = require('../forge.config');
if (forge.packagerConfig.appBundleId !== 'com.signalbox.desktop') throw new Error('Unexpected macOS bundle identifier.');
if (forge.packagerConfig.productName !== 'Signal Box') throw new Error('Unexpected packaged product name.');
console.log('Packaging assets and metadata are ready.');
