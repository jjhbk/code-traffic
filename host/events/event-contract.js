const crypto = require('crypto');

const EVENT_TYPES = new Set(['working', 'approval', 'done', 'closed']);
const INGEST_KINDS = new Set(['state', 'observation', 'marker', 'settlement']);

function normalizeEvent(input = {}, { adapterId = 'hook', producerEpoch = null } = {}) {
  const state = input.state || input.type;
  if (!EVENT_TYPES.has(state)) throw new Error('Unsupported event type.');
  const eventId = typeof input.eventId === 'string' && input.eventId.trim()
    ? input.eventId.trim()
    : crypto.randomUUID();
  const sequence = input.sequence == null ? null : Number(input.sequence);
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) throw new Error('Event sequence must be a non-negative integer.');
  return {
    eventId,
    adapterId: String(input.adapterId || adapterId),
    producerEpoch: input.producerEpoch || producerEpoch,
    sequence,
    type: state,
    tile: input.tile || null,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  };
}

function normalizeIngestEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Event payload must be an object.');
  const kind = String(input.kind || input.eventType || '').trim();
  if (!INGEST_KINDS.has(kind)) throw new Error('Unsupported ingest event kind.');
  const source = String(input.source || '').trim();
  const actorId = String(input.actorId || input.actor_id || '').trim();
  if (!source || !actorId) throw new Error('Ingest events require a source and actor ID.');
  const sequence = input.seq == null ? (input.sequence == null ? null : Number(input.sequence)) : Number(input.seq);
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) throw new Error('Event sequence must be a non-negative integer.');
  if (kind === 'state' && !EVENT_TYPES.has(input.state)) throw new Error('Unsupported state event.');
  return {
    eventId: typeof input.eventId === 'string' && input.eventId.trim() ? input.eventId.trim() : crypto.randomUUID(),
    adapterId: `${source}:${actorId}`,
    producerEpoch: input.producerEpoch || input.producer_epoch || null,
    sequence,
    type: kind,
    payload: { actorId, state: kind === 'state' ? input.state : undefined, ...(input.payload && typeof input.payload === 'object' ? input.payload : {}) },
  };
}

module.exports = { EVENT_TYPES, INGEST_KINDS, normalizeEvent, normalizeIngestEvent };
