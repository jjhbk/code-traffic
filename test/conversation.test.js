const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ConversationService } = require('../host/conversation/service');

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
store.close();
console.log('conversation tests passed');
