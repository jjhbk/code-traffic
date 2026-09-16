const crypto = require('crypto');

function headerMap(headers = []) {
  return Object.fromEntries(headers
    .map((header) => [String(header.name || '').toLowerCase(), String(header.value || '')])
    .filter(([name]) => name));
}

function stripQuotedText(body) {
  return String(body || '')
    .replace(/^>.*(?:\r?\n|$)/gm, '')
    .replace(/\r?\nOn .*wrote:\s*\r?\n[\s\S]*$/i, '')
    .replace(/\r?\n-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function addressList(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeMessage(raw, { accountAddress = '' } = {}) {
  if (!raw?.id || !raw.threadId) throw new Error('A message id and thread id are required.');
  const headers = headerMap(raw.headers || raw.payload?.headers);
  const from = headers.from || raw.from || '';
  const to = addressList(headers.to || raw.to);
  const cc = addressList(headers.cc || raw.cc);
  const subject = headers.subject || raw.subject || '';
  const timestamp = raw.internalDate || raw.timestamp || headers.date || null;
  const body = stripQuotedText(raw.body || raw.text || raw.payload?.body?.data || '');
  const direction = accountAddress && from.toLowerCase().includes(accountAddress.toLowerCase()) ? 'outgoing' : 'incoming';
  const sourceVersion = String(raw.historyId || raw.etag || timestamp || 'unknown');
  const observationId = crypto.createHash('sha256').update(`${raw.id}:${sourceVersion}`).digest('hex');
  return {
    observationId,
    provider: raw.provider || 'mail',
    messageId: String(raw.id),
    threadId: String(raw.threadId),
    historyId: raw.historyId || null,
    direction,
    from,
    to,
    cc,
    subject,
    body,
    timestamp,
    timeZone: raw.timeZone || null,
    labels: Array.isArray(raw.labels) ? [...raw.labels] : [],
    attachments: [],
    sourceVersion,
  };
}

function candidateFilters(observation, { existingTaskThreadIds = new Set() } = {}) {
  const body = `${observation.subject}\n${observation.body}`;
  const hasCommitmentLanguage = /\b(i['’]?ll|i will|we['’]?ll|we will|can do|will send|will share|will follow up|please|could you|would you)\b/i.test(body);
  const incomingRequest = observation.direction === 'incoming' && /\b(please|could you|would you|can you|need you to|by (monday|tuesday|wednesday|thursday|friday|tomorrow|today))\b/i.test(body);
  const outgoingCommitment = observation.direction === 'outgoing' && hasCommitmentLanguage;
  const existingTaskUpdate = existingTaskThreadIds.has(observation.threadId);
  return {
    incomingRequest,
    outgoingCommitment,
    existingTaskUpdate,
    eligible: incomingRequest || outgoingCommitment || existingTaskUpdate,
  };
}

module.exports = { normalizeMessage, candidateFilters, stripQuotedText };
