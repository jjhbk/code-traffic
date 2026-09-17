const crypto = require('crypto');
const { GoogleOAuth, GmailProvider, GoogleCalendarProvider, GoogleDriveProvider } = require('./google');

// Owns the credential-to-provider boundary for the Electron core. Callers get
// a provider capability, never raw refresh tokens; instances are reused so a
// refreshed access token and connection state survive individual jobs.
class GoogleProviderHost {
  constructor({ credentialStore, clientId = '', constructors = {} } = {}) {
    if (!credentialStore || typeof credentialStore.load !== 'function') throw new Error('A Google provider host requires a credential store.');
    this.credentials = credentialStore;
    this.clientId = clientId;
    this.constructors = { gmail: GmailProvider, calendar: GoogleCalendarProvider, drive: GoogleDriveProvider, ...constructors };
    this.cache = new Map();
    this.credentialVersion = null;
  }

  account() { return this.credentials.load('gmail-account') || null; }

  provider(kind) {
    if (!this.constructors[kind]) throw new Error(`Unsupported Google provider: ${kind}.`);
    const values = this._credentialValues();
    if (!values.refreshToken || !values.clientId) throw new Error(`Connect Google before using ${kind}.`);
    const version = fingerprint(values);
    if (this.credentialVersion !== version) { this.cache.clear(); this.credentialVersion = version; }
    if (!this.cache.has(kind)) {
      const oauth = new GoogleOAuth({ clientId: values.clientId, clientSecret: values.clientSecret || null });
      const Provider = this.constructors[kind];
      this.cache.set(kind, new Provider({ refreshToken: values.refreshToken, oauth }));
    }
    return this.cache.get(kind);
  }

  clear() { this.cache.clear(); this.credentialVersion = null; }

  _credentialValues() {
    return {
      refreshToken: this.credentials.load('gmail-refresh-token'),
      clientId: this.credentials.load('gmail-client-id') || this.clientId || '',
      clientSecret: this.credentials.load('gmail-client-secret') || null,
    };
  }
}

function fingerprint(values) {
  return crypto.createHash('sha256').update([values.refreshToken || '', values.clientId || '', values.clientSecret || ''].join('\0')).digest('hex');
}

module.exports = { GoogleProviderHost, fingerprint };
