const assert = require('node:assert/strict');
const http = require('node:http');
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
  const pagedCalls = [];
  const pagedProvider = new GmailProvider({ accessToken: 'access', fetchImpl: async (url) => {
    pagedCalls.push(url);
    if (url.includes('/history?')) {
      if (url.includes('pageToken=next')) return { ok: true, status: 200, json: async () => ({ historyId: 'c3', history: [{ messagesAdded: [{ message: { id: 'm2', threadId: 't2' } }] }] }) };
      return { ok: true, status: 200, json: async () => ({ historyId: 'c2', nextPageToken: 'next', history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }] }) };
    }
    if (url.endsWith('/messages/m1?format=full') || url.endsWith('/messages/m2?format=full')) return { ok: true, status: 200, json: async () => ({ id: url.includes('m2') ? 'm2' : 'm1', threadId: 't1', payload: { headers: [], body: { data: 'SGk=' } } }) };
    throw new Error(`Unexpected paged URL ${url}`);
  } });
  const paged = await pagedProvider.sync({ cursor: 'c1', boundedWindow: 10 });
  assert.equal(paged.nextCursor, 'c3');
  assert.equal(paged.messages.length, 2);
  assert.equal(pagedCalls.filter((url) => url.includes('/history?')).length, 2);
  const boundedHistoryCalls = [];
  const boundedHistoryProvider = new GmailProvider({ accessToken: 'access', fetchImpl: async (url) => {
    boundedHistoryCalls.push(url);
    if (url.includes('/history?') && !url.includes('pageToken=next')) return { ok: true, status: 200, json: async () => ({ historyId: 'c2', nextPageToken: 'next', history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }, { message: { id: 'm2', threadId: 't2' } }] }] }) };
    if (url.includes('/history?') && url.includes('pageToken=next')) return { ok: true, status: 200, json: async () => ({ historyId: 'c3', history: [{ messagesAdded: [{ message: { id: 'm3', threadId: 't3' } }] }] }) };
    const id = url.match(/messages\/(m\d+)/)?.[1];
    return { ok: true, status: 200, json: async () => ({ id, threadId: id.replace('m', 't'), payload: { headers: [], body: { data: 'SGk=' } } }) };
  } });
  const firstHistoryPage = await boundedHistoryProvider.sync({ cursor: 'c1', boundedWindow: 1 });
  assert.equal(firstHistoryPage.messages.length, 1);
  assert.match(firstHistoryPage.nextCursor, /^sb1\./);
  const secondHistoryPage = await boundedHistoryProvider.sync({ cursor: firstHistoryPage.nextCursor, boundedWindow: 1 });
  assert.equal(secondHistoryPage.messages[0].id, 'm3');
  assert.equal(secondHistoryPage.nextCursor, 'c3');
  assert.equal(boundedHistoryCalls.filter((url) => url.includes('/history?')).length, 2);
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
  const sandboxRequests = [];
  const sandbox = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    sandboxRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/gmail/v1/users/me/messages/send') {
      response.end(JSON.stringify({ id: 'sandbox-sent', threadId: 'sandbox-thread' }));
      return;
    }
    if (request.url === '/gmail/v1/users/me/threads/sandbox-thread?format=full') {
      response.end(JSON.stringify({ messages: [{ id: 'sandbox-sent', threadId: 'sandbox-thread', internalDate: String(Date.now()), payload: { headers: [{ name: 'X-Signal-Box-Attempt', value: 'sandbox-attempt' }, { name: 'To', value: 'a@example.com' }, { name: 'Subject', value: 'Re: Sandbox' }], body: { data: Buffer.from('Sandbox body').toString('base64url') } } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: 'sandbox route not found' } }));
  });
  await new Promise((resolve) => sandbox.listen(0, '127.0.0.1', resolve));
  const sandboxAddress = sandbox.address();
  const sandboxProvider = new GmailProvider({ accessToken: 'sandbox-token', apiBase: `http://127.0.0.1:${sandboxAddress.port}/gmail/v1/users/me` });
  const sandboxSent = await sandboxProvider.sendReply({ to: 'a@example.com', subject: 'Re: Sandbox', body: 'Sandbox body', threadId: 'sandbox-thread', signalBoxAttemptId: 'sandbox-attempt' });
  assert.equal(sandboxSent.id, 'sandbox-sent');
  assert.deepEqual(await sandboxProvider.reconcileReply({ to: 'a@example.com', subject: 'Re: Sandbox', body: 'Sandbox body', threadId: 'sandbox-thread', signalBoxAttemptId: 'sandbox-attempt' }), { found: true, messageId: 'sandbox-sent', threadId: 'sandbox-thread' });
  assert.equal(sandboxRequests.every((item) => item.authorization === 'Bearer sandbox-token'), true, 'sandbox provider requests carry the configured credential');
  assert.deepEqual(sandboxRequests.map((item) => item.url), ['/gmail/v1/users/me/messages/send', '/gmail/v1/users/me/threads/sandbox-thread?format=full']);
  await new Promise((resolve) => sandbox.close(resolve));
  const preciseProvider = new GmailProvider({ accessToken: 'access', fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => url.includes('/threads/') ? ({ messages: [
    { id: 'old-similar', threadId: 't1', internalDate: '1999999999000', payload: { headers: [{ name: 'To', value: 'a@example.com' }, { name: 'Subject', value: 'Re: Hello' }], body: { data: 'VGhhbmtz' } } },
    { id: 'exact-attempt', threadId: 't1', internalDate: '2000000001000', payload: { headers: [{ name: 'X-Signal-Box-Attempt', value: 'attempt-1' }, { name: 'To', value: 'different@example.com' }], body: { data: 'VW5yZWxhdGVk' } } },
  ] }) : {} }) });
  assert.deepEqual(await preciseProvider.reconcileReply({ to: 'a@example.com', subject: 'Re: Hello', body: 'Thanks', threadId: 't1', signalBoxAttemptId: 'attempt-1', sentAfter: 2000000000000 }), { found: true, messageId: 'exact-attempt', threadId: 't1' });
  const calendar = new GoogleCalendarProvider({ accessToken: 'access', fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ nextSyncToken: 'cal-2', items: [{ id: 'event-1', summary: 'Design review', start: { dateTime: '2026-09-18T15:00:00Z' }, end: { dateTime: '2026-09-18T16:00:00Z' }, organizer: { email: 'organizer@example.com' } }] }) }) });
  const calendarResult = await calendar.sync({ cursor: 'cal-1' });
  assert.equal(calendarResult.nextCursor, 'cal-2');
  assert.equal(calendarResult.messages[0].subject, 'Design review');
  assert.equal(calendarResult.messages[0].threadId, 'calendar:event-1');
  const calendarPages = [];
  const pagedCalendar = new GoogleCalendarProvider({ accessToken: 'access', fetchImpl: async (url) => {
    calendarPages.push(url);
    if (!url.includes('pageToken=cal-next')) return { ok: true, status: 200, json: async () => ({ nextPageToken: 'cal-next', nextSyncToken: 'cal-final', items: [{ id: 'event-page-1', summary: 'Page one', start: { dateTime: '2026-09-18T15:00:00Z' }, end: { dateTime: '2026-09-18T16:00:00Z' } }] }) };
    return { ok: true, status: 200, json: async () => ({ nextSyncToken: 'cal-final', items: [{ id: 'event-page-2', summary: 'Page two', start: { dateTime: '2026-09-18T16:00:00Z' }, end: { dateTime: '2026-09-18T17:00:00Z' } }] }) };
  } });
  const firstCalendarPage = await pagedCalendar.sync({ boundedWindow: 1 });
  assert.equal(firstCalendarPage.messages.length, 1);
  assert.match(firstCalendarPage.nextCursor, /^sb1\./);
  const secondCalendarPage = await pagedCalendar.sync({ cursor: firstCalendarPage.nextCursor, boundedWindow: 1 });
  assert.equal(secondCalendarPage.messages[0].id, 'event-page-2');
  assert.equal(secondCalendarPage.nextCursor, 'cal-final');
  assert.equal(calendarPages.length, 2);
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
  let driveCalls = 0;
  let driveFileCalls = 0;
  const driveCallKinds = [];
  const drive = new GoogleDriveProvider({ accessToken: 'access', fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => {
    driveCalls += 1;
    if (url.includes('/changes/startPageToken')) { driveCallKinds.push('checkpoint'); return { startPageToken: 'drive-start' }; }
    driveCallKinds.push('files');
    driveFileCalls += 1;
    if (driveFileCalls === 1) return { nextPageToken: 'drive-2', files: [{ id: 'file-1', name: 'Brief', mimeType: 'text/plain', modifiedTime: '2026-09-18T15:00:00Z', webViewLink: 'https://drive.google.com/file/file-1' }] };
    return { files: [{ id: 'file-2', name: 'Second', mimeType: 'text/plain', modifiedTime: '2026-09-18T15:30:00Z' }] };
  } }) });
  const driveResult = await drive.sync({ boundedWindow: 10 });
  assert.match(driveResult.nextCursor, /^sb1\./);
  assert.equal(driveResult.messages[0].subject, 'Brief');
  assert.deepEqual(driveCallKinds, ['checkpoint', 'files'], 'Drive bootstrap checkpoints before enumerating files');
  const driveBootstrapResult = await drive.sync({ cursor: driveResult.nextCursor, boundedWindow: 10 });
  assert.equal(driveBootstrapResult.messages[0].subject, 'Second');
  const driveChanges = new GoogleDriveProvider({ accessToken: 'access', fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ newStartPageToken: 'drive-next', changes: [{ fileId: 'file-1', removed: true }, { fileId: 'file-2', file: { id: 'file-2', name: 'Updated', mimeType: 'text/plain', modifiedTime: '2026-09-18T16:00:00Z' } }] }) }) });
  const driveChangesResult = await driveChanges.sync({ cursor: driveBootstrapResult.nextCursor, boundedWindow: 10 });
  assert.equal(driveChangesResult.messages[0].removed, true);
  assert.equal(driveChangesResult.messages[1].subject, 'Updated');
  assert.match(driveChangesResult.nextCursor, /^sb1\./);
  const expiredDrive = new GoogleDriveProvider({ accessToken: 'access', fetchImpl: async () => ({ ok: false, status: 410, json: async () => ({ error: { message: 'expired' } }) }) });
  await assert.rejects(() => expiredDrive.sync({ cursor: 'expired-token' }), (error) => error.code === 'CURSOR_EXPIRED');
  const spam = classifyMessage({ from: 'news@marketing.example', subject: 'Limited time sale', body: 'Unsubscribe from this newsletter', headers: [{ name: 'List-Unsubscribe', value: '<https://example.test/unsubscribe>' }] });
  assert.equal(spam.isBulk, true);
  assert.equal(spam.isSpam, true);
  assert.equal(normalizeMessage({ id: 'spam-1', threadId: 'spam-thread', from: 'news@marketing.example', subject: 'Sale', body: 'Unsubscribe', headers: [{ name: 'List-ID', value: 'news' }] }).isBulk, true);
  console.log('Google mail tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
