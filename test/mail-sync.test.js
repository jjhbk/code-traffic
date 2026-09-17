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
  const firstResult = await sync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' });
  assert.equal(firstResult.adapterId, 'gmail:me'); assert.equal(firstResult.fetched, 1); assert.equal(firstResult.inserted, 1); assert.equal(firstResult.removed, 0); assert.equal(firstResult.cursorReset, false); assert.equal(firstResult.nextCursor, 'c1'); assert.equal(firstResult.syncedAt, 1770000000000); assert.equal(firstResult.observations.length, 1);
  assert.equal((await sync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' })).cursorReset, true);
  assert.equal(store.getConnectorCursor('gmail:me'), 'c2');
  assert.equal(store.observations('gmail:me').length, 2);
  const removedProvider = { async sync() { return { messages: [{ id: 'm1', threadId: 't1', removed: true }], nextCursor: 'c3' }; } };
  const removedSync = new MailSync({ store, provider: removedProvider, clock: () => 1770000000000 });
  assert.equal((await removedSync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' })).removed, 1);
  assert.equal(store.observations('gmail:me').length, 1);
  let concurrentCalls = 0;
  let releaseConcurrent;
  const concurrentProvider = {
    sync: async () => {
      concurrentCalls += 1;
      await new Promise((resolve) => { releaseConcurrent = resolve; });
      return { messages: [], nextCursor: 'c4' };
    },
  };
  const concurrentSync = new MailSync({ store, provider: concurrentProvider, clock: () => 1770000000000 });
  const firstRun = concurrentSync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' });
  const secondRun = concurrentSync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(concurrentCalls, 1, 'one account has one in-flight provider sync');
  releaseConcurrent();
  assert.strictEqual(await firstRun, await secondRun, 'concurrent callers share one sync result');
  store.close();
  console.log('mail sync tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
