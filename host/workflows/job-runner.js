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

  complete(job, options) {
    try {
      return this.store.completeJob(job.jobId, job.leaseToken, options);
    } catch (error) {
      if (!/lease/i.test(error.message)) throw error;
      const current = this.store.getJob(job.jobId);
      return { ...(current || job), leaseLost: true };
    }
  }

  async runOnce({ limit = 10 } = {}) {
    const jobs = this.store.claimJobs({ limit, leaseMs: this.leaseMs, workerId: this.workerId, now: this.clock(), kinds: this.kinds });
    const results = [];
    for (const job of jobs) {
      const handler = this.handlers[job.kind];
      if (!handler) {
        results.push(await this.complete(job, { status: 'failed', error: `No handler registered for ${job.kind}.` }));
        continue;
      }
      const heartbeatMs = Math.max(10, Math.floor(this.leaseMs / 3));
      let leaseError = null;
      const heartbeat = setInterval(() => {
        try { this.store.renewJob(job.jobId, job.leaseToken, this.leaseMs, this.clock()); }
        catch (error) { leaseError = error; }
      }, heartbeatMs);
      heartbeat.unref?.();
      try {
        const result = await handler(job.payload, {
          ...job,
          renewLease: (leaseMs = this.leaseMs) => this.store.renewJob(job.jobId, job.leaseToken, leaseMs, this.clock()),
        });
        if (leaseError) throw leaseError;
        results.push(await this.complete(job, { status: 'completed', error: result?.error || null }));
      } catch (error) {
        const retry = job.attempts < job.maxAttempts;
        results.push(await this.complete(job, {
          status: retry ? 'queued' : 'failed',
          runAt: retry ? this.clock() + Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(job.attempts - 1, 8))) : null,
          error: error.message,
        }));
      } finally {
        clearInterval(heartbeat);
      }
    }
    return results;
  }
}

module.exports = { JobRunner };
