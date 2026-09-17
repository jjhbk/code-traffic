class JobRunner {
  constructor({ store, handlers = {}, workerId = `assistant-${process.pid}`, leaseMs = 60_000, clock = () => Date.now(), kinds = null } = {}) {
    if (!store) throw new Error('A job runner requires a store.');
    this.store = store;
    this.handlers = handlers;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.clock = clock;
    this.kinds = kinds;
  }

  register(kind, handler) {
    if (!kind || typeof handler !== 'function') throw new Error('A job handler requires a kind and function.');
    this.handlers[kind] = handler;
  }

  async runOnce({ limit = 10 } = {}) {
    const jobs = this.store.claimJobs({ limit, leaseMs: this.leaseMs, workerId: this.workerId, now: this.clock(), kinds: this.kinds });
    const results = [];
    for (const job of jobs) {
      const handler = this.handlers[job.kind];
      if (!handler) {
        results.push(await this.store.completeJob(job.jobId, job.leaseToken, { status: 'failed', error: `No handler registered for ${job.kind}.` }));
        continue;
      }
      try {
        const result = await handler(job.payload, job);
        results.push(await this.store.completeJob(job.jobId, job.leaseToken, { status: 'completed', error: result?.error || null }));
      } catch (error) {
        const retry = job.attempts < job.maxAttempts;
        results.push(await this.store.completeJob(job.jobId, job.leaseToken, {
          status: retry ? 'queued' : 'failed',
          runAt: retry ? this.clock() + Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(job.attempts - 1, 8))) : null,
          error: error.message,
        }));
      }
    }
    return results;
  }
}

module.exports = { JobRunner };
