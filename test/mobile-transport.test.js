const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isLoopbackHost, resolveMobileTransport } = require('../host/mobile/transport');

(() => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('192.168.1.20'), false);
  assert.equal(resolveMobileTransport({ host: '127.0.0.1' }).protocol, 'http');
  assert.throws(() => resolveMobileTransport({ host: '192.168.1.20' }), /requires both a TLS key and certificate/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-mobile-tls-'));
  const keyPath = path.join(directory, 'key.pem'); const certPath = path.join(directory, 'cert.pem');
  fs.writeFileSync(keyPath, 'test-key'); fs.writeFileSync(certPath, 'test-cert');
  const secure = resolveMobileTransport({ host: '192.168.1.20', advertisedHost: 'assistant.local', keyPath, certPath });
  assert.equal(secure.protocol, 'https'); assert.equal(secure.tls, true); assert.equal(secure.advertisedHost, 'assistant.local');
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('mobile transport tests passed');
})();
