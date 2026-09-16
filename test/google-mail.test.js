const assert = require('node:assert/strict');
const { classifyMessage, normalizeMessage } = require('../host/mail/normalize');
const { GMAIL_SCOPE, GMAIL_SEND_SCOPE, GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_DRIVE_READ_SCOPE, GoogleOAuth, GmailProvider, GoogleCalendarProvider, GoogleDriveProvider } = require('../host/mail/google');

(async () => {
const oauthRequests = [];
const oauth = new GoogleOAuth({ clientId: 'client', clientSecret: 'secret', fetchImpl: async (url, options) => {
  oauthRequests.push({ url, options });
  return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh' }) };
} });
const authUrl = oauth.authorizationUrl({ redirectUri: 'http://127.0.0.1/callback', state: 'state-1' });
assert.match(authUrl, /gmail\.readonly/);
assert.match(authUrl, /gmail\.send/);
assert.match(authUrl, /calendar\.readonly/);
assert.match(authUrl, /calendar\.events/);
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
  assert.equal(GOOGLE_CALENDAR_READ_SCOPE, 'https://www.googleapis.com/auth/calendar.readonly');
  assert.equal(GOOGLE_CALENDAR_EVENTS_SCOPE, 'https://www.googleapis.com/auth/calendar.events');
  assert.equal(GOOGLE_DRIVE_READ_SCOPE, 'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url.endsWith('/messages/send'), true);
  assert.equal(calls[2].options.method, 'POST');
  assert.match(calls[2].options.body, /threadId/);
  const reconciled = await provider.reconcileReply({ to: 'a@example.com', subject: 'Re: Hello', body: 'Thanks', threadId: 't1' });
  assert.deepEqual(reconciled, { found: true, messageId: 'sent-1', threadId: 't1' });
  const calendar = new GoogleCalendarProvider({ accessToken: 'access', fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ nextSyncToken: 'cal-2', items: [{ id: 'event-1', summary: 'Design review', start: { dateTime: '2026-09-18T15:00:00Z' }, end: { dateTime: '2026-09-18T16:00:00Z' }, organizer: { email: 'organizer@example.com' } }] }) }) });
  const calendarResult = await calendar.sync({ cursor: 'cal-1' });
  assert.equal(calendarResult.nextCursor, 'cal-2');
  assert.equal(calendarResult.messages[0].subject, 'Design review');
  assert.equal(calendarResult.messages[0].threadId, 'calendar:event-1');
  const calendarCalls = [];
  const editableCalendar = new GoogleCalendarProvider({ accessToken: 'access', fetchImpl: async (url, options = {}) => {
    calendarCalls.push({ url, options });
    if (url.endsWith('/events/event-1')) return { ok: true, status: 200, json: async () => ({ id: 'event-1', etag: 'etag-1', summary: 'Old', start: { dateTime: '2026-09-18T15:00:00Z' }, end: { dateTime: '2026-09-18T16:00:00Z' } }) };
    throw new Error(`Unexpected calendar URL ${url}`);
  } });
  const updatedEvent = await editableCalendar.updateEvent('event-1', { summary: 'New title' }, { etag: 'etag-1' });
  assert.equal(updatedEvent.summary, 'Old');
  assert.equal(calendarCalls[1].options.method, 'PUT');
  assert.match(calendarCalls[1].options.body, /New title/);
  await assert.rejects(() => editableCalendar.updateEvent('event-1', { summary: 'Conflict' }, { etag: 'stale' }), (error) => error.code === 'PRECONDITION_FAILED');
  const drive = new GoogleDriveProvider({ accessToken: 'access', fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ nextPageToken: 'drive-2', files: [{ id: 'file-1', name: 'Brief', mimeType: 'text/plain', modifiedTime: '2026-09-18T15:00:00Z', webViewLink: 'https://drive.google.com/file/file-1' }] }) }) });
  const driveResult = await drive.sync({ boundedWindow: 10 });
  assert.equal(driveResult.nextCursor, 'drive-2');
  assert.equal(driveResult.messages[0].subject, 'Brief');
  const expiredDrive = new GoogleDriveProvider({ accessToken: 'access', fetchImpl: async () => ({ ok: false, status: 410, json: async () => ({ error: { message: 'expired' } }) }) });
  await assert.rejects(() => expiredDrive.sync({ cursor: 'expired-token' }), (error) => error.code === 'CURSOR_EXPIRED');
  const spam = classifyMessage({ from: 'news@marketing.example', subject: 'Limited time sale', body: 'Unsubscribe from this newsletter', headers: [{ name: 'List-Unsubscribe', value: '<https://example.test/unsubscribe>' }] });
  assert.equal(spam.isBulk, true);
  assert.equal(spam.isSpam, true);
  assert.equal(normalizeMessage({ id: 'spam-1', threadId: 'spam-thread', from: 'news@marketing.example', subject: 'Sale', body: 'Unsubscribe', headers: [{ name: 'List-ID', value: 'news' }] }).isBulk, true);
  console.log('Google mail tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
