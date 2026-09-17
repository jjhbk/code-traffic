const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { MailSync } = require('../host/mail/sync');

const store = new SqliteStore();
let calls = 0;
const provider = {
  async sync({ cursor }) {
    calls += 1;
    if (calls === 1 && cursor === null) return { messages: [{ id: 'm1', threadId: 't1', from: 'client@example.com', to: 'me@example.com', subject: 'Request', body: 'Could you send this by Friday?', historyId: 'h1' }], nextCursor: 'c1' };
    if (cursor === 'c1') {
      const error = new Error('history cursor expired');
      error.code = 'CURSOR_EXPIRED';
      throw error;
    }
    return { messages: [{ id: 'm1', threadId: 't1', from: 'client@example.com', to: 'me@example.com', subject: 'Request', body: 'Could you send this by Friday?', historyId: 'h1' }, { id: 'm2', threadId: 't1', from: 'me@example.com', to: 'client@example.com', subject: 'Re: Request', body: "I'll send this Friday.", historyId: 'h2' }], nextCursor: 'c2' };
  },
};
const sync = new MailSync({ store, provider, clock: () => 1770000000000 });

(async () => {
  assert.deepEqual(await sync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' }), { adapterId: 'gmail:me', fetched: 1, inserted: 1, removed: 0, cursorReset: false, nextCursor: 'c1', syncedAt: 1770000000000 });
  assert.equal((await sync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' })).cursorReset, true);
  assert.equal(store.getConnectorCursor('gmail:me'), 'c2');
  assert.equal(store.observations('gmail:me').length, 2);
  const removedProvider = { async sync() { return { messages: [{ id: 'm1', threadId: 't1', removed: true }], nextCursor: 'c3' }; } };
  const removedSync = new MailSync({ store, provider: removedProvider, clock: () => 1770000000000 });
  assert.equal((await removedSync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' })).removed, 1);
  assert.equal(store.observations('gmail:me').length, 1);
  store.close();
  console.log('mail sync tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
