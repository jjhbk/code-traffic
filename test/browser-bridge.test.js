const assert = require('node:assert/strict');
const { BrowserBridge } = require('../host/browser/bridge');
const { BridgeBrowserAdapter } = require('../host/browser/bridge-adapter');

(async () => {

let now = 1000;
const bridge = new BrowserBridge({ clock: () => now, ttlMs: 10 });
const requestId = bridge.enqueue({ sessionId: 'session-1', origin: 'https://m.uber.com', step: { id: 'quote', kind: 'read' } });
assert.equal(bridge.next({ sessionId: 'session-2' }), null);
assert.equal(bridge.status('session-2').connected, true);
assert.equal(bridge.status('session-1').connected, false);
assert.equal(bridge.next({ sessionId: 'session-1' }).requestId, requestId);
assert.equal(bridge.next({ sessionId: 'session-1' }), null);
assert.throws(() => bridge.complete({ requestId, sessionId: 'session-2', origin: 'https://m.uber.com', result: '$24' }), /another session/);
assert.throws(() => bridge.complete({ requestId, sessionId: 'session-1', origin: 'https://evil.example', result: '$24' }), /another session or origin/);
assert.deepEqual(bridge.complete({ requestId, sessionId: 'session-1', origin: 'https://m.uber.com', result: '$24' }).result, '$24');
const bridged = new BrowserBridge({ clock: () => now, ttlMs: 100 });
const adapter = new BridgeBrowserAdapter({ bridge: bridged, sessionId: 'session-1', origin: 'https://m.uber.com' });
const pendingResult = adapter.perform({ id: 'quote', kind: 'read' });
const queued = bridged.next({ sessionId: 'session-1' });
bridged.complete({ requestId: queued.requestId, sessionId: 'session-1', origin: 'https://m.uber.com', result: '$24' });
assert.equal(await pendingResult, '$24');
const expired = bridge.enqueue({ sessionId: 'session-1', origin: 'https://m.uber.com', step: { id: 'request', kind: 'click' } });
const expiredWait = bridge.wait(expired);
now = 1011;
assert.equal(bridge.next({ sessionId: 'session-1' }), null);
await assert.rejects(expiredWait, /expired before/);
assert.throws(() => bridge.complete({ requestId: expired, sessionId: 'session-1', origin: 'https://m.uber.com' }), /unknown, expired/);
console.log('browser bridge tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
