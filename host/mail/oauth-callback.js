const crypto = require('crypto');
const http = require('http');

function createOAuthState() { return crypto.randomBytes(32).toString('hex'); }

function consumeCallback(url, expectedState) {
  const parsed = new URL(url, 'http://127.0.0.1');
  if (parsed.searchParams.get('state') !== expectedState) throw new Error('OAuth state mismatch.');
  const error = parsed.searchParams.get('error');
  if (error) throw new Error(`OAuth authorization failed: ${error}`);
  const code = parsed.searchParams.get('code');
  if (!code) throw new Error('OAuth callback did not include an authorization code.');
  return code;
}

function waitForOAuthCallback({ port = 0, expectedState, host = '127.0.0.1', timeoutMs = 120000, onReady = null, onError = null } = {}) {
  if (!expectedState) throw new Error('An OAuth state is required.');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => (error ? reject(error) : resolve(value)));
    };
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url.split('?')[0] !== '/oauth/callback') {
        response.writeHead(404); response.end(); return;
      }
      try {
        const code = consumeCallback(request.url, expectedState);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Signal Box connected. You can close this window.');
        finish(null, code);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(error.message);
        finish(error);
      }
    });
    const timer = setTimeout(() => finish(new Error('OAuth callback timed out.')), timeoutMs);
    timer.unref?.();
    server.once('error', (error) => { onError?.(error); finish(error); });
    server.listen(port, host, () => onReady?.({ host, port: server.address().port }));
  });
}

module.exports = { createOAuthState, consumeCallback, waitForOAuthCallback };
