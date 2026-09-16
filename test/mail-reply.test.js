const assert = require('node:assert/strict');
const { createReplyProposal } = require('../host/actions/mail-reply');

const proposal = createReplyProposal({ to: 'owner@example.com', subject: 'Re: Launch', body: 'I will send this today.', threadId: 'thread-1' });
assert.equal(proposal.capability, 'gmail.send');
assert.equal(proposal.autonomous, false);
assert.equal(proposal.destination, 'owner@example.com');
assert.equal(proposal.content.body, 'I will send this today.');
assert.equal(proposal.options[0].optionId, 'send');
assert.throws(() => createReplyProposal({ to: 'bad', subject: 'x', body: 'y', threadId: 't' }), /valid recipient/);
assert.throws(() => createReplyProposal({ to: 'a@example.com', subject: 'x', body: 'y' }), /thread/);
console.log('Mail reply tests passed');
