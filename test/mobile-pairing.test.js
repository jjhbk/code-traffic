const assert = require('node:assert/strict');
const http = require('node:http');
const { Board } = require('../board');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { ConversationService } = require('../host/conversation/service');
const { ProactivityService } = require('../host/proactivity/service');
const { MobileApi } = require('../host/mobile/api');
const { MobilePairingService } = require('../host/mobile/pairing');

function request(port, pathname, { token, method = 'GET', body = null, commandId = 'pair-test-command' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Idempotency-Key': commandId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

(async () => {
  const store = new SqliteStore(); const pairing = new MobilePairingService({ store }); const proactivity = new ProactivityService({ store });
  const conversation = new ConversationService({ store, channel: 'mobile', proactivity }); const approvals = new ApprovalService({ store });
  const api = new MobileApi({ store, conversation, proactivity, approvals, pairing }); const board = new Board({ mobileAuthToken: 'bootstrap-secret', mobileApi: api });
  const port = 5000 + Math.floor(Math.random() * 50); await board.listen(port);
  const issued = pairing.startPairing();
  const paired = await request(port, '/api/v1/mobile/pair', { token: 'bootstrap-secret', method: 'POST', body: { code: issued.code, deviceName: 'Test phone' } });
  assert.equal(paired.status, 200); assert.equal(paired.body.device.deviceName, 'Test phone'); assert.ok(paired.body.token);
  assert.equal((await request(port, '/api/v1/mobile/health', { token: 'bootstrap-secret' })).status, 401);
  assert.equal((await request(port, '/api/v1/mobile/health', { token: paired.body.token })).status, 200);
  const push = await request(port, '/api/v1/mobile/devices/push-token', { token: paired.body.token, method: 'POST', commandId: 'paired-push-1', body: { pushToken: 'ExponentPushToken[paired]', platform: 'expo' } });
  assert.equal(push.status, 200); assert.equal(store.listMobilePushTokens()[0].deviceId, paired.body.device.deviceId);
  const replayedPush = await request(port, '/api/v1/mobile/devices/push-token', { token: paired.body.token, method: 'POST', commandId: 'paired-push-1', body: { pushToken: 'ExponentPushToken[changed]', platform: 'expo' } });
  assert.equal(replayedPush.status, 200); assert.equal(replayedPush.body.replayed, true);
  const secondCode = pairing.startPairing();
  const second = await request(port, '/api/v1/mobile/pair', { token: 'bootstrap-secret', method: 'POST', commandId: 'pair-test-command-3', body: { code: secondCode.code, deviceName: 'Second phone' } });
  const secondPush = await request(port, '/api/v1/mobile/devices/push-token', { token: second.body.token, method: 'POST', commandId: 'paired-push-1', body: { pushToken: 'ExponentPushToken[second]', platform: 'expo' } });
  assert.equal(secondPush.status, 200); assert.equal(secondPush.body.replayed, false); assert.equal(store.listMobilePushTokens().length, 2);
  const crossDevicePush = await request(port, '/api/v1/mobile/devices/push-token', { token: paired.body.token, method: 'POST', commandId: 'paired-push-2', body: { deviceId: 'other-device', pushToken: 'ExponentPushToken[other]', platform: 'expo' } });
  assert.equal(crossDevicePush.status, 403);
  assert.equal((await request(port, '/api/v1/mobile/pair', { token: 'bootstrap-secret', method: 'POST', body: { code: issued.code, deviceName: 'Second phone' }, commandId: 'pair-test-command-2' })).status, 400);
  pairing.revoke(paired.body.device.deviceId);
  assert.equal((await request(port, '/api/v1/mobile/health', { token: paired.body.token })).status, 401);
  await board.closeServer(); store.close(); console.log('mobile pairing tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
