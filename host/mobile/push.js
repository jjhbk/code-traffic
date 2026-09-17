class MobilePushService {
  constructor({ store, fetchImpl = globalThis.fetch, endpoint = 'https://exp.host/--/api/v2/push/send' } = {}) {
    if (!store) throw new Error('Mobile push service requires a store.');
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
  }

  async deliverPending({ limit = 50 } = {}) {
    const work = this.store.listMobilePushWork({ limit });
    const result = { attempted: 0, sent: 0, failed: 0, revoked: 0 };
    if (typeof this.fetchImpl !== 'function') return { ...result, skipped: work.length };
    for (const item of work) {
      result.attempted += 1;
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify([{ to: item.pushToken, title: 'Signal Box', body: 'A new signal is ready.', data: { notificationId: item.notificationId }, sound: 'default', priority: 'high' }]),
        });
        const payload = await response.json();
        const ticket = payload?.data?.[0] || payload?.data || {};
        if (!response.ok || ticket.status !== 'ok') {
          const error = ticket.message || ticket.details?.error || `Push provider returned ${response.status}.`;
          this.store.recordMobilePushDelivery({ notificationId: item.notificationId, deviceId: item.deviceId, status: 'failed', error });
          result.failed += 1;
          if (ticket.details?.error === 'DeviceNotRegistered') { this.store.revokeMobilePushToken(item.deviceId); result.revoked += 1; }
          continue;
        }
        this.store.recordMobilePushDelivery({ notificationId: item.notificationId, deviceId: item.deviceId, status: 'sent' });
        result.sent += 1;
      } catch (error) {
        this.store.recordMobilePushDelivery({ notificationId: item.notificationId, deviceId: item.deviceId, status: 'failed', error: error.message });
        result.failed += 1;
      }
    }
    return result;
  }
}

module.exports = { MobilePushService };
