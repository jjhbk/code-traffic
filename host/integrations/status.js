const fs = require('fs');

function contains(file, marker) {
  if (!file || !marker) return false;
  try { return fs.readFileSync(file, 'utf8').includes(marker); } catch (_) { return false; }
}

function integrationStatus({ claudeConfig, codexConfig, hookMarker = '', codexMarker = 'codex-notify.js' } = {}) {
  return {
    claude: { configured: contains(claudeConfig, hookMarker), config: claudeConfig || null },
    codex: { configured: contains(codexConfig, codexMarker), config: codexConfig || null },
  };
}

module.exports = { contains, integrationStatus };
