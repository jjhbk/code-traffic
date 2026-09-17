const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ConversationService } = require('../host/conversation/service');
const { ProactivityService } = require('../host/proactivity/service');

const store = new SqliteStore();
const service = new ConversationService({ store, channel: 'telegram' });
const conversation = service.open('telegram:chat-1');
service.receive(conversation.conversationId, 'Remind me about Alex', 'telegram-update-1');
service.receive(conversation.conversationId, 'Remind me about Alex', 'telegram-update-1');
service.respond(conversation.conversationId, 'I will check the open obligation.');
assert.equal(service.history(conversation.conversationId).length, 2);
assert.equal(service.history(conversation.conversationId)[0].direction, 'inbound');
assert.equal(store.exportData().data.conversations.length, 1);
assert.equal(store.exportData().data.conversation_messages.length, 2);

const candidate = store.saveTaskCandidate({
  candidateId: '12345678-1234-4abc-8def-123456789abc', observationId: 'conversation-observation', summary: 'Reply to Alex',
  owner: 'counterparty', blocker: 'self', counterparty: 'alex@example.com', dueDate: 'today', confidence: 'medium',
  evidence: { start: 0, end: 18, text: 'Please reply to Alex' }, extractorVersion: 'test', obligationKey: 'conversation-obligation',
});
const assistant = new ConversationService({ store, channel: 'desktop', proactivity: new ProactivityService({ store }) });
const handled = assistant.handle({ conversationId: 'desktop:test', text: 'What needs attention?', externalId: 'desktop-message-1' });
assert.match(handled.response, /Reply to Alex/);
assert.equal(handled.taskId, candidate.taskId);
const duplicate = assistant.handle({ conversationId: 'desktop:test', text: 'What needs attention?', externalId: 'desktop-message-1' });
assert.equal(duplicate.duplicate, true);
assert.equal(assistant.history('desktop:test').length, 2);
assistant.handle({ conversationId: 'desktop:test', text: `snooze ${candidate.taskId} 2`, externalId: 'desktop-message-2' });
assert.equal(store.listTasks().find((task) => task.taskId === candidate.taskId).status, 'snoozed');
store.close();
console.log('conversation tests passed');
