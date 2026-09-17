const assert = require('node:assert/strict');
const { GoogleProviderHost } = require('../host/mail/provider-host');

const values = { 'gmail-refresh-token': 'refresh-1', 'gmail-client-id': 'client-1', 'gmail-client-secret': 'secret-1', 'gmail-account': 'owner@example.com' };
const credentials = { load: (name) => values[name] || null };
let created = 0;
class FixtureProvider { constructor(options) { this.options = options; created += 1; } }
const host = new GoogleProviderHost({ credentialStore: credentials, clientId: 'fallback', constructors: { gmail: FixtureProvider, calendar: null } });
assert.equal(host.account(), 'owner@example.com');
const first = host.provider('gmail');
assert.equal(host.provider('gmail'), first, 'provider instances are reused within one credential version');
assert.equal(created, 1);
values['gmail-refresh-token'] = 'refresh-2';
const second = host.provider('gmail');
assert.notEqual(second, first, 'rotated credentials invalidate the provider cache');
assert.equal(created, 2);
host.clear();
assert.notEqual(host.provider('gmail'), second);
assert.throws(() => host.provider('calendar'), /Unsupported Google provider/);
console.log('provider host tests passed');
