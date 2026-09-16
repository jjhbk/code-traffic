const { JobRunner } = require('../workflows/job-runner');

class AssistantRuntime {
  constructor({ store, handlers = {}, workerId = `assistant-${process.pid}`, intervalMs = 30_000, clock = () => Date.now(), onError = null } = {}) {
    if (!store) throw new Error('Assistant runtime requires a store.');
    this.store = store;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.runner = new JobRunner({ store, handlers, workerId, clock });
    this.timer = null;
    this.startedAt = null;
    this.running = false;
  }

  register(kind, handler) { this.runner.register(kind, handler); }

  schedule(kind, payload = {}, runAt = this.clock(), dedupeKey = null) {
    return this.store.enqueueJob({ kind, payload, runAt, dedupeKey });
  }

  async tick() {
    if (this.running) return [];
    this.running = true;
    try { return await this.runner.runOnce(); }
    catch (error) { this.onError?.(error); return []; }
    finally { this.running = false; }
  }

  start() {
    if (this.timer) return;
    this.startedAt = this.clock();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  health() {
    return { running: Boolean(this.timer), busy: this.running, startedAt: this.startedAt, intervalMs: this.intervalMs };
  }
}

module.exports = { AssistantRuntime };
