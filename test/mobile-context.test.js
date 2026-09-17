const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { MobileContextService } = require('../host/mobile/context');

(() => {
  let now = 1_000_000;
  const store = new SqliteStore({ clock: () => now });
  const context = new MobileContextService({ store, clock: () => now, maxLocationAgeMs: 10_000 });
  context.savePlace({ placeKey: 'home', label: 'Home', latitude: 40, longitude: -73, radiusMeters: 150, consent: true });
  const task = store.saveTaskCandidate({ candidateId: 'pickup-task', observationId: 'pickup-observation', summary: 'Pick up the return', contextTrigger: { type: 'arrival', placeKey: 'home', cooldownMs: 60_000 }, evidence: { start: 0, end: 1, text: 'Pick up the return when you get home.' }, extractorVersion: 'test' });
  const first = context.processLocation({ eventId: 'location-1', latitude: 40, longitude: -73, accuracy: 10, capturedAt: now });
  assert.equal(first.stale, false); assert.equal(first.triggers.length, 1); assert.equal(first.triggers[0].taskId, task.taskId);
  assert.equal(store.listPendingNotifications({ notificationClass: 'location' }).length, 1);
  const duplicate = context.processLocation({ eventId: 'location-2', latitude: 40, longitude: -73, accuracy: 10, capturedAt: now + 1_000 });
  assert.equal(duplicate.triggers.length, 0);
  now += 61_000;
  const second = context.processLocation({ eventId: 'location-3', latitude: 40, longitude: -73, accuracy: 10, capturedAt: now });
  assert.equal(second.triggers.length, 1);
  const stale = context.processLocation({ eventId: 'location-old', latitude: 40, longitude: -73, accuracy: 10, capturedAt: now - 20_000 });
  assert.equal(stale.stale, true); assert.equal(stale.triggers.length, 0);
  store.close(); console.log('mobile context tests passed');
})();
