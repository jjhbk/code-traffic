const fs = require('fs');
const path = require('path');

function settingsPath(userDataPath) { return path.join(userDataPath, 'settings.json'); }

function readSettings(userDataPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath(userDataPath), 'utf8'));
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  } catch (_) { return {}; }
}

function writeSettings(userDataPath, settings) {
  const file = settingsPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

module.exports = { readSettings, writeSettings };
