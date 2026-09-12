#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const commandMarker = 'codex-notify.js';

function nodeExecutable() {
  // Electron's process.execPath is the Electron binary, not a Node runtime.
  return process.env.npm_node_execpath || process.env.NODE || 'node';
}

function paths() {
  const home = os.homedir();
  const directory = process.env.CODEX_HOME || path.join(home, '.codex');
  return {
    directory,
    config: path.join(directory, 'config.toml'),
    backup: path.join(directory, 'config.toml.backup'),
  };
}

function command() { return JSON.stringify([nodeExecutable(), path.join(__dirname, 'codex-notify.js')]); }

function install() {
  const target = paths();
  fs.mkdirSync(target.directory, { recursive: true });
  const original = fs.existsSync(target.config) ? fs.readFileSync(target.config, 'utf8') : '';
  if (!fs.existsSync(target.backup)) fs.writeFileSync(target.backup, original);
  const lines = original.split(/\r?\n/).filter((line) => !/^\s*notify\s*=/.test(line) && !line.includes(commandMarker));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  // `notify` is a top-level Codex setting. Appending it after a TOML table
  // header would accidentally make it a member of that table (for example,
  // `tui.model_availability_nux.notify`) and Codex would reject the config.
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const insertAt = firstTable === -1 ? lines.length : firstTable;
  lines.splice(insertAt, 0, `notify = ${command()}`, '');
  fs.writeFileSync(target.config, `${lines.join('\n')}\n`);
}

function uninstall() {
  const target = paths();
  if (!fs.existsSync(target.config)) return;
  const lines = fs.readFileSync(target.config, 'utf8').split(/\r?\n/).filter((line) => !line.includes(commandMarker));
  fs.writeFileSync(target.config, lines.join('\n'));
}

function print() { process.stdout.write(`notify = ${command()}\n`); }

if (typeof module === 'undefined' || require.main === module) {
  const action = process.argv[2];
  try {
    if (action === '--install') install();
    else if (action === '--uninstall') uninstall();
    else if (action === '--print') print();
    else throw new Error('Usage: node codex-hooks.js --install | --uninstall | --print');
  } catch (error) {
    console.error(`Signal Box Codex hooks: ${error.message}`);
    process.exitCode = 1;
  }
}

if (typeof module !== 'undefined') module.exports = { install, uninstall, print, paths };
