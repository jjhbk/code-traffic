const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { resolveCodexSessionId, findUniqueCodexSessionSince } = require('./codex-sessions');
const { DEFAULTS: LIVENESS_DEFAULTS, livenessFor } = require('./liveness');
const { normalizeEvent } = require('./host/events/event-contract');

const STATES = new Set(['working', 'approval', 'done', 'closed']);

function displayPath(cwd) {
  const home = os.homedir();
  return cwd === home ? '~' : cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
}

function permissionQuestion(payload) {
  const tool = payload?.tool_name || payload?.toolName || payload?.name || 'an operation';
  const rawInput = payload?.tool_input || payload?.toolInput || payload?.input;
  let detail = '';
  if (typeof rawInput === 'string') detail = rawInput;
  else if (rawInput && typeof rawInput === 'object') detail = rawInput.command || rawInput.cmd || JSON.stringify(rawInput);
  if (detail.length > 700) detail = `${detail.slice(0, 697)}...`;
  const suggestions = payload?.permission_suggestions || payload?.permissionSuggestions;
  const options = Array.isArray(suggestions) && suggestions.length
    ? suggestions.map((suggestion, index) => {
      const rawLabel = suggestion?.label || suggestion?.name || suggestion?.type || suggestion?.behavior || `Option ${index + 1}`;
      const label = String(rawLabel).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
      return {
        label: label.charAt(0).toUpperCase() + label.slice(1),
        description: suggestion?.description || suggestion?.prompt || '',
        keys: `${'\x1b[B'.repeat(index)}\r`,
      };
    })
    : [
      { label: 'Allow once', description: 'Allow this request once.', keys: '\r' },
      { label: 'Always allow', description: 'Allow future matching requests.', keys: '\x1b[B\r' },
      { label: 'Deny', description: 'Reject this request.', keys: '\x1b[B\x1b[B\r' },
    ];
  return {
    header: 'Permission required',
    question: `Claude wants permission to use ${tool}${detail ? `:\n${detail}` : '.'}`,
    options,
  };
}

function userQuestionsFromHook(payload) {
  const input = payload?.tool_input || payload?.toolInput || payload?.input || payload;
  const questions = input?.questions;
  if (String(payload?.tool_name || payload?.toolName || payload?.name || '').toLowerCase() !== 'askuserquestion'
    || !Array.isArray(questions)) return null;
  return questions.map((question) => ({
    id: question.id || null,
    header: question.header || '',
    question: question.question || '',
    multiSelect: Boolean(question.multiSelect),
    options: Array.isArray(question.options) ? question.options.map((option) => ({
      label: option.label || '',
      description: option.description || '',
    })).filter((option) => option.label) : [],
  })).filter((question) => question.question);
}

function sessionDetails(key, tile, sessionId, cwd, owned, agent = null, now = Date.now()) {
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
    lastObservedAt: now,
    liveness: 'inactive',
    livenessLevel: null,
    hardEscalationAt: null,
    processStatus: owned ? 'starting' : 'unknown',
    delivery: null,
  };
}

class Board extends EventEmitter {
  constructor({ storagePath = null, historyProvider = null, liveness = {}, clock = () => Date.now(), authToken = null, store = null } = {}) {
    super();
    this.storagePath = storagePath;
    this.archivePath = storagePath ? `${storagePath}.archive` : null;
    this.historyProvider = historyProvider;
    this.clock = clock;
    this.authToken = authToken || null;
    this.store = store;
    this.livenessLimits = { ...LIVENESS_DEFAULTS, ...liveness };
    this.sessions = new Map();
    this.archived = new Map();
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
          lastObservedAt: Number(record.lastObservedAt || record.since || this.clock()),
          liveness: record.liveness || 'inactive',
          livenessLevel: record.livenessLevel || null,
          hardEscalationAt: record.hardEscalationAt || null,
          processStatus: record.processStatus || (record.owned ? 'unknown' : 'unknown'),
          delivery: record.delivery || null,
        });
      }
    } catch (_) { /* A missing or corrupt cache must not prevent startup. */ }
    if (!this.archivePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.archivePath, 'utf8'));
      if (!Array.isArray(saved)) return;
      for (const record of saved) {
        if (!record || !record.key || !record.cwd) continue;
        this.archived.set(record.key, { ...record, tile: record.tile || record.key, owned: true, state: null });
      }
    } catch (_) { /* A missing or corrupt archive must not prevent startup. */ }
  }

  persist() {
    if (!this.storagePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.list(), null, 2));
    } catch (_) { /* Persistence is best effort. */ }
  }

  persistArchive() {
    if (!this.archivePath) return;
    try {
      fs.mkdirSync(path.dirname(this.archivePath), { recursive: true });
      fs.writeFileSync(this.archivePath, JSON.stringify([...this.archived.values()], null, 2));
    } catch (_) { /* Archive persistence is best effort. */ }
  }

  register(tile, cwd, agent = null) {
    if (!tile) throw new Error('A tile id is required');
    const existing = this.sessions.get(tile);
    if (existing) return existing;
    const session = sessionDetails(tile, tile, null, cwd, true, agent, this.clock());
    this.sessions.set(tile, session);
    this.persist();
    this.emit('change');
    return session;
  }

  registerExternal(key, cwd, agent = null) {
    if (!key || this.sessions.has(key)) return this.sessions.get(key);
    const existing = [...this.sessions.values()].find((session) => !session.owned && session.cwd === cwd);
    if (existing) return existing;
    const session = sessionDetails(key, null, null, cwd, false, agent, this.clock());
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

  listArchived() {
    return [...this.archived.values()].map((session) => ({ ...session }));
  }

  archive(tile) {
    const session = this.sessions.get(tile);
    if (!session) return false;
    this.sessions.delete(tile);
    this.archived.set(tile, { ...session, state: null, tile: session.tile || tile });
    this.persist();
    this.persistArchive();
    this.emit('change', { key: tile, state: null, archived: true });
    return true;
  }

  unarchive(tile) {
    const session = this.archived.get(tile);
    if (!session) return null;
    this.archived.delete(tile);
    this.sessions.set(tile, { ...session, state: null, owned: true });
    this.persistArchive();
    this.persist();
    this.emit('change', { key: tile, state: null, navigation: true });
    return this.sessions.get(tile);
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
    const event = normalizeEvent({
      state,
      tile,
      eventId: payload?.event_id || payload?.eventId,
      adapterId: payload?.adapter_id || payload?.adapterId || payload?.agent || 'hook',
      producerEpoch: payload?.producer_epoch || payload?.producerEpoch || null,
      sequence: payload?.sequence,
      payload,
    });
    if (this.store) {
      const accepted = this.store.ingestEvent(event);
      if (!accepted.accepted && (accepted.duplicate || accepted.stale)) return;
    }
    let sessionId = payload && typeof payload.session_id === 'string' ? payload.session_id : null;
    const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : '';
    const key = tile || sessionId;
    if (!key) return;

    let session = this.sessions.get(key);
    let bindingChanged = false;
    if (session?.agent === 'codex' && session.owned) {
      const current = resolveCodexSessionId(session.sessionId, session.cwd);
      sessionId = current || (!session.sessionIdVerified && (
        resolveCodexSessionId(sessionId, session.cwd)
        || findUniqueCodexSessionSince(session.cwd, session.created)?.id
      )) || null;
      if (sessionId && !session.sessionIdVerified) {
        session.sessionIdVerified = true;
        bindingChanged = true;
      }
    }
    if (!session && !tile && cwd) {
      const candidates = [...this.sessions.values()].filter((candidate) => candidate.owned && candidate.cwd === cwd);
      const matchedOwned = candidates.find((candidate) => sessionId && candidate.sessionId === sessionId)
        || candidates.filter((candidate) => !candidate.sessionId || candidate.state === 'working')
          .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
      const matched = matchedOwned || [...this.sessions.values()]
        .find((candidate) => !candidate.owned && !candidate.sessionId && candidate.cwd === cwd);
      if (matched) {
        if (matched.owned) {
          session = matched;
        } else {
          this.sessions.delete(matched.key);
          matched.key = key;
          matched.sessionId = sessionId;
          this.sessions.set(key, matched);
          this.persist();
          session = matched;
        }
      }
    }
    if (!session) {
      if (state === 'closed') return;
      session = sessionDetails(key, tile || null, sessionId, cwd, false, null, this.clock());
      session.state = state;
      session.liveness = ['working', 'approval'].includes(state) ? 'healthy' : 'inactive';
      session.livenessLevel = null;
      this.sessions.set(key, session);
      this.persist();
      this.emit('change', { key, state });
    } else {
      let metadataChanged = bindingChanged;
      session.lastObservedAt = this.clock();
      session.processStatus = 'running';
      const previousLiveness = session.liveness;
      session.liveness = ['working', 'approval'].includes(state) ? 'healthy' : 'inactive';
      session.livenessLevel = null;
      if (session.liveness === 'healthy') session.hardEscalationAt = null;
      if (previousLiveness !== 'healthy') metadataChanged = true;
      if (payload?.submitted) {
        session.delivery = {
          ...(session.delivery || {}),
          status: 'acknowledged',
          at: this.clock(),
        };
        metadataChanged = true;
      }
      if (sessionId && session.sessionId !== sessionId) {
        session.sessionId = sessionId;
        metadataChanged = true;
      }
      if (cwd && !session.cwd) {
        session.cwd = cwd;
        session.project = path.basename(cwd);
        session.path = displayPath(cwd);
        metadataChanged = true;
      }
      if (state === 'approval' && session.agent === 'claude' && !session.approvalQuestions?.length) {
        session.approvalQuestions = userQuestionsFromHook(payload) || [permissionQuestion(payload)];
        metadataChanged = true;
      } else if (state !== 'approval' && session.approvalQuestions) {
        delete session.approvalQuestions;
        metadataChanged = true;
      }
      if (state === 'closed' && !session.owned) {
        this.sessions.delete(key);
        this.persist();
        this.emit('change', { key, state: null });
        return;
      }
      if (state === 'done' && session.state === 'approval') {
        let pendingQuestions;
        try { pendingQuestions = this.historyProvider?.({ ...session })?.pendingQuestions; } catch (_) { pendingQuestions = null; }
        // Ignore a stop while an approval is still pending, but allow a real
        // completion after the question has already been answered.
        if (!Array.isArray(pendingQuestions) || pendingQuestions.length) {
          session.pendingDone = true;
          if (metadataChanged) this.persist();
          this.emit('change');
          return;
        }
      }
      session.pendingDone = false;
      const nextState = state === 'closed' ? null : state;
      if (session.state !== nextState) {
        session.state = nextState;
        session.since = this.clock();
        this.persist();
        this.emit('change', { key, state: nextState });
      } else {
        if (metadataChanged) this.persist();
        this.emit('change', nextState === 'approval' ? { key, state: nextState, repeated: true } : undefined);
      }
    }
  }

  checkLiveness(now = this.clock()) {
    const changes = [];
    for (const session of this.sessions.values()) {
      const next = livenessFor(session, now, this.livenessLimits);
      const changed = session.liveness !== next.status || session.livenessLevel !== next.level;
      if (!changed) continue;
      const recovered = ['stale', 'unknown'].includes(session.liveness) && next.status === 'healthy';
      session.liveness = next.status;
      session.livenessLevel = next.level;
      if (next.level === 'hard' && !session.hardEscalationAt) {
        session.hardEscalationAt = now;
        changes.push({ key: session.key, state: session.state, liveness: next.status, livenessLevel: next.level, escalation: true });
      } else if (recovered) {
        session.hardEscalationAt = null;
        changes.push({ key: session.key, state: session.state, liveness: next.status, recovered: true });
      } else {
        changes.push({ key: session.key, state: session.state, liveness: next.status, livenessLevel: next.level });
      }
      this.persist();
      this.emit('change', changes.at(-1));
    }
    return changes;
  }

  processExited(tile, { code = null, signal = null } = {}) {
    const session = this.sessions.get(tile);
    if (!session) return false;
    session.processStatus = 'exited';
    session.exit = { code, signal, at: this.clock() };
    session.liveness = 'unknown';
    session.livenessLevel = 'process-exited';
    this.persist();
    this.emit('change', { key: tile, state: session.state, liveness: 'unknown', processExited: true });
    return true;
  }

  recordDelivery(tile, status, details = {}) {
    const session = this.sessions.get(tile);
    if (!session || !['submitted', 'acknowledged', 'failed', 'unknown'].includes(status)) return false;
    session.delivery = { status, at: this.clock(), ...details };
    this.persist();
    this.emit('change', { key: tile, state: session.state, delivery: session.delivery });
    return true;
  }

  completePendingDone(tile) {
    const session = this.sessions.get(tile);
    if (!session?.pendingDone || session.state !== 'approval') return false;
    this.handleHook('done', tile, { session_id: session.sessionId, cwd: session.cwd });
    return true;
  }

  listen(port = 4747, host = '127.0.0.1') {
    this.server = http.createServer((request, response) => {
      if (this.authToken && request.headers['x-signal-box-token'] !== this.authToken) {
        sendJson(response, 401, { error: 'Signal Box authentication required.' });
        return;
      }
      let url;
      try { url = new URL(request.url, `http://${host}`); }
      catch (_) { sendJson(response, 400, { error: 'Invalid request URL.' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const sessions = this.list().map((session) => ({
          ...session,
          historyUrl: `/api/sessions/${encodeURIComponent(session.key)}/history`,
        }));
        sendJson(response, 200, { sessions });
        return;
      }
      const historyMatch = request.method === 'GET' && url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
      if (historyMatch) {
        let key;
        try { key = decodeURIComponent(historyMatch[1]); } catch (_) { sendJson(response, 400, { error: 'Invalid session key.' }); return; }
        const session = this.sessions.get(key);
        if (!session) { sendJson(response, 404, { error: 'Session not found.' }); return; }
        if (!this.historyProvider) { sendJson(response, 503, { error: 'Session history is unavailable.' }); return; }
        try { sendJson(response, 200, this.historyProvider({ ...session })); } catch (error) { sendJson(response, 500, { error: error.message }); }
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/hook') {
        response.writeHead(404);
        response.end();
        return;
      }

      const state = url.searchParams.get('state');
      const tile = url.searchParams.get('tile') || null;
      let body = '';
      let bytes = 0;
      let tooLarge = false;
      request.setEncoding('utf8');
      request.on('error', () => {});
      request.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) {
          if (!tooLarge) sendJson(response, 413, { error: 'Hook payload exceeds 1 MiB.' });
          tooLarge = true;
          body = '';
          return;
        }
        body += chunk;
      });
      request.on('end', () => {
        if (tooLarge) return;
        let payload = {};
        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
          } catch (_) {
            payload = {};
          }
        }
        try {
          this.handleHook(state, tile, payload);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
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

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload, null, 2));
}

module.exports = { Board, displayPath, permissionQuestion, userQuestionsFromHook };
