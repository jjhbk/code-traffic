#!/usr/bin/env node

const http = require('http');

function port() {
  const value = Number.parseInt(process.env.SIGNAL_BOX_PORT || '4747', 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 4747;
}

function payloadFromArgs() {
  const args = process.argv.slice(2);
  for (let index = args.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(args[index]);
      if (value && typeof value === 'object') return value;
    } catch (_) { /* Codex may pass human-readable arguments before its JSON payload. */ }
  }
  return {};
}

function stateFor(payload) {
  const type = String(
    payload.type || payload.event || payload.name || payload.notification || payload.kind || payload.status || '',
  ).toLowerCase().replace(/[_\s]+/g, '-');
  if (type.includes('approval') || type.includes('permission') || type.includes('request-user-input') || type.includes('input-required') || type.includes('needs-input')) return 'approval';
  if (type.includes('start') || type.includes('begin') || type.includes('turn-start') || type.includes('working')) return 'working';
  return 'done';
}

function notify() {
  const payload = payloadFromArgs();
  const state = stateFor(payload);
  const cwd = payload.cwd || payload['working-directory'] || payload.working_directory || process.cwd();
  const sessionId = payload['thread-id'] || payload.thread_id || payload.threadId || payload.session_id || payload.sessionId
    || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || `codex:${cwd}`;
  const query = new URLSearchParams({ state, tile: process.env.SIGNAL_TILE || '' });
  const request = http.request({ hostname: '127.0.0.1', port: port(), path: `/hook?${query}`, method: 'POST', headers: { 'Content-Type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ session_id: sessionId, cwd }));
}

notify();
