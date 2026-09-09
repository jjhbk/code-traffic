#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

function port() {
  const value = Number.parseInt(process.env.SIGNAL_BOX_PORT || '4747', 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 4747;
}

function marker() { return `127.0.0.1:${port()}/hook?state=`; }

function settingsPaths() {
  const home = os.homedir();
  const directory = path.join(home, '.claude');
  return {
    directory,
    settings: path.join(directory, 'settings.json'),
    backup: path.join(directory, 'settings.json.backup'),
  };
}

function hookCommand(state) {
  return `curl -sS -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:${port()}/hook?state=${state}&tile=$SIGNAL_TILE" >/dev/null 2>&1 || true`;
}

function ours(entry) {
  return entry && typeof entry.command === 'string' && entry.command.includes(marker());
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${file} as JSON; no changes were made.`);
  }
}

function ourHooks() {
  const command = (state) => ({
    hooks: [{ type: 'command', async: true, command: hookCommand(state) }],
  });

  return {
    UserPromptSubmit: [command('working')],
    PermissionRequest: [command('approval')],
    Notification: [{
      matcher: 'permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog',
      hooks: [{ type: 'command', async: true, command: hookCommand('approval') }],
    }],
    Stop: [command('done')],
    StopFailure: [command('done')],
    SessionEnd: [command('closed')],
  };
}

function removeOurHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') return;

  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return true;
      entry.hooks = entry.hooks.filter((handler) => !ours(handler));
      return entry.hooks.length > 0;
    });

    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
}

function install() {
  const paths = settingsPaths();
  const settings = readSettings(paths.settings);
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${paths.settings} must contain a JSON object; no changes were made.`);
  }

  fs.mkdirSync(paths.directory, { recursive: true });
  if (fs.existsSync(paths.settings) && !fs.existsSync(paths.backup)) {
    fs.copyFileSync(paths.settings, paths.backup);
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  removeOurHooks(settings.hooks);
  for (const [event, entries] of Object.entries(ourHooks())) {
    settings.hooks[event] = [...(settings.hooks[event] || []), ...entries];
  }
  fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
}

function uninstall() {
  const paths = settingsPaths();
  if (!fs.existsSync(paths.settings)) return;
  const settings = readSettings(paths.settings);
  if (settings.hooks) removeOurHooks(settings.hooks);
  fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);
}

function printHooks() {
  process.stdout.write(`${JSON.stringify(ourHooks(), null, 2)}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === '--install') install();
  else if (command === '--uninstall') uninstall();
  else if (command === '--print') printHooks();
  else {
    console.error('Usage: node hooks.js --install | --uninstall | --print');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Signal Box: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { hookCommand, ourHooks, removeOurHooks, settingsPaths };
