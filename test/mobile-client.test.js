const assert = require('node:assert/strict');
const { MobileCoreClient } = require('../mobile/src/client');

(async () => {
  const values = new Map();
  const storage = { getItem: async (key) => values.get(key) || null, setItem: async (key, value) => values.set(key, value) };
  let online = false; const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (!online) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ accepted: true }) };
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
  console.log('mobile client tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
