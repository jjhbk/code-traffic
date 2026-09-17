const crypto = require('crypto');
const path = require('path');
const { fork } = require('child_process');

class GoogleProviderProcess {
  constructor({ workerPath = path.join(__dirname, 'provider-process-worker.js'), forkImpl = fork, token = crypto.randomBytes(32).toString('hex'), supervise = true, restartDelayMs = 250, startupTimeoutMs = 10_000 } = {}) {
    this.workerPath = workerPath;
    this.forkImpl = forkImpl;
    this.token = token;
    this.supervise = Boolean(supervise);
    this.restartDelayMs = Math.max(10, Number(restartDelayMs) || 250);
    this.startupTimeoutMs = Math.max(100, Number(startupTimeoutMs) || 10_000);
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.ready = null;
    this.credentials = {};
    this.stopping = false;
    this.restartTimer = null;
  }

  start(credentials = {}) {
    if (this.child) return this.ready;
    this.credentials = credentials && typeof credentials === 'object' ? { ...credentials } : {};
    this.stopping = false;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      let startupTimer;
      const child = this.forkImpl(this.workerPath, [], { env: { ...process.env, SIGNAL_BOX_PROVIDER_TOKEN: this.token } });
      this.child = child;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(startupTimer); if (error) reject(error); else resolve(result); };
      startupTimer = setTimeout(() => {
        if (settled) return;
        this.stopping = true;
        const error = new Error(`Google provider process did not become ready within ${this.startupTimeoutMs}ms.`);
        finish(error);
        this._fail(error);
        if (this.child === child) this.child = null;
        child.disconnect?.();
      }, this.startupTimeoutMs);
      child.on('message', (message) => {
        if (message.type === 'ready') {
          this._send({ method: 'set-credentials', credentials: this.credentials }).then(() => finish(null, { running: true })).catch(finish);
          return;
        }
        if (message.type !== 'response') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      });
      child.once('error', (error) => { finish(error); this._fail(error); });
      child.once('exit', (code, signal) => {
        this.child = null;
        clearTimeout(startupTimer);
        const error = new Error(`Google provider process exited${signal ? ` with ${signal}` : ` with code ${code}`}.`);
        finish(error); this._fail(error);
        if (settled && this.supervise && !this.stopping) this._scheduleRestart();
      });
    });
    return this.ready;
  }

  request(kind, payload = {}) {
    return this._send({ kind, payload });
  }

  provider(kind) {
    if (kind === 'gmail') return {
      sendReply: (payload) => this.request('action.gmail.send', payload),
      reconcileReply: (payload) => this.request('action.gmail.reconcile', payload),
    };
    if (kind === 'calendar') return {
      updateEvent: (eventId, changes, options) => this.request('action.calendar.update', { eventId, changes, options }),
      getEvent: (eventId) => this.request('action.calendar.get', { eventId }),
    };
    throw new Error(`Unsupported remote Google provider: ${kind}.`);
  }

  setCredentials(credentials = {}) {
    this.credentials = credentials && typeof credentials === 'object' ? { ...credentials } : {};
    return this._send({ method: 'set-credentials', credentials: this.credentials });
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (!this.child) { this.credentials = {}; return { stopped: true }; }
    try { return await this._send({ method: 'shutdown' }); }
    finally { this.child.disconnect?.(); this.child = null; this.ready = null; this.credentials = {}; }
  }

  _send(message) {
    if (!this.child || !this.child.connected) return Promise.reject(new Error('Google provider process is not running.'));
    const id = `provider-request-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ ...message, id, token: this.token });
    });
  }

  _fail(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }

  _scheduleRestart() {
    if (this.restartTimer || this.stopping) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && !this.child) this.start(this.credentials).catch(() => this._scheduleRestart());
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }
}

module.exports = { GoogleProviderProcess };
