const assert = require('node:assert/strict');
const path = require('path');
const { GoogleProviderProcess } = require('../host/mail/provider-process');

(async () => {
  const processHost = new GoogleProviderProcess({ workerPath: path.join(__dirname, '..', 'host', 'mail', 'provider-process-worker.js') });
  await processHost.start({ 'gmail-refresh-token': 'refresh', 'gmail-client-id': 'client', 'gmail-account': 'owner@example.com' });
  const health = await processHost._send({ method: 'health' });
  assert.deepEqual(health, { running: true, account: 'owner@example.com' });
  assert.equal(typeof processHost.provider('gmail').sendReply, 'function');
  assert.equal(typeof processHost.provider('calendar').getEvent, 'function');
  await assert.rejects(() => processHost.request('unsupported', {}), /Unsupported Google provider request/);
  assert.deepEqual(await processHost.stop(), { stopped: true });
  console.log('provider process tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
