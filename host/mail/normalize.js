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

function classifyMessage({ from = '', subject = '', body = '', labels = [], headers = [] } = {}) {
  const headerNames = new Set(headers.map((header) => String(header.name || '').toLowerCase()));
  const text = `${subject}\n${body}`.toLowerCase();
  const reasons = [];
  let score = 0;
  if (labels.some((label) => ['SPAM', 'TRASH'].includes(String(label).toUpperCase()))) { score = 1; reasons.push('provider spam/trash label'); }
  if (headerNames.has('list-unsubscribe') || headerNames.has('list-id')) { score += 0.55; reasons.push('mailing-list headers'); }
  if (/\b(unsubscribe|manage preferences|view in browser)\b/i.test(text)) { score += 0.25; reasons.push('bulk-mail language'); }
  if (/\b(deal|discount|sale|offer|limited time| promo|newsletter|digest)\b/i.test(text)) { score += 0.2; reasons.push('promotional language'); }
  if (/\b(no[- ]?reply|noreply|marketing|mailer[- ]daemon)@/i.test(String(from))) { score += 0.15; reasons.push('automated sender'); }
  const normalizedScore = Math.min(1, score);
  return { spamScore: normalizedScore, isSpam: normalizedScore >= 0.8, isBulk: normalizedScore >= 0.45, spamReasons: reasons };
}

function normalizeMessage(raw, { accountAddress = '', adapterId = '' } = {}) {
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
  const sourceIdentity = adapterId || raw.provider || 'mail';
  const observationId = crypto.createHash('sha256').update(`${sourceIdentity}:${raw.id}:${sourceVersion}`).digest('hex');
  return {
    observationId,
    adapterId: sourceIdentity,
    provider: raw.provider || 'mail',
    id: raw.id,
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
    etag: raw.etag || null,
    description: raw.description || '',
    location: raw.location || '',
    start: raw.start || null,
    end: raw.end || null,
    sourceVersion,
    ...classifyMessage({ from, subject, body, labels: raw.labels || [], headers: raw.headers || raw.payload?.headers || [] }),
  };
}

function candidateFilters(observation, { existingTaskThreadIds = new Set() } = {}) {
  const body = `${observation.subject}\n${observation.body}`;
  const hasCommitmentLanguage = /\b(i['’]?ll|i will|we['’]?ll|we will|can do|will (?:send|share|follow up|review|provide|finish)|i can|we can)\b/i.test(body);
  const incomingRequest = observation.direction === 'incoming' && /\b(please (?:send|share|review|confirm|provide|finish|follow up)|could you|would you|can you|need you to|by (monday|tuesday|wednesday|thursday|friday|tomorrow|today))\b/i.test(body);
  const outgoingCommitment = observation.direction === 'outgoing' && hasCommitmentLanguage;
  const existingTaskUpdate = existingTaskThreadIds.has(observation.threadId);
  const unwanted = Boolean(observation.isSpam || observation.isBulk);
  return {
    incomingRequest,
    outgoingCommitment,
    existingTaskUpdate,
    eligible: existingTaskUpdate || (!unwanted && (incomingRequest || outgoingCommitment)),
    unwanted,
  };
}

module.exports = { normalizeMessage, candidateFilters, classifyMessage, stripQuotedText };
