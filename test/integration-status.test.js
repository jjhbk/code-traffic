const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { integrationStatus } = require('../host/integrations/status');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-integrations-'));
const claude = path.join(directory, 'settings.json');
const codex = path.join(directory, 'config.toml');
fs.writeFileSync(claude, '{"hooks":"127.0.0.1:4747/hook?state=working"}');
fs.writeFileSync(codex, 'notify = ["node", "codex-notify.js"]');
assert.deepEqual(integrationStatus({ claudeConfig: claude, codexConfig: codex, hookMarker: '127.0.0.1:4747/hook?state=' }), {
  claude: { configured: true, config: claude },
  codex: { configured: true, config: codex },
});
fs.writeFileSync(codex, 'model = "gpt"');
assert.equal(integrationStatus({ claudeConfig: claude, codexConfig: codex, hookMarker: '127.0.0.1:4747/hook?state=' }).codex.configured, false);
fs.rmSync(directory, { recursive: true });
console.log('integration status tests passed');
