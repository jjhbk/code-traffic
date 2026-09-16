const assert = require('node:assert/strict');
const { Board } = require('../board');
const { BrowserBridge } = require('../host/browser/bridge');

function request(port, pathname, { method = 'GET', token = 'bridge-secret', body = null } = {}) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'X-Signal-Box-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const bridge = new BrowserBridge({ ttlMs: 1000 });
  const board = new Board({ authToken: 'bridge-secret', browserBridge: bridge });
  const port = 4900 + Math.floor(Math.random() * 100);
  await board.listen(port);

  const requestId = bridge.enqueue({ sessionId: 'browser-session', origin: 'https://m.uber.com', step: { id: 'quote', kind: 'read' } });
  assert.equal((await request(port, '/browser/next?sessionId=browser-session', { token: 'wrong' })).status, 401);
  const next = await request(port, '/browser/next?sessionId=other-session');
  assert.equal(next.status, 200);
  assert.equal(next.body.request, null);
  const delivered = await request(port, '/browser/next?sessionId=browser-session');
  assert.equal(delivered.body.request.requestId, requestId);

  assert.equal((await request(port, '/browser/result', { method: 'POST', body: { requestId, sessionId: 'other-session', origin: 'https://m.uber.com', result: '$24' } })).status, 400);
  assert.equal((await request(port, '/browser/result', { method: 'POST', body: { requestId, sessionId: 'browser-session', origin: 'https://evil.example', result: '$24' } })).status, 400);
  const result = await request(port, '/browser/result', { method: 'POST', body: { requestId, sessionId: 'browser-session', origin: 'https://m.uber.com', result: '$24' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.result, '$24');
  await board.closeServer();
  console.log('browser HTTP bridge tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
