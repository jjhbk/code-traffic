const assert = require('node:assert/strict');
const http = require('node:http');
const { Board } = require('../board');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { ConversationService } = require('../host/conversation/service');
const { ProactivityService } = require('../host/proactivity/service');
const { MobileApi } = require('../host/mobile/api');

let commandSequence = 0;
function request(port, pathname, { method = 'GET', token = 'mobile-secret', body = null, commandId = null } = {}) {
  return new Promise((resolve, reject) => {
    const idempotencyKey = commandId || body?.externalId || `test-command-${++commandSequence}`;
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Idempotency-Key': idempotencyKey } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

(async () => {
  const store = new SqliteStore();
  const proactivity = new ProactivityService({ store });
  const conversation = new ConversationService({ store, channel: 'mobile', proactivity });
  const approvals = new ApprovalService({ store });
  const mobileApi = new MobileApi({ store, conversation, proactivity, approvals, getStatus: () => ({ running: true, host: 'fixture' }) });
  const board = new Board({ authToken: 'hook-secret', mobileAuthToken: 'mobile-secret', mobileApi });
  const port = 4950 + Math.floor(Math.random() * 50);
  await board.listen(port);

  assert.equal((await request(port, '/api/v1/mobile/health', { token: 'wrong' })).status, 401);
  const health = await request(port, '/api/v1/mobile/health');
  assert.equal(health.status, 200); assert.equal(health.body.protocolVersion, '1'); assert.equal(health.body.core.host, 'fixture');
  const today = await request(port, '/api/v1/mobile/today');
  assert.equal(today.status, 200); assert.ok(Array.isArray(today.body.tasks)); assert.ok(Array.isArray(today.body.workflows));

  const sent = await request(port, '/api/v1/mobile/conversation/messages', { method: 'POST', body: { text: 'What needs attention?', externalId: 'mobile-message-1' } });
  assert.equal(sent.status, 200); assert.equal(sent.body.duplicate, false);
  const duplicate = await request(port, '/api/v1/mobile/conversation/messages', { method: 'POST', body: { text: 'What needs attention?', externalId: 'mobile-message-1' } });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
  const history = await request(port, '/api/v1/mobile/conversation');
  assert.equal(history.body.messages.length, 2);

  const permission = await request(port, '/api/v1/mobile/permissions', { method: 'POST', body: { capability: 'browser.read', constraints: { recipeId: 'fixture.read.v1' }, expiresAt: Date.now() + 60_000 } });
  assert.equal(permission.status, 200); assert.equal(permission.body.permission.surface, 'desktop');
  const permissions = await request(port, '/api/v1/mobile/permissions');
  assert.equal(permissions.body.permissions.length, 1);
  const revoked = await request(port, `/api/v1/mobile/permissions/${permission.body.permission.grantId}/revoke`, { method: 'POST', body: {} });
  assert.equal(revoked.status, 200); assert.equal(revoked.body.permission.status, 'revoked');

  const deniedLocation = await request(port, '/api/v1/mobile/context/location', { method: 'POST', body: { latitude: 1, longitude: 2, accuracy: 5, consent: false } });
  assert.equal(deniedLocation.status, 403);
  const location = await request(port, '/api/v1/mobile/context/location', { method: 'POST', body: { deviceId: 'phone-1', eventId: 'location-1', latitude: 1, longitude: 2, accuracy: 5, consent: true } });
  assert.equal(location.status, 200); assert.equal(location.body.accepted.accepted, true);
  const duplicateLocation = await request(port, '/api/v1/mobile/context/location', { method: 'POST', body: { deviceId: 'phone-1', eventId: 'location-1', latitude: 1, longitude: 2, accuracy: 5, consent: true } });
  assert.equal(duplicateLocation.body.accepted.duplicate, true);

  await board.closeServer(); store.close(); console.log('mobile API tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
