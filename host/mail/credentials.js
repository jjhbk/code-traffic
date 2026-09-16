const fs = require('fs');
const path = require('path');

class ProtectedCredentialStore {
  constructor({ filename, safeStorage } = {}) {
    if (!filename || !safeStorage) throw new Error('A credential path and OS secret store are required.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS-backed secret storage is unavailable. Refusing to store mail credentials.');
    this.filename = filename;
    this.safeStorage = safeStorage;
  }

  save(name, value) {
    if (!name || typeof value !== 'string' || !value) throw new Error('A credential name and value are required.');
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    let records = this.read();
    records[name] = this.safeStorage.encryptString(value).toString('base64');
    fs.writeFileSync(this.filename, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(this.filename, 0o600); } catch (_) { /* User profile ACLs protect Windows files. */ }
  }

  load(name) {
    const encoded = this.read()[name];
    if (!encoded) return null;
    return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  }

  delete(name) {
    const records = this.read();
    if (!(name in records)) return false;
    delete records[name];
    fs.writeFileSync(this.filename, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    return true;
  }

  read() {
    try {
      const records = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      return records && typeof records === 'object' && !Array.isArray(records) ? records : {};
    } catch (_) { return {}; }
  }
}

module.exports = { ProtectedCredentialStore };
