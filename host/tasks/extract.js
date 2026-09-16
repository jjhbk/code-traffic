function candidateFromObservation(observation, { filters = null, extractorVersion = 'local-1' } = {}) {
  const text = `${observation.subject}\n${observation.body}`.trim();
  const dueMatch = /\b(by|before|due)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  const commitment = /\b(i['’]?ll|i will|we['’]?ll|we will|please|could you|would you|can you|need you to)\b/i.test(text);
  if (!commitment || (filters && !filters.eligible)) return null;
  const evidenceStart = dueMatch ? Math.max(0, dueMatch.index - 80) : 0;
  const evidenceEnd = dueMatch ? Math.min(text.length, dueMatch.index + dueMatch[0].length + 80) : Math.min(text.length, 240);
  return {
    candidateId: `${observation.observationId}:${extractorVersion}`,
    observationId: observation.observationId,
    threadId: observation.threadId,
    summary: observation.subject || text.slice(0, 120),
    owner: observation.direction === 'outgoing' ? 'self' : 'counterparty',
    blocker: observation.direction === 'incoming' ? 'self' : 'counterparty',
    counterparty: observation.direction === 'incoming' ? observation.from : observation.to?.[0] || null,
    dueDate: dueMatch ? dueMatch[2].toLowerCase() : null,
    dueDateBasis: dueMatch ? 'message-text' : null,
    confidence: dueMatch ? 'medium' : 'low',
    evidence: { start: evidenceStart, end: evidenceEnd, text: text.slice(evidenceStart, evidenceEnd) },
    extractorVersion,
  };
}

module.exports = { candidateFromObservation };
