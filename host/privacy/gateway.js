const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENTITY_PATTERNS = [
  { type: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: 'card', pattern: /\b(?:\d[ -]*?){13,19}\b/g },
  { type: 'phone', pattern: /\b(?:\+?\d[\d .()\-]{7,}\d)\b/g },
  { type: 'url', pattern: /\bhttps?:\/\/[^\s<>]+/gi },
];

class EntityVault {
  constructor({ filename = null, key = null } = {}) {
    this.byValue = new Map();
    this.byId = new Map();
    this.filename = filename;
    this.key = key ? Buffer.from(key) : null;
    if (this.filename && (!this.key || this.key.length !== 32)) throw new Error('An AES-256 key is required for a persistent entity vault.');
    this.load();
  }

  idFor(type, value) {
    const key = `${type}:${String(value).toLowerCase()}`;
    if (this.byValue.has(key)) return this.byValue.get(key);
    const id = `ent_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
    this.byValue.set(key, id);
    this.byId.set(id, { type, value: String(value) });
    this.persist();
    return id;
  }

  rehydrate(id, expectedType = null) {
    const entity = this.byId.get(id);
    if (!entity || (expectedType && entity.type !== expectedType)) throw new Error('Unknown or mismatched entity identifier.');
    return entity.value;
  }

  load() {
    if (!this.filename || !fs.existsSync(this.filename)) return;
    try {
      const envelope = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      const records = JSON.parse(plaintext.toString('utf8'));
      for (const record of Array.isArray(records) ? records : []) {
        if (!record?.id || !record.type || typeof record.value !== 'string') continue;
        this.byValue.set(`${record.type}:${record.value.toLowerCase()}`, record.id);
        this.byId.set(record.id, { type: record.type, value: record.value });
      }
    } catch (error) { throw new Error(`Could not open the encrypted entity vault: ${error.message}`); }
  }

  persist() {
    if (!this.filename) return;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const records = [...this.byId.entries()].map(([id, entity]) => ({ id, ...entity }));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${envelope}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
    try { fs.chmodSync(this.filename, 0o600); } catch (_) { /* User profile ACLs protect Windows files. */ }
  }
}

class PrivacyGateway {
  constructor({ vault = new EntityVault(), localOnly = true, remoteModel = null } = {}) {
    this.vault = vault;
    this.localOnly = localOnly;
    this.remoteModel = remoteModel;
  }

  pseudonymize(text) {
    const input = String(text || '');
    const matches = [];
    for (const { type, pattern } of ENTITY_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of input.matchAll(pattern)) matches.push({ type, value: match[0], start: match.index, end: match.index + match[0].length });
    }
    matches.sort((a, b) => a.start - b.start || a.end - b.end);
    const nonOverlapping = matches.filter((match, index) => index === 0 || match.start >= matches[index - 1].end);
    let output = '';
    let cursor = 0;
    const offsets = [];
    for (const match of nonOverlapping) {
      const id = this.vault.idFor(match.type, match.value);
      const replacement = `[${match.type}:${id}]`;
      output += input.slice(cursor, match.start) + replacement;
      offsets.push({ entityId: id, type: match.type, sourceStart: match.start, sourceEnd: match.end, outputStart: output.length - replacement.length, outputEnd: output.length });
      cursor = match.end;
    }
    output += input.slice(cursor);
    return { text: output, offsets };
  }

  prepareRemotePayload(payload, allowedFields = Object.keys(payload || {})) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Privacy gateway payload must be an object.');
    const safe = {};
    for (const key of allowedFields) {
      if (!(key in payload)) continue;
      const value = payload[key];
      safe[key] = typeof value === 'string' ? this.pseudonymize(value).text : value;
    }
    return safe;
  }

  async infer(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Privacy gateway payload must be an object.');
    if (this.localOnly) return null;
    if (!this.remoteModel) throw new Error('Remote inference is unavailable.');
    return this.remoteModel(this.prepareRemotePayload(payload));
  }
}

module.exports = { EntityVault, PrivacyGateway };
