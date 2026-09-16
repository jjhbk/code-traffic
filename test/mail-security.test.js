const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProtectedCredentialStore } = require('../host/mail/credentials');
const { consumeCallback, createOAuthState } = require('../host/mail/oauth-callback');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-credentials-'));
const filename = path.join(directory, 'credentials.json');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
};
const credentials = new ProtectedCredentialStore({ filename, safeStorage });
credentials.save('gmail-refresh-token', 'secret-token');
assert.equal(credentials.load('gmail-refresh-token'), 'secret-token');
assert.equal(credentials.has('gmail-refresh-token'), true);
assert.equal(credentials.has('missing'), false);
assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /secret-token/);
assert.throws(() => new ProtectedCredentialStore({ filename, safeStorage: { isEncryptionAvailable: () => false } }), /Refusing to store/);

const state = createOAuthState();
assert.equal(consumeCallback(`/oauth/callback?code=abc&state=${state}`, state), 'abc');
assert.throws(() => consumeCallback('/oauth/callback?code=abc&state=wrong', state), /state mismatch/);
assert.throws(() => consumeCallback(`/oauth/callback?error=access_denied&state=${state}`, state), /authorization failed/);
fs.rmSync(directory, { recursive: true, force: true });
console.log('mail security tests passed');
