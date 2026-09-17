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
  assert.equal(firstResult.reconciliationQueued, true);
  const reconciliationJob = store.claimJobs({ now: 1770000000000, workerId: 'task-reconciler' }).find((job) => job.kind === 'tasks.reconcile');
  assert.equal(reconciliationJob?.payload.adapterId, 'gmail:me');
  assert.equal((await sync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' })).cursorReset, true);
  assert.equal(store.getConnectorCursor('gmail:me'), 'c2');
  assert.equal(store.observations('gmail:me').length, 2);
  const removedProvider = { async sync() { return { messages: [{ id: 'm1', threadId: 't1', removed: true }], nextCursor: 'c3' }; } };
  const removedSync = new MailSync({ store, provider: removedProvider, clock: () => 1770000000000 });
  assert.equal((await removedSync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' })).removed, 1);
  assert.equal(store.observations('gmail:me').length, 1);
  const heldLease = store.acquireConnectorLease('gmail:me', 'desktop-sync', 60_000, 1770000000000);
  assert.equal(store.renewConnectorLease('gmail:me', heldLease.leaseToken, 60_000, 1770000000001).leaseUntil, 1770000060001);
  let blockedCalls = 0;
  const blockedSync = new MailSync({ store, ownerId: 'background-sync', provider: { async sync() { blockedCalls += 1; return { messages: [], nextCursor: 'should-not-run' }; } }, clock: () => 1770000000000 });
  const blockedResult = await blockedSync.run({ adapterId: 'gmail:me', accountAddress: 'me@example.com' });
  assert.equal(blockedResult.skipped, true);
  assert.equal(blockedCalls, 0, 'a second process must not call the provider while the connector lease is held');
  assert.equal(store.releaseConnectorLease('gmail:me', heldLease.leaseToken), true);
  const interruptedStore = new SqliteStore({ clock: () => 1770000000000 });
  let interruptedCalls = 0;
  const interruptedSync = new MailSync({ store: interruptedStore, provider: { async sync({ cursor }) {
    interruptedCalls += 1;
    assert.equal(cursor, null);
    throw new Error('provider interrupted during bootstrap');
  } }, clock: () => 1770000000000 });
  await assert.rejects(() => interruptedSync.run({ adapterId: 'drive:me@example.com', accountAddress: 'me@example.com' }), /provider interrupted/);
  assert.equal(interruptedCalls, 1);
  assert.equal(interruptedStore.getConnectorCursor('drive:me@example.com'), null, 'an interrupted provider run does not advance its checkpoint');
  interruptedStore.close();
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
