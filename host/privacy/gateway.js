const crypto = require('crypto');

const ENTITY_PATTERNS = [
  { type: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: 'phone', pattern: /\b(?:\+?\d[\d .()\-]{7,}\d)\b/g },
];

class EntityVault {
  constructor() { this.byValue = new Map(); this.byId = new Map(); }

  idFor(type, value) {
    const key = `${type}:${String(value).toLowerCase()}`;
    if (this.byValue.has(key)) return this.byValue.get(key);
    const id = `ent_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
    this.byValue.set(key, id);
    this.byId.set(id, { type, value: String(value) });
    return id;
  }

  rehydrate(id, expectedType = null) {
    const entity = this.byId.get(id);
    if (!entity || (expectedType && entity.type !== expectedType)) throw new Error('Unknown or mismatched entity identifier.');
    return entity.value;
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

  async infer(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Privacy gateway payload must be an object.');
    if (this.localOnly) return null;
    if (!this.remoteModel) throw new Error('Remote inference is unavailable.');
    const safe = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string') safe[key] = this.pseudonymize(value).text;
      else safe[key] = value;
    }
    return this.remoteModel(safe);
  }
}

module.exports = { EntityVault, PrivacyGateway };
