const assert = require('node:assert/strict');
const { normalizeMessage, candidateFilters } = require('../host/mail/normalize');

const incoming = normalizeMessage({
  id: 'm1', threadId: 't1', historyId: 'h1',
  headers: [
    { name: 'From', value: 'client@example.com' },
    { name: 'To', value: 'me@example.com' },
    { name: 'Subject', value: 'Friday handoff' },
  ],
  body: 'Could you send the handoff by Friday?\n\n> Old quoted request',
}, { accountAddress: 'me@example.com' });
assert.equal(incoming.direction, 'incoming');
assert.equal(incoming.body, 'Could you send the handoff by Friday?');
assert.equal(candidateFilters(incoming).incomingRequest, true);
assert.equal(incoming.attachments.length, 0);

const outgoing = normalizeMessage({
  id: 'm2', threadId: 't1', historyId: 'h2',
  headers: [
    { name: 'From', value: 'me@example.com' },
    { name: 'To', value: 'client@example.com' },
    { name: 'Subject', value: 'Re: Friday handoff' },
  ],
  body: "I'll send it Friday.\n\nOn Tue, client@example.com wrote:\nPlease send it.",
}, { accountAddress: 'me@example.com' });
assert.equal(outgoing.direction, 'outgoing');
assert.equal(candidateFilters(outgoing).outgoingCommitment, true);
assert.equal(candidateFilters(outgoing, { existingTaskThreadIds: new Set(['t1']) }).existingTaskUpdate, true);
assert.notEqual(incoming.observationId, outgoing.observationId);
console.log('mail normalization tests passed');
