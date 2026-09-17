const { JobRunner } = require('../workflows/job-runner');

class AssistantRuntime {
  constructor({ store, handlers = {}, workerId = `assistant-${process.pid}`, intervalMs = 30_000, clock = () => Date.now(), onError = null, paused = false, kinds = null } = {}) {
    if (!store) throw new Error('Assistant runtime requires a store.');
    this.store = store;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.runner = new JobRunner({ store, handlers, workerId, clock, kinds });
    this.timer = null;
    this.startedAt = null;
    this.running = false;
    this.paused = Boolean(paused);
    this.lastTickAt = null;
    this.lastTickDurationMs = null;
    this.lastTickJobs = 0;
    this.lastError = null;
  }

  register(kind, handler) { this.runner.register(kind, handler); }

  schedule(kind, payload = {}, runAt = this.clock(), dedupeKey = null) {
    return this.store.enqueueJob({ kind, payload, runAt, dedupeKey });
  }

  async tick() {
    if (this.paused) return [];
    if (this.running) return [];
    this.running = true;
    const startedAt = this.clock();
    this.lastTickAt = startedAt;
    try {
      const results = await this.runner.runOnce();
      this.lastTickJobs = results.length;
      this.lastError = results.find((result) => result.status === 'failed')?.lastError || null;
      return results;
    } catch (error) {
      this.lastError = error.message;
      this.onError?.(error);
      return [];
    } finally {
      this.lastTickDurationMs = Math.max(0, this.clock() - startedAt);
      this.running = false;
    }
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

  setPaused(paused) { this.paused = Boolean(paused); return this.health(); }

  health() {
    return { running: Boolean(this.timer), busy: this.running, paused: this.paused, startedAt: this.startedAt, intervalMs: this.intervalMs, lastTickAt: this.lastTickAt, lastTickDurationMs: this.lastTickDurationMs, lastTickJobs: this.lastTickJobs, lastError: this.lastError, jobs: this.store.jobHealth(this.clock()) };
  }
}

module.exports = { AssistantRuntime };
