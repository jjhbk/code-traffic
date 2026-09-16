const assert = require('node:assert/strict');
const { GMAIL_SCOPE, GMAIL_SEND_SCOPE, GoogleOAuth, GmailProvider } = require('../host/mail/google');

(async () => {
const oauthRequests = [];
const oauth = new GoogleOAuth({ clientId: 'client', clientSecret: 'secret', fetchImpl: async (url, options) => {
  oauthRequests.push({ url, options });
  return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh' }) };
} });
const authUrl = oauth.authorizationUrl({ redirectUri: 'http://127.0.0.1/callback', state: 'state-1' });
assert.match(authUrl, /gmail\.readonly/);
assert.match(authUrl, /gmail\.send/);
assert.match(authUrl, /access_type=offline/);
const pkceUrl = oauth.authorizationUrl({ redirectUri: 'http://127.0.0.1/callback', state: 'state-2', codeChallenge: 'challenge' });
assert.match(pkceUrl, /code_challenge=challenge/);
assert.match(pkceUrl, /code_challenge_method=S256/);
assert.equal((await oauth.exchangeCode('code', 'http://127.0.0.1/callback')).access_token, 'access');
assert.equal(oauthRequests.length, 1);

const calls = [];
const provider = new GmailProvider({ accessToken: 'access', fetchImpl: async (url, options = {}) => {
  calls.push({ url, options });
  if (url.endsWith('/history?startHistoryId=c1&historyTypes=messageAdded&maxResults=500')) return { ok: true, status: 200, json: async () => ({ historyId: 'c2', history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }] }) };
  if (url.endsWith('/messages/m1?format=full')) return { ok: true, status: 200, json: async () => ({ id: 'm1', threadId: 't1', historyId: 'h1', payload: { headers: [{ name: 'From', value: 'a@example.com' }], body: { data: 'SGk=' } } }) };
  if (url.endsWith('/messages/send')) return { ok: true, status: 200, json: async () => ({ threadId: 't1' }) };
  if (url.endsWith('/threads/t1?format=full')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'sent-1', threadId: 't1', payload: { headers: [{ name: 'To', value: 'a@example.com' }, { name: 'Subject', value: 'Re: Hello' }], body: { data: 'VGhhbmtz' } } }] }) };
  throw new Error(`Unexpected URL ${url}`);
} });

  const result = await provider.sync({ cursor: 'c1' });
  assert.equal(result.nextCursor, 'c2');
  assert.equal(result.messages[0].body, 'Hi');
  const sent = await provider.sendReply({ to: 'a@example.com', subject: 'Re: Hello', body: 'Thanks', threadId: 't1' });
  assert.equal(sent.id, undefined);
  assert.equal(GMAIL_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/gmail.send');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url.endsWith('/messages/send'), true);
  assert.equal(calls[2].options.method, 'POST');
  assert.match(calls[2].options.body, /threadId/);
  const reconciled = await provider.reconcileReply({ to: 'a@example.com', subject: 'Re: Hello', body: 'Thanks', threadId: 't1' });
  assert.deepEqual(reconciled, { found: true, messageId: 'sent-1', threadId: 't1' });
  console.log('Google mail tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
