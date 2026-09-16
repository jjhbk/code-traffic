const assert = require('node:assert/strict');
const { normalizeMessage, candidateFilters } = require('../host/mail/normalize');
const { candidateFromObservation } = require('../host/tasks/extract');
const { evaluateFixtures } = require('../host/tasks/evaluation');

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
assert.equal(candidateFilters({ direction: 'incoming', subject: 'Attachment', body: 'Please find attached the report.' }).eligible, false);
assert.equal(candidateFromObservation({ observationId: 'update', threadId: 'existing', subject: 'Status', body: 'The report is attached.', direction: 'incoming' }, {
  filters: { eligible: true, existingTaskUpdate: true },
}).candidateId, 'update:local-1');
const evaluation = evaluateFixtures([
  { id: 'request', expected: true, observation: { observationId: '1', threadId: '1', subject: 'Review', body: 'Could you review this by Friday?', direction: 'incoming' } },
  { id: 'promise', expected: true, observation: { observationId: '2', threadId: '2', subject: 'Handoff', body: "I'll send it tomorrow.", direction: 'outgoing' } },
  { id: 'newsletter', expected: false, observation: { observationId: '3', threadId: '3', subject: 'Weekly update', body: 'Please find attached our newsletter.', direction: 'incoming' } },
  { id: 'receipt', expected: false, observation: { observationId: '4', threadId: '4', subject: 'Receipt', body: 'Your payment was received.', direction: 'incoming' } },
]);
assert.equal(evaluation.precision, 1);
assert.equal(evaluation.recall, 1);
assert.notEqual(incoming.observationId, outgoing.observationId);
console.log('mail normalization tests passed');
