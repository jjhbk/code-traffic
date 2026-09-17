const assert = require('assert');
const { RemoteProvider } = require('../host/mail/remote-provider');

async function run() {
  const calls = [];
  const provider = new RemoteProvider({ kind: 'connector.gmail.fetch', request: async (...args) => { calls.push(args); return { nextCursor: 'cursor-2', messages: [] }; } });
  assert.deepStrictEqual(await provider.sync({ cursor: 'cursor-1', boundedWindow: 10 }), { nextCursor: 'cursor-2', messages: [] });
  assert.deepStrictEqual(calls, [['connector.gmail.fetch', { cursor: 'cursor-1', boundedWindow: 10 }]]);
  assert.throws(() => new RemoteProvider({ kind: 'connector.gmail.fetch' }), /request function/);
  assert.throws(() => new RemoteProvider({ request: () => null }), /request function and kind/);
  console.log('Remote provider tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
