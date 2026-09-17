const { normalizeMessage } = require('./normalize');

class MailSync {
  constructor({ store, provider, clock = () => Date.now(), ownerId = `mail-sync-${process.pid}`, leaseMs = 10 * 60 * 1000 } = {}) {
    if (!store || !provider) throw new Error('Mail sync requires a store and provider.');
    this.store = store;
    this.provider = provider;
    this.clock = clock;
    this.ownerId = ownerId;
    this.leaseMs = leaseMs;
    this.inFlight = new Map();
  }

  async run({ adapterId, accountAddress, boundedWindow = 100 } = {}) {
    if (this.inFlight.has(adapterId)) return this.inFlight.get(adapterId);
    const operation = this._run({ adapterId, accountAddress, boundedWindow });
    this.inFlight.set(adapterId, operation);
    try { return await operation; }
    finally { if (this.inFlight.get(adapterId) === operation) this.inFlight.delete(adapterId); }
  }

  async _run({ adapterId, accountAddress, boundedWindow = 100 } = {}) {
    if (!adapterId) throw new Error('A mail adapter id is required.');
    const lease = this.store.acquireConnectorLease(adapterId, this.ownerId, this.leaseMs, this.clock());
    if (!lease) return { adapterId, skipped: true, reason: 'connector-sync-in-progress', fetched: 0, inserted: 0, removed: 0, observations: [], cursorReset: false, nextCursor: this.store.getConnectorCursor(adapterId), reconciliationQueued: false, syncedAt: this.clock() };
    let cursor = this.store.getConnectorCursor(adapterId);
    let reset = false;
    let result;
    try {
      try {
        result = await this.provider.sync({ cursor, boundedWindow });
      } catch (error) {
        if (error.code !== 'CURSOR_EXPIRED' || cursor === null) throw error;
        reset = true;
        result = await this.provider.sync({ cursor: null, boundedWindow });
      }
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      return this.store.transaction(() => {
        let inserted = 0;
        let removed = 0;
        const observations = [];
        for (const raw of messages) {
          if (raw?.removed) {
            if (this.store.removeObservation(adapterId, raw.id)) removed += 1;
            continue;
          }
          const observation = normalizeMessage(raw, { accountAddress, adapterId });
          if (this.store.saveObservation(observation, adapterId)) { inserted += 1; observations.push(observation); }
        }
        const nextCursor = result?.nextCursor ?? cursor ?? null;
        if (result?.nextCursor !== undefined && result.nextCursor !== null) this.store.setConnectorCursor(adapterId, String(nextCursor));
        let reconciliation = null;
        if (inserted || removed || nextCursor !== cursor) {
          reconciliation = this.store.enqueueJob({ kind: 'tasks.reconcile', payload: { adapterId }, runAt: this.clock(), dedupeKey: `tasks.reconcile:${adapterId}:${nextCursor || 'initial'}` });
        }
        return { adapterId, fetched: messages.length, inserted, removed, observations, cursorReset: reset, nextCursor, reconciliationQueued: Boolean(reconciliation), syncedAt: this.clock() };
      });
    } finally {
      this.store.releaseConnectorLease(adapterId, lease.leaseToken);
    }
  }
}

module.exports = { MailSync };
