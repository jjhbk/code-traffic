const crypto = require('crypto');
const path = require('path');
const { fork } = require('child_process');

class BackgroundHost {
  constructor({ databasePath, workerPath = path.join(__dirname, 'background-host-worker.js'), forkImpl = fork, token = crypto.randomBytes(32).toString('hex'), onJob = null, paused = false, supervise = true, restartDelayMs = 250, digestSettings = {} } = {}) {
    if (!databasePath) throw new Error('A background host database path is required.');
    this.databasePath = databasePath;
    this.workerPath = workerPath;
    this.forkImpl = forkImpl;
    this.token = token;
    this.onJob = onJob;
    this.paused = Boolean(paused);
    this.supervise = Boolean(supervise);
    this.restartDelayMs = Math.max(10, Number(restartDelayMs) || 250);
    this.digestSettings = digestSettings && typeof digestSettings === 'object' ? digestSettings : {};
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.ready = null;
    this.restartTimer = null;
    this.stopping = false;
    this.lifecycle = 'stopped';
    this.lastExitAt = null;
    this.restartCount = 0;
  }

  start() {
    if (this.child) return this.ready;
    this.stopping = false;
    this.lifecycle = 'starting';
    this.ready = new Promise((resolve, reject) => {
      let readySettled = false;
      const resolveReady = (health) => { if (!readySettled) { readySettled = true; this.lifecycle = 'running'; resolve({ ...health, lifecycle: this.lifecycle, lastExitAt: this.lastExitAt, restartCount: this.restartCount }); } };
      const rejectReady = (error) => { if (!readySettled) { readySettled = true; reject(error); } };
      const child = this.forkImpl(this.workerPath, [this.databasePath], { env: { ...process.env, SIGNAL_BOX_BACKGROUND_TOKEN: this.token, SIGNAL_BOX_BACKGROUND_PAUSED: this.paused ? '1' : '0', SIGNAL_BOX_DIGEST_SETTINGS: JSON.stringify(this.digestSettings) } });
      this.child = child;
      child.on('message', (message) => {
        if (message.type === 'ready') resolveReady(message.health);
        if (message.type === 'job') {
          if (!this.onJob) { child.send({ type: 'job-response', id: message.id, token: this.token, error: 'No background job adapter is configured.' }); return; }
          Promise.resolve(this.onJob(message.kind, message.payload)).then((result) => child.send({ type: 'job-response', id: message.id, token: this.token, result })).catch((error) => child.send({ type: 'job-response', id: message.id, token: this.token, error: error.message }));
          return;
        }
        if (message.type !== 'response') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      });
      child.once('error', (error) => { rejectReady(error); this._failPending(error); });
      child.once('exit', (code, signal) => {
        this.child = null;
        this.lastExitAt = Date.now();
        const error = new Error(`Background host exited${signal ? ` with ${signal}` : ` with code ${code}`}.`);
        if (!readySettled) rejectReady(error);
        this._failPending(error);
        if (readySettled && this.supervise && !this.stopping) this._scheduleRestart();
        else if (this.stopping) this.lifecycle = 'stopped';
      });
    });
    return this.ready;
  }

  request(method, payload = {}) {
    if (!this.child || !this.child.connected) return Promise.reject(new Error('Background host is not running.'));
    const id = `background-request-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ ...payload, method, id, token: this.token });
    });
  }

  async health() {
    if (!this.child || !this.child.connected) return { running: false, busy: false, paused: this.paused, lifecycle: this.stopping ? 'stopped' : (this.restartTimer ? 'recovering' : 'unavailable'), lastExitAt: this.lastExitAt, restartCount: this.restartCount };
    try {
      const health = await this.request('health');
      return { ...health, lifecycle: this.lifecycle, lastExitAt: this.lastExitAt, restartCount: this.restartCount };
    } catch (error) {
      return { running: false, busy: false, paused: this.paused, lifecycle: this.restartTimer ? 'recovering' : 'unavailable', lastExitAt: this.lastExitAt, restartCount: this.restartCount, lastError: error.message };
    }
  }
  pause(paused) { return this.request('pause', { paused: Boolean(paused) }); }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (!this.child) { this.lifecycle = 'stopped'; this.ready = null; return { stopped: true }; }
    const child = this.child;
    try { return await this.request('shutdown'); }
    finally { child.disconnect?.(); if (this.child === child) this.child = null; this.ready = null; }
  }

  _scheduleRestart() {
    if (this.restartTimer || this.stopping) return;
    this.lifecycle = 'recovering';
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.child) return;
      this.restartCount += 1;
      this.start().catch((error) => {
        if (!this.stopping) { console.error(`[assistant] background host restart failed: ${error.message}`); this._scheduleRestart(); }
      });
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  _failPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

module.exports = { BackgroundHost };
