const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const STATES = new Set(['working', 'approval', 'done', 'closed']);

function displayPath(cwd) {
  const home = os.homedir();
  return cwd === home ? '~' : cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
}

function sessionDetails(key, tile, sessionId, cwd, owned, agent = null) {
  const now = Date.now();
  return {
    key,
    tile: tile || null,
    sessionId: sessionId || null,
    project: cwd ? path.basename(cwd) : 'Unknown project',
    path: cwd ? displayPath(cwd) : '',
    cwd: cwd || '',
    state: null,
    since: now,
    created: now,
    owned: Boolean(owned),
    agent,
  };
}

class Board extends EventEmitter {
  constructor({ storagePath = null } = {}) {
    super();
    this.storagePath = storagePath;
    this.sessions = new Map();
    this.restore();
  }

  restore() {
    if (!this.storagePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      if (!Array.isArray(saved)) return;
      for (const record of saved) {
        if (!record || !record.key || !record.cwd) continue;
        this.sessions.set(record.key, {
          ...record,
          tile: record.tile || null,
          owned: Boolean(record.owned),
          state: record.state || null,
          agent: record.agent || null,
        });
      }
    } catch (_) { /* A missing or corrupt cache must not prevent startup. */ }
  }

  persist() {
    if (!this.storagePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.list(), null, 2));
    } catch (_) { /* Persistence is best effort. */ }
  }

  register(tile, cwd, agent = null) {
    if (!tile) throw new Error('A tile id is required');
    const existing = this.sessions.get(tile);
    if (existing) return existing;
    const session = sessionDetails(tile, tile, null, cwd, true, agent);
    this.sessions.set(tile, session);
    this.persist();
    this.emit('change');
    return session;
  }

  registerExternal(key, cwd, agent = null) {
    if (!key || this.sessions.has(key)) return this.sessions.get(key);
    const existing = [...this.sessions.values()].find((session) => !session.owned && session.cwd === cwd);
    if (existing) return existing;
    const session = sessionDetails(key, null, null, cwd, false, agent);
    this.sessions.set(key, session);
    this.persist();
    this.emit('change', { key, state: null });
    return session;
  }

  reopen(tile) {
    const session = this.sessions.get(tile);
    if (!session) return null;
    session.owned = true;
    this.persist();
    // Reopening from the UI is navigation, not a new agent event. The
    // renderer uses this marker to avoid playing a notification sound.
    this.emit('change', { key: tile, state: session.state, navigation: true });
    return session;
  }

  list() {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  close(tile) {
    const session = this.sessions.get(tile);
    if (!session) return false;
    this.sessions.delete(tile);
    this.persist();
    this.emit('change');
    return true;
  }

  handleHook(state, tile, payload) {
    if (!STATES.has(state)) return;
    const sessionId = payload && typeof payload.session_id === 'string' ? payload.session_id : null;
    const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : '';
    const key = tile || sessionId;
    if (!key) return;

    let session = this.sessions.get(key);
    if (!session && !tile && cwd) {
      const matched = [...this.sessions.values()].find((candidate) => !candidate.owned && !candidate.sessionId && candidate.cwd === cwd);
      if (matched) {
        this.sessions.delete(matched.key);
        matched.key = key;
        matched.sessionId = sessionId;
        this.sessions.set(key, matched);
        this.persist();
        session = matched;
      }
    }
    if (!session) {
      if (state === 'closed') return;
      session = sessionDetails(key, tile || null, sessionId, cwd, false);
      session.state = state;
      this.sessions.set(key, session);
      this.persist();
      this.emit('change', { key, state });
    } else {
      if (sessionId) session.sessionId = sessionId;
      if (cwd && !session.cwd) {
        session.cwd = cwd;
        session.project = path.basename(cwd);
        session.path = displayPath(cwd);
      }
      const nextState = state === 'closed' ? null : state;
      if (session.state !== nextState) {
        session.state = nextState;
        session.since = Date.now();
        this.persist();
        this.emit('change', { key, state: nextState });
      } else {
        this.emit('change');
      }
    }
  }

  listen(port = 4747, host = '127.0.0.1') {
    this.server = http.createServer((request, response) => {
      if (request.method !== 'POST' || request.url.split('?')[0] !== '/hook') {
        response.writeHead(404);
        response.end();
        return;
      }

      const url = new URL(request.url, `http://${host}`);
      const state = url.searchParams.get('state');
      const tile = url.searchParams.get('tile') || null;
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      response.writeHead(200);
      response.end();
      request.on('end', () => {
        let payload = {};
        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
          } catch (_) {
            payload = {};
          }
        }
        this.handleHook(state, tile, payload);
      });
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => resolve(this.server));
    });
  }

  closeServer() {
    return this.server ? new Promise((resolve) => this.server.close(resolve)) : Promise.resolve();
  }
}

module.exports = { Board, displayPath };
