const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'browser-extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const file of ['background.js', 'content.js', 'options.html', 'options.js']) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing browser extension file: ${file}`);
}
if (manifest.manifest_version !== 3 || !manifest.background?.service_worker) throw new Error('Browser extension must use a Manifest V3 service worker.');
if (!manifest.host_permissions.includes('http://127.0.0.1/*')) throw new Error('Browser extension must allow the local Signal Box bridge on configured loopback ports.');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
if (!background.includes('X-Signal-Box-Token') || !background.includes('/browser/next') || !background.includes('/browser/result')) {
  throw new Error('Browser extension must use authenticated bridge request/result transport.');
}
if (!background.includes('chrome.tabs.update') || !background.includes('Navigation target is not allowlisted') || !background.includes('stepMatchesTab') || !background.includes('The browser tab is no longer on the recipe origin')) {
  throw new Error('Browser extension must enforce allowlisted navigation.');
}
console.log('browser extension package checks passed');
