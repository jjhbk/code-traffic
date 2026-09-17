const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { ActionRegistry } = require('../host/actions/registry');

const recipe = { id: 'registry.fixture.v1', origin: 'https://example.com', effects: 'read', inputs: {}, steps: [{ id: 'read', kind: 'read', target: 'title' }] };
const registry = new ActionRegistry({ recipes: [recipe] });
const store = new SqliteStore();
const approvals = new ApprovalService({ store, registry });

const browser = approvals.request({ capability: 'browser.read', recipeId: recipe.id, recipeDigest: recipe.digest, inputs: {} }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 60_000 });
assert.equal(browser.action.capability, 'browser.read');
const mail = approvals.request({ capability: 'gmail.send', destination: 'alex@example.com', threadId: 'thread-1', content: { subject: 'Re: Handoff', body: 'Checking in.' } }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 60_000 });
assert.equal(mail.action.capability, 'gmail.send');
assert.throws(() => approvals.request({ capability: 'gmail.send', destination: 'not-an-email', threadId: 'thread-1', content: { subject: 'Subject', body: 'Body' } }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 60_000 }), /valid destination/);
assert.throws(() => approvals.request({ capability: 'gmail.send', destination: 'alex@example.com', threadId: 'thread-1', content: { subject: 'Subject', body: 'Body', extra: true } }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 60_000 }), /valid destination/);
assert.throws(() => approvals.request({ capability: 'calendar.update', eventId: 'event-1', changes: 'invalid' }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 60_000 }), /event and supported changes/);
assert.throws(() => approvals.request({ capability: 'calendar.update', eventId: 'event-1', changes: { attendees: [] } }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 60_000 }), /supported changes/);
assert.throws(() => approvals.request({ capability: 'browser.read', recipeId: recipe.id, recipeDigest: 'tampered' }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 60_000 }), /changed/);
store.close();
console.log('action registry tests passed');
