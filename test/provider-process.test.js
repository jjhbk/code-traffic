const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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

  const children = [];
  const supervised = new GoogleProviderProcess({ restartDelayMs: 5, forkImpl: () => {
    const child = new EventEmitter();
    child.connected = true;
    child.send = (message) => {
      if (message.method === 'shutdown') setImmediate(() => child.emit('message', { type: 'response', id: message.id, result: { stopped: true } }));
      else setImmediate(() => child.emit('message', { type: 'response', id: message.id, result: { updated: true } }));
    };
    child.disconnect = () => { child.connected = false; };
    children.push(child);
    setImmediate(() => child.emit('message', { type: 'ready' }));
    return child;
  } });
  await supervised.start({ 'gmail-account': 'owner@example.com' });
  children[0].emit('exit', 1, null);
  const deadline = Date.now() + 500;
  while (children.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(children.length, 2, 'unexpected provider-process exits are supervised');
  await supervised.stop();
  assert.equal(children.length, 2, 'intentional provider-process shutdown does not restart');
  const hangingChild = new EventEmitter();
  hangingChild.connected = true;
  hangingChild.disconnect = () => { hangingChild.connected = false; };
  const hanging = new GoogleProviderProcess({ startupTimeoutMs: 100, forkImpl: () => hangingChild });
  await assert.rejects(hanging.start(), /did not become ready within 100ms/);
  assert.equal(hanging.child, null, 'a provider that never becomes ready is released');
  console.log('provider process tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
