const EARTH_RADIUS_METERS = 6_371_000;

function distanceMeters(a, b) {
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude); const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude); const lat2 = radians(b.latitude);
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

class MobileContextService {
  constructor({ store, clock = () => Date.now(), maxLocationAgeMs = 15 * 60 * 1000 } = {}) {
    if (!store) throw new Error('Mobile context service requires a store.');
    this.store = store; this.clock = clock; this.maxLocationAgeMs = maxLocationAgeMs;
  }

  savePlace({ placeKey, label, latitude, longitude, radiusMeters = 150, consent = false } = {}) {
    if (!consent || !/^[A-Za-z0-9:_-]{1,80}$/.test(String(placeKey || '')) || !String(label || '').trim()) throw new Error('A named place requires explicit consent, a safe key, and a label.');
    if (!this.validCoordinate(latitude, longitude) || !Number.isFinite(radiusMeters) || radiusMeters < 10 || radiusMeters > 10_000) throw new Error('Place coordinates or radius are invalid.');
    return this.store.upsertContext({ recordType: 'place', recordKey: placeKey, value: { label: String(label).slice(0, 120), latitude: Number(latitude), longitude: Number(longitude), radiusMeters: Number(radiusMeters) }, source: { channel: 'mobile', consentScope: 'saved-place' }, confidence: 'high', confirmed: true });
  }

  processLocation({ eventId, latitude, longitude, accuracy, capturedAt = this.clock() } = {}) {
    if (!eventId || !this.validCoordinate(latitude, longitude) || !Number.isFinite(accuracy) || accuracy < 0 || !Number.isFinite(capturedAt)) return { stale: true, triggers: [] };
    const now = this.clock();
    if (capturedAt > now + 5 * 60 * 1000 || now - capturedAt > this.maxLocationAgeMs) return { stale: true, triggers: [] };
    const places = this.store.listContext({ recordType: 'place' });
    const tasks = this.store.listTasks(); const triggers = [];
    for (const place of places) {
      const placeValue = place.value;
      const distance = distanceMeters({ latitude: Number(latitude), longitude: Number(longitude) }, placeValue);
      if (distance > placeValue.radiusMeters + accuracy) continue;
      for (const task of tasks) {
        const instruction = task.contextTrigger || task.locationTrigger;
        if (!instruction || instruction.type !== 'arrival' || instruction.placeKey !== place.recordKey) continue;
        const cooldownMs = Math.max(60_000, Number(instruction.cooldownMs) || 24 * 60 * 60 * 1000);
        const bucket = Math.floor(capturedAt / cooldownMs);
        const triggerKey = `${task.taskId}:${place.recordKey}:${bucket}`;
        if (!this.store.recordLocationTrigger({ triggerKey, taskId: task.taskId, placeKey: place.recordKey, eventId, triggeredAt: capturedAt })) continue;
        const notification = this.store.enqueueNotification({ notificationId: triggerKey, dateKey: triggerKey, notificationClass: 'location', items: [{ taskId: task.taskId, summary: task.summary, reason: `Arrived at ${placeValue.label}`, evidence: { eventId, accuracy, distanceMeters: Math.round(distance), capturedAt } }] });
        triggers.push({ taskId: task.taskId, placeKey: place.recordKey, notificationId: notification?.notificationId || triggerKey, distanceMeters: Math.round(distance) });
      }
    }
    return { stale: false, triggers };
  }

  validCoordinate(latitude, longitude) { return Number.isFinite(Number(latitude)) && Number(latitude) >= -90 && Number(latitude) <= 90 && Number.isFinite(Number(longitude)) && Number(longitude) >= -180 && Number(longitude) <= 180; }
}

module.exports = { MobileContextService, distanceMeters };
