const crypto = require('crypto');
const path = require('path');
const { fork } = require('child_process');

class BackgroundHost {
  constructor({ databasePath, workerPath = path.join(__dirname, 'background-host-worker.js'), forkImpl = fork, token = crypto.randomBytes(32).toString('hex'), onJob = null, paused = false } = {}) {
    if (!databasePath) throw new Error('A background host database path is required.');
    this.databasePath = databasePath;
    this.workerPath = workerPath;
    this.forkImpl = forkImpl;
    this.token = token;
    this.onJob = onJob;
    this.paused = Boolean(paused);
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.ready = null;
  }

  start() {
    if (this.child) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let readySettled = false;
      const resolveReady = (health) => { if (!readySettled) { readySettled = true; resolve(health); } };
      const rejectReady = (error) => { if (!readySettled) { readySettled = true; reject(error); } };
      const child = this.forkImpl(this.workerPath, [this.databasePath], { env: { ...process.env, SIGNAL_BOX_BACKGROUND_TOKEN: this.token, SIGNAL_BOX_BACKGROUND_PAUSED: this.paused ? '1' : '0' } });
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
        const error = new Error(`Background host exited${signal ? ` with ${signal}` : ` with code ${code}`}.`);
        rejectReady(error);
        this._failPending(error);
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

  health() { return this.request('health'); }
  pause(paused) { return this.request('pause', { paused: Boolean(paused) }); }

  async stop() {
    if (!this.child) return { stopped: true };
    try { return await this.request('shutdown'); }
    finally { this.child.disconnect?.(); this.child = null; this.ready = null; }
  }

  _failPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

module.exports = { BackgroundHost };
