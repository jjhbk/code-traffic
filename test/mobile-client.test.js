const assert = require('node:assert/strict');
const { MobileCoreClient, NOTIFICATION_CURSOR_KEY } = require('../mobile/src/client');

(async () => {
  const values = new Map();
  const storage = { getItem: async (key) => values.get(key) || null, setItem: async (key, value) => values.set(key, value) };
  let online = false; const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (!online) throw new Error('offline');
    return { ok: true, status: 200, json: async () => (url.includes('/notifications') ? { notifications: [], nextCursor: 'cursor-1' } : { accepted: true }) };
  };
  const client = new MobileCoreClient({ baseUrl: 'http://core', token: 'secret', fetchImpl, storage, clock: () => 100 });
  const queued = await client.sendMessage('remember this', { externalId: 'command-1' });
  assert.deepEqual(queued, { queued: true, commandId: 'command-1', pending: 1 });
  assert.equal(JSON.parse(values.get('signal-box.mobile.outbox.v1')).length, 1);
  online = true;
  const flushed = await client.flushOutbox();
  assert.deepEqual(flushed, { flushed: 1, pending: 0 });
  assert.equal(calls.at(-1).options.headers['Idempotency-Key'], 'command-1');
  assert.equal(JSON.parse(values.get('signal-box.mobile.outbox.v1')).length, 0);
  const synced = await client.syncNotifications();
  assert.equal(synced.nextCursor, 'cursor-1');
  assert.equal(values.get(NOTIFICATION_CURSOR_KEY), 'cursor-1');
  const pause = await client.setAssistantPaused(true);
  assert.equal(calls.at(-1).url, 'http://core/api/v1/mobile/assistant/pause');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { paused: true });
  assert.equal(pause.accepted, true);
  console.log('mobile client tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
