const crypto = require('crypto');

const EVENT_TYPES = new Set(['working', 'approval', 'done', 'closed']);

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

module.exports = { EVENT_TYPES, normalizeEvent };
