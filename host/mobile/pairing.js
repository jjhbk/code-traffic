const crypto = require('crypto');

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

class MobilePairingService {
  constructor({ store, clock = () => Date.now(), pairingLifetimeMs = 10 * 60 * 1000 } = {}) {
    if (!store) throw new Error('Mobile pairing requires a store.');
    this.store = store; this.clock = clock; this.pairingLifetimeMs = pairingLifetimeMs;
  }

  startPairing() {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = this.clock() + this.pairingLifetimeMs;
    this.store.createMobilePairingCode({ codeHash: hash(code), expiresAt });
    return { code, expiresAt };
  }

  pair({ code, deviceName = 'Signal Box mobile' } = {}) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(normalized) || !String(deviceName).trim()) throw new Error('A valid pairing code and device name are required.');
    const token = crypto.randomBytes(32).toString('hex');
    const deviceId = crypto.randomUUID();
    const device = this.store.consumeMobilePairingCode({ codeHash: hash(normalized), deviceId, deviceName, tokenHash: hash(token) });
    return { device, token };
  }

  authenticate(token) { return this.store.authenticateMobileDevice(hash(token)); }
  revoke(deviceId) { return this.store.revokeMobileDevice(deviceId); }
  devices() { return this.store.listMobileDevices(); }
}

module.exports = { MobilePairingService, hash };
