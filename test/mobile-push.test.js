const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { MobilePushService } = require('../host/mobile/push');

(async () => {
  const store = new SqliteStore({ clock: () => 1000 });
  store.registerMobilePushToken({ deviceId: 'phone-1', pushToken: 'ExponentPushToken[one]', platform: 'expo' });
  store.enqueueNotification({ notificationId: 'push-1', dateKey: 'push-1', notificationClass: 'location', items: [{ summary: 'Private detail must not be pushed' }] });
  const requests = [];
  const service = new MobilePushService({ store, fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }) }; } });
  assert.deepEqual(await service.deliverPending(), { attempted: 1, sent: 1, failed: 0, revoked: 0 });
  assert.equal(requests[0][0].data.notificationId, 'push-1');
  assert.equal(requests[0][0].body, 'A new signal is ready.');
  assert.equal(requests[0][0].channelId, 'default');
  assert.equal(store.listMobilePushWork().length, 0);
  assert.deepEqual(await service.deliverPending(), { attempted: 0, sent: 0, failed: 0, revoked: 0 });
  const device = { deviceId: 'phone-2' };
  store.db.prepare('INSERT INTO mobile_devices(device_id, device_name, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)').run(device.deviceId, 'Revoked phone', 'token-hash-2', 1000, 1000);
  store.registerMobilePushToken({ deviceId: device.deviceId, pushToken: 'ExponentPushToken[two]', platform: 'expo' });
  store.enqueueNotification({ notificationId: 'push-2', dateKey: 'push-2', notificationClass: 'location', items: [{ summary: 'Should not reach revoked device' }] });
  store.revokeMobileDevice(device.deviceId);
  assert.equal(store.listMobilePushWork().some((item) => item.deviceId === device.deviceId), false, 'revoking a device disables its push token');
  store.close();
  console.log('mobile push tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
