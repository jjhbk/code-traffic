const { URL, URLSearchParams } = require('url');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GOOGLE_CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';

function encodeSyncCursor(value) {
  return `sb1.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

function decodeSyncCursor(value, kind) {
  if (typeof value !== 'string' || !value.startsWith('sb1.')) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8'));
    return parsed?.kind === kind ? parsed : null;
  } catch (_) {
    return null;
  }
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function bodyFromPayload(payload) {
  if (!payload) return '';
  if (payload.body?.data) return base64UrlDecode(payload.body.data);
  return (payload.parts || []).map((part) => part.mimeType === 'text/plain' || part.mimeType === 'text/html'
    ? bodyFromPayload(part) : '').filter(Boolean).join('\n');
}

function headersFromPayload(payload) {
  return payload?.headers || [];
}

class GoogleOAuth {
  constructor({ clientId, clientSecret = null, fetchImpl = globalThis.fetch } = {}) {
    if (!clientId) throw new Error('Google OAuth client ID is required.');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
  }

  authorizationUrl({ redirectUri, state, codeChallenge } = {}) {
    if (!redirectUri || !state) throw new Error('A redirect URI and state are required.');
    const url = new URL(AUTH_ENDPOINT);
    const parameters = {
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: `${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE} ${GOOGLE_CALENDAR_READ_SCOPE} ${GOOGLE_CALENDAR_EVENTS_SCOPE} ${GOOGLE_DRIVE_READ_SCOPE}`,
      access_type: 'offline',
      include_granted_scopes: 'true',
      state,
      prompt: 'consent',
    };
    if (codeChallenge) {
      parameters.code_challenge = codeChallenge;
      parameters.code_challenge_method = 'S256';
    }
    url.search = new URLSearchParams(parameters);
    return url.toString();
  }

  async exchangeCode(code, redirectUri, codeVerifier = null) {
    return this.tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code', ...(codeVerifier ? { code_verifier: codeVerifier } : {}) });
  }

  async refresh(refreshToken) {
    return this.tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  async tokenRequest(parameters) {
    const response = await this.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, ...(this.clientSecret ? { client_secret: this.clientSecret } : {}), ...parameters }).toString(),
    });
    let body = {};
    try { body = await response.json(); } catch (_) { body = {}; }
    if (!response.ok) throw new Error(`Google OAuth token request failed: ${body.error_description || body.error || response.status}`);
    return body;
  }
}

class GoogleCalendarProvider {
  constructor({ accessToken, refreshToken = null, oauth = null, fetchImpl = globalThis.fetch } = {}) {
    if (!accessToken && !refreshToken) throw new Error('A Google Calendar access or refresh token is required.');
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.oauth = oauth;
    this.fetch = fetchImpl;
  }

  async sync({ cursor = null, boundedWindow = 100 } = {}) {
    const events = [];
    const continuation = decodeSyncCursor(cursor, 'calendar-page');
    const syncToken = continuation?.syncToken || (cursor || null);
    let pageToken = continuation?.pageToken || null;
    let result;
    do {
      const parameters = new URLSearchParams({ singleEvents: 'true', maxResults: String(Math.min(2500, boundedWindow)) });
      if (syncToken) parameters.set('syncToken', syncToken);
      else parameters.set('orderBy', 'startTime');
      if (pageToken) parameters.set('pageToken', pageToken);
      try { result = await this.request(`/events?${parameters}`); } catch (error) {
        if (error.status === 410 && cursor) { const expired = new Error('Google Calendar sync cursor expired.'); expired.code = 'CURSOR_EXPIRED'; throw expired; }
        throw error;
      }
      events.push(...(result.items || []));
      pageToken = result.nextPageToken || null;
      if (pageToken && events.length >= boundedWindow) {
        return {
          messages: events.slice(0, boundedWindow).map((event) => this.normalizeEvent(event)),
          nextCursor: encodeSyncCursor({ kind: 'calendar-page', syncToken: result.nextSyncToken || syncToken, pageToken }),
        };
      }
    } while (pageToken);
    return { messages: events.slice(0, boundedWindow).map((event) => this.normalizeEvent(event)), nextCursor: result?.nextSyncToken || syncToken || null };
  }

  normalizeEvent(event = {}) {
    const start = event.start?.dateTime || event.start?.date || null;
    const end = event.end?.dateTime || event.end?.date || null;
    return {
      provider: 'google-calendar', id: event.id, threadId: `calendar:${event.id}`, etag: event.etag || event.updated || null,
      subject: event.summary || '(untitled event)', body: [event.description, event.location, start && `Starts: ${start}`, end && `Ends: ${end}`].filter(Boolean).join('\n'),
      description: event.description || '', location: event.location || '', start, end,
      timestamp: start, labels: event.status ? [event.status] : [], direction: 'incoming', from: event.organizer?.email || '', to: [],
    };
  }

  async getEvent(eventId) {
    if (!eventId) throw new Error('A Google Calendar event ID is required.');
    return this.request(`/events/${encodeURIComponent(eventId)}`);
  }

  async updateEvent(eventId, changes = {}, { etag = null } = {}) {
    const current = await this.getEvent(eventId);
    if (etag && current.etag && etag !== current.etag) {
      const error = new Error('This calendar event changed elsewhere. Refresh the calendar and review the edit again.');
      error.code = 'PRECONDITION_FAILED';
      throw error;
    }
    const allowed = ['summary', 'description', 'location', 'start', 'end'];
    const updated = { ...current };
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(changes, key)) updated[key] = changes[key];
    return this.request(`/events/${encodeURIComponent(eventId)}`, { method: 'PUT', headers: { 'If-Match': current.etag || '' }, body: JSON.stringify(updated) });
  }

  async deleteEvent(eventId, { etag = null } = {}) {
    const current = await this.getEvent(eventId);
    if (etag && current.etag && etag !== current.etag) {
      const error = new Error('This calendar event changed elsewhere. Refresh before deleting it.');
      error.code = 'PRECONDITION_FAILED';
      throw error;
    }
    return this.request(`/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers: { 'If-Match': current.etag || '' } });
  }

  async request(pathname, options = {}) {
    if (!this.accessToken) {
      if (!this.oauth || !this.refreshToken) throw new Error('Google Calendar access token is unavailable.');
      const tokens = await this.oauth.refresh(this.refreshToken); this.accessToken = tokens.access_token;
    }
    let response = await this.fetch(`https://www.googleapis.com/calendar/v3/calendars/primary${pathname}`, { ...options, headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers || {}) } });
    if (response.status === 401 && this.oauth && this.refreshToken) {
      const tokens = await this.oauth.refresh(this.refreshToken); this.accessToken = tokens.access_token;
      response = await this.fetch(`https://www.googleapis.com/calendar/v3/calendars/primary${pathname}`, { ...options, headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers || {}) } });
    }
    let body = {};
    try { body = await response.json(); } catch (_) { body = {}; }
    if (!response.ok) { const error = new Error(`Google Calendar API request failed: ${body.error?.message || response.status}`); error.status = response.status; throw error; }
    return body;
  }
}

class GoogleDriveProvider {
  constructor({ accessToken, refreshToken = null, oauth = null, fetchImpl = globalThis.fetch } = {}) {
    if (!accessToken && !refreshToken) throw new Error('A Google Drive access or refresh token is required.');
    this.accessToken = accessToken; this.refreshToken = refreshToken; this.oauth = oauth; this.fetch = fetchImpl;
  }

  async sync({ cursor = null, boundedWindow = 100 } = {}) {
    const query = new URLSearchParams({ q: 'trashed = false', pageSize: String(Math.min(1000, boundedWindow)), orderBy: 'modifiedTime desc', fields: 'nextPageToken,files(id,name,mimeType,description,modifiedTime,webViewLink,owners(emailAddress))' });
    if (cursor) query.set('pageToken', cursor);
    let result;
    try { result = await this.request(`/files?${query}`); } catch (error) {
      if (cursor && [400, 410].includes(error.status)) { const expired = new Error('Google Drive sync cursor expired.'); expired.code = 'CURSOR_EXPIRED'; throw expired; }
      throw error;
    }
    return { messages: (result.files || []).slice(0, boundedWindow).map((file) => ({ provider: 'google-drive', id: file.id, threadId: `drive:${file.id}`, etag: file.modifiedTime, subject: file.name || '(unnamed file)', body: [file.mimeType, file.description, file.webViewLink].filter(Boolean).join('\n'), timestamp: file.modifiedTime, from: file.owners?.[0]?.emailAddress || '', to: [], labels: [file.mimeType].filter(Boolean) })), nextCursor: result.nextPageToken || null };
  }

  async request(pathname, options = {}) {
    if (!this.accessToken) { if (!this.oauth || !this.refreshToken) throw new Error('Google Drive access token is unavailable.'); this.accessToken = (await this.oauth.refresh(this.refreshToken)).access_token; }
    let response = await this.fetch(`https://www.googleapis.com/drive/v3${pathname}`, { ...options, headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers || {}) } });
    if (response.status === 401 && this.oauth && this.refreshToken) { this.accessToken = (await this.oauth.refresh(this.refreshToken)).access_token; response = await this.fetch(`https://www.googleapis.com/drive/v3${pathname}`, { ...options, headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers || {}) } }); }
    const body = await response.json();
    if (!response.ok) { const error = new Error(`Google Drive API request failed: ${body.error?.message || response.status}`); error.status = response.status; throw error; }
    return body;
  }
}

class GmailProvider {
  constructor({ accessToken, refreshToken = null, oauth = null, fetchImpl = globalThis.fetch } = {}) {
    if (!accessToken && !refreshToken) throw new Error('A Gmail access or refresh token is required.');
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.oauth = oauth;
    this.fetch = fetchImpl;
  }

  async sync({ cursor = null, boundedWindow = 100 } = {}) {
    const historyContinuation = decodeSyncCursor(cursor, 'gmail-history');
    if (cursor && (!cursor.startsWith('sb1.') || historyContinuation)) {
      try {
        const ids = new Map();
        let pageToken = historyContinuation?.pageToken || null;
        const historyCursor = historyContinuation?.historyId || cursor;
        let nextHistoryId = historyContinuation?.nextHistoryId || historyCursor;
        do {
          const query = new URLSearchParams({ startHistoryId: String(historyCursor), historyTypes: 'messageAdded', maxResults: '500' });
          if (pageToken) query.set('pageToken', pageToken);
          const history = await this.request(`/history?${query}`);
          for (const entry of history.history || []) for (const added of entry.messagesAdded || []) ids.set(added.message.id, added.message.threadId);
          nextHistoryId = history.historyId || nextHistoryId;
          pageToken = history.nextPageToken || null;
          if (pageToken && ids.size >= boundedWindow) {
            const messages = await Promise.all([...ids.keys()].slice(0, boundedWindow).map((id) => this.message(id)));
            return { messages, nextCursor: encodeSyncCursor({ kind: 'gmail-history', historyId: historyCursor, nextHistoryId, pageToken }) };
          }
        } while (pageToken);
        const messages = await Promise.all([...ids.keys()].map((id) => this.message(id)));
        return { messages: messages.slice(0, boundedWindow), nextCursor: nextHistoryId };
      } catch (error) {
        if (error.status === 404) {
          const expired = new Error('Gmail history cursor expired.');
          expired.code = 'CURSOR_EXPIRED';
          throw expired;
        }
        throw error;
      }
    }

    const bootstrapContinuation = decodeSyncCursor(cursor, 'gmail-bootstrap');
    const labels = ['INBOX', 'SENT'];
    const ids = new Map();
    let labelIndex = bootstrapContinuation?.labelIndex || 0;
    let pageToken = bootstrapContinuation?.pageToken || null;
    for (; labelIndex < labels.length; labelIndex += 1) {
      const labelId = labels[labelIndex];
      do {
        const query = new URLSearchParams({ labelIds: labelId, maxResults: String(Math.min(500, boundedWindow)) });
        if (pageToken) query.set('pageToken', pageToken);
        const listed = await this.request(`/messages?${query}`);
        for (const message of listed.messages || []) ids.set(message.id, message.threadId);
        pageToken = listed.nextPageToken || null;
        if (pageToken && ids.size >= boundedWindow) {
          const messages = await Promise.all([...ids.keys()].slice(0, boundedWindow).map((id) => this.message(id)));
          return { messages, nextCursor: encodeSyncCursor({ kind: 'gmail-bootstrap', labelIndex, pageToken }) };
        }
      } while (pageToken);
      pageToken = null;
    }
    const messages = await Promise.all([...ids.keys()].slice(0, boundedWindow).map((id) => this.message(id)));
    const profile = await this.request('/profile');
    return { messages, nextCursor: profile.historyId || null };
  }

  async message(id) {
    const raw = await this.request(`/messages/${encodeURIComponent(id)}?format=full`);
    return {
      provider: 'gmail',
      id: raw.id,
      threadId: raw.threadId,
      historyId: raw.historyId,
      internalDate: raw.internalDate,
      headers: headersFromPayload(raw.payload),
      body: bodyFromPayload(raw.payload),
      labels: raw.labelIds || [],
    };
  }

  async sendReply({ to, subject, body, threadId, inReplyTo = null, references = null, signalBoxAttemptId = null } = {}) {
    if (!to || !/^\S+@\S+\.\S+$/.test(to)) throw new Error('A valid reply recipient is required.');
    if (!subject || !String(body || '').trim()) throw new Error('Reply subject and body are required.');
    if (!threadId) throw new Error('A Gmail thread ID is required for a reply.');
    const headers = [`To: ${to}`, `Subject: ${String(subject).replace(/[\r\n]/g, ' ')}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8'];
    if (signalBoxAttemptId) headers.splice(2, 0, `X-Signal-Box-Attempt: ${String(signalBoxAttemptId).replace(/[\r\n]/g, ' ')}`);
    if (inReplyTo) headers.splice(1, 0, `In-Reply-To: ${String(inReplyTo).replace(/[\r\n]/g, ' ')}`);
    if (references) headers.splice(2, 0, `References: ${String(references).replace(/[\r\n]/g, ' ')}`);
    const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${String(body).replace(/[\r\n]+$/, '')}\r\n`, 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return this.request('/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw, threadId }) });
  }

  async reconcileReply({ to, subject, body, threadId, signalBoxAttemptId = null, sentAfter = null, accountAddress = null } = {}) {
    if (!to || !subject || !body || !threadId) throw new Error('Reply reconciliation requires the original message details.');
    const thread = await this.request(`/threads/${encodeURIComponent(threadId)}?format=full`);
    const wantedBody = String(body).trim();
    const match = (thread.messages || []).find((message) => {
      const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [String(header.name || '').toLowerCase(), String(header.value || '')]));
      if (signalBoxAttemptId && headers['x-signal-box-attempt'] === String(signalBoxAttemptId)) return true;
      if (sentAfter !== null && Number(message.internalDate || 0) < Number(sentAfter)) return false;
      if (accountAddress && !String(headers.from || '').toLowerCase().includes(String(accountAddress).toLowerCase())) return false;
      if (!headers.to?.toLowerCase().includes(String(to).toLowerCase()) || headers.subject !== subject) return false;
      return bodyFromPayload(message.payload).includes(wantedBody);
    });
    return match ? { found: true, messageId: match.id, threadId: match.threadId || threadId } : { found: false, threadId };
  }

  async request(pathname, options = {}) {
    if (!this.accessToken) {
      if (!this.oauth || !this.refreshToken) throw new Error('Gmail access token is unavailable.');
      const tokens = await this.oauth.refresh(this.refreshToken);
      this.accessToken = tokens.access_token;
    }
    let response = await this.fetch(`${API_ROOT}${pathname}`, { ...options, headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers || {}) } });
    if (response.status === 401 && this.oauth && this.refreshToken) {
      const tokens = await this.oauth.refresh(this.refreshToken);
      this.accessToken = tokens.access_token;
      response = await this.fetch(`${API_ROOT}${pathname}`, { ...options, headers: { Authorization: `Bearer ${this.accessToken}`, ...(options.headers || {}) } });
    }
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(`Gmail API request failed: ${body.error?.message || response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }
}

module.exports = { GMAIL_SCOPE, GMAIL_SEND_SCOPE, GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_DRIVE_READ_SCOPE, GoogleOAuth, GmailProvider, GoogleCalendarProvider, GoogleDriveProvider, bodyFromPayload };
