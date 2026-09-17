const fs = require('fs');
const net = require('net');

function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' || value === '::1' || value === '127.0.0.1' || value === '0:0:0:0:0:0:0:1' || net.isIPv4(value) && value.startsWith('127.');
}

function resolveMobileTransport({ host = '127.0.0.1', advertisedHost = null, keyPath = null, certPath = null, caPath = null } = {}) {
  const loopback = isLoopbackHost(host);
  if (loopback && (!keyPath && !certPath)) return { host, advertisedHost: advertisedHost || host, protocol: 'http', tls: false, serverOptions: null };
  if (!keyPath || !certPath) throw new Error('Remote mobile binding requires both a TLS key and certificate.');
  let key; let cert; let ca;
  try {
    key = fs.readFileSync(keyPath); cert = fs.readFileSync(certPath); if (caPath) ca = fs.readFileSync(caPath);
  } catch (error) { throw new Error(`Mobile TLS certificate could not be loaded: ${error.message}`); }
  return { host, advertisedHost: advertisedHost || host, protocol: 'https', tls: true, serverOptions: { key, cert, ...(ca ? { ca } : {}) } };
}

module.exports = { isLoopbackHost, resolveMobileTransport };
