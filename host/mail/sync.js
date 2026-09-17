const { normalizeMessage } = require('./normalize');

class MailSync {
  constructor({ store, provider, clock = () => Date.now() } = {}) {
    if (!store || !provider) throw new Error('Mail sync requires a store and provider.');
    this.store = store;
    this.provider = provider;
    this.clock = clock;
  }

  async run({ adapterId, accountAddress, boundedWindow = 100 } = {}) {
    if (!adapterId) throw new Error('A mail adapter id is required.');
    let cursor = this.store.getConnectorCursor(adapterId);
    let reset = false;
    let result;
    try {
      result = await this.provider.sync({ cursor, boundedWindow });
    } catch (error) {
      if (error.code !== 'CURSOR_EXPIRED' || cursor === null) throw error;
      reset = true;
      result = await this.provider.sync({ cursor: null, boundedWindow });
    }
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    let inserted = 0;
    let removed = 0;
    for (const raw of messages) {
      if (raw?.removed) {
        if (this.store.removeObservation(adapterId, raw.id)) removed += 1;
        continue;
      }
      const observation = normalizeMessage(raw, { accountAddress, adapterId });
      if (this.store.saveObservation(observation, adapterId)) inserted += 1;
    }
    if (result?.nextCursor !== undefined && result.nextCursor !== null) {
      this.store.setConnectorCursor(adapterId, String(result.nextCursor));
    }
    return { adapterId, fetched: messages.length, inserted, removed, cursorReset: reset, nextCursor: result?.nextCursor ?? cursor ?? null, syncedAt: this.clock() };
  }
}

module.exports = { MailSync };
