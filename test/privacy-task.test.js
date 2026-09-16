const assert = require('node:assert/strict');
const { EntityVault, PrivacyGateway } = require('../host/privacy/gateway');
const { candidateFromObservation } = require('../host/tasks/extract');

 (async () => {
const vault = new EntityVault();
const gateway = new PrivacyGateway({ vault });
const first = gateway.pseudonymize('Email me@example.com or call +1 (555) 123-4567.');
const second = gateway.pseudonymize('Reply to me@example.com.');
assert.match(first.text, /\[email:ent_[a-f0-9]+\]/);
assert.match(first.text, /\[phone:ent_[a-f0-9]+\]/);
assert.match(second.text, /\[email:ent_[a-f0-9]+\]/);
assert.equal(first.offsets[0].sourceStart, 6);
assert.equal(vault.rehydrate(first.offsets[0].entityId, 'email'), 'me@example.com');
assert.throws(() => vault.rehydrate(first.offsets[0].entityId, 'phone'), /mismatched/);
assert.equal(await gateway.infer({ body: 'me@example.com' }), null);

const observation = { observationId: 'obs-1', threadId: 'thread-1', subject: 'Friday handoff', body: "I'll send the handoff by Friday.", direction: 'outgoing' };
const candidate = candidateFromObservation(observation, { filters: { eligible: true } });
assert.equal(candidate.owner, 'self');
assert.equal(candidate.blocker, 'counterparty');
assert.equal(candidate.dueDate, 'friday');
assert.equal(candidate.evidence.text.includes('by Friday'), true);
console.log('privacy and task tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
