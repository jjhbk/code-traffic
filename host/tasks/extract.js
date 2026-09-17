const crypto = require('crypto');
const { resolveDueAt } = require('./dates');

function candidateFromObservation(observation, { filters = null, extractorVersion = 'local-1', timeZone = observation?.timeZone || 'UTC', now = Date.now() } = {}) {
  return candidatesFromObservation(observation, { filters, extractorVersion, timeZone, now })[0] || null;
}

function candidatesFromObservation(observation, { filters = null, extractorVersion = 'local-1', timeZone = observation?.timeZone || 'UTC', now = Date.now() } = {}) {
  const text = `${observation.subject}\n${observation.body}`.trim();
  const commitment = /\b(i['’]?ll|i will|we['’]?ll|we will|can do|will (?:send|share|follow up|review|provide|finish)|i can|we can|please (?:send|share|review|confirm|provide|finish|follow up)|could you|would you|can you|need you to)\b/i.test(text);
  const eligibleUpdate = Boolean(filters?.existingTaskUpdate);
  if ((!commitment && !eligibleUpdate) || (filters && !filters.eligible)) return [];
  const clauses = splitObligationClauses(text);
  let searchFrom = 0;
  const candidates = clauses.map((clause, index) => {
    const evidenceStart = text.indexOf(clause, searchFrom);
    if (evidenceStart >= 0) searchFrom = evidenceStart + clause.length;
    return candidateForClause(observation, clause, {
      eligibleUpdate, extractorVersion, index, fallbackText: text, clauseCount: clauses.length,
      evidenceStart: evidenceStart >= 0 ? evidenceStart : 0, timeZone, now,
    });
  }).filter(Boolean);
  return candidates.length ? candidates : [candidateForClause(observation, text, { eligibleUpdate, extractorVersion, index: 0, fallbackText: text, clauseCount: 1 })].filter(Boolean);
}

function candidatesFromStructured(observation, obligations, { filters = null, extractorVersion = 'structured-1', timeZone = observation?.timeZone || 'UTC', now = Date.now() } = {}) {
  if (!Array.isArray(obligations) || (filters && !filters.eligible)) return [];
  const source = `${observation.subject}\n${observation.body}`.trim();
  return obligations.map((obligation, index) => {
    const evidenceText = String(obligation?.evidenceText || '');
    const start = Number(obligation?.evidenceStart);
    const end = Number(obligation?.evidenceEnd);
    if (!evidenceText || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length || source.slice(start, end) !== evidenceText) return null;
    const owner = ['self', 'counterparty', 'uncertain'].includes(obligation.owner) ? obligation.owner : 'uncertain';
    const blocker = ['self', 'counterparty', 'uncertain'].includes(obligation.blocker) ? obligation.blocker : 'uncertain';
    const stableParts = [observation.provider || 'source', observation.threadId, owner, String(observation.direction === 'incoming' ? observation.from : observation.to?.[0] || ''), evidenceText.replace(/\s+/g, ' ').trim().toLowerCase()];
    const obligationKey = `ob_${crypto.createHash('sha256').update(stableParts.join('|')).digest('hex').slice(0, 24)}`;
    return {
      candidateId: `${observation.observationId}:${extractorVersion}:${index}`,
      observationId: observation.observationId,
      threadId: observation.threadId,
      summary: String(obligation.summary || evidenceText).trim().slice(0, 120),
      owner,
      blocker,
      counterparty: obligation.counterparty || (observation.direction === 'incoming' ? observation.from : observation.to?.[0] || null),
      dueDate: obligation.dueDate || null,
      dueDateBasis: obligation.dueDateBasis || null,
      dueAt: resolveDueAt(obligation.dueDate, observation.timestamp, timeZone, now),
      timeZone,
      confidence: ['low', 'medium', 'high'].includes(obligation.confidence) ? obligation.confidence : 'low',
      evidence: { start, end, text: evidenceText },
      extractorVersion,
      obligationKey,
    };
  }).filter(Boolean);
}

function splitObligationClauses(text) {
  return String(text || '').split(/(?:\r?\n+|[.!?]+\s+|,\s+(?:and|then)\s+|\s+(?:and|then)\s+(?=(?:i['’]?ll|i will|we['’]?ll|we will|will|please|could you|would you|can you|need you to)\b))/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 8 && /\b(i['’]?ll|i will|we['’]?ll|we will|will|please|could you|would you|can you|need you to)\b/i.test(clause));
}

function candidateForClause(observation, clause, { eligibleUpdate, extractorVersion, index, fallbackText, clauseCount, evidenceStart = 0, timeZone = observation?.timeZone || 'UTC', now = Date.now() }) {
  const text = String(clause || '').trim();
  const dueMatch = /\b(by|before|due)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  const evidenceText = text || fallbackText;
  const identityText = evidenceText.replace(/\b(by|before|due)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/ig, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const stableParts = [observation.provider || 'source', observation.threadId, observation.direction === 'outgoing' ? 'self' : 'counterparty', observation.direction === 'incoming' ? observation.from : observation.to?.[0] || '', identityText];
  return {
    candidateId: `${observation.observationId}:${extractorVersion}${clauseCount > 1 ? `:${index}` : ''}`,
    observationId: observation.observationId,
    threadId: observation.threadId,
    summary: clauseCount === 1 && observation.subject ? observation.subject : `${observation.subject ? `${observation.subject}: ` : ''}${evidenceText}`.slice(0, 120),
    owner: observation.direction === 'outgoing' ? 'self' : 'counterparty',
    blocker: observation.direction === 'incoming' ? 'self' : 'counterparty',
    counterparty: observation.direction === 'incoming' ? observation.from : observation.to?.[0] || null,
    dueDate: dueMatch ? dueMatch[2].toLowerCase() : null,
    dueDateBasis: dueMatch ? 'message-text' : null,
    dueAt: resolveDueAt(dueMatch?.[2], observation.timestamp, timeZone, now),
    timeZone,
    confidence: eligibleUpdate && !dueMatch ? 'low' : (dueMatch ? 'medium' : 'low'),
    evidence: { start: evidenceStart, end: evidenceStart + evidenceText.length, text: evidenceText },
    extractorVersion,
    obligationKey: `ob_${crypto.createHash('sha256').update(stableParts.join('|')).digest('hex').slice(0, 24)}`,
  };
}

module.exports = { candidateFromObservation, candidatesFromObservation, candidatesFromStructured, splitObligationClauses };
