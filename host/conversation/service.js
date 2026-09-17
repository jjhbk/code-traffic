class ConversationService {
  constructor({ store, principal = 'signal-box-user', channel = 'desktop' } = {}) {
    if (!store) throw new Error('Conversation service requires a store.');
    this.store = store;
    this.principal = principal;
    this.channel = channel;
  }

  open(conversationId = null) {
    return this.store.getOrCreateConversation({ conversationId: conversationId || undefined, principal: this.principal, channel: this.channel });
  }

  receive(conversationId, content, externalId = null, references = {}) {
    return this.store.appendConversationMessage({ conversationId, content, externalId, direction: 'inbound', ...references });
  }

  respond(conversationId, content, references = {}) {
    return this.store.appendConversationMessage({ conversationId, content, direction: 'outbound', ...references });
  }

  history(conversationId, limit = 100) { return this.store.listConversationMessages(conversationId, limit); }
}

module.exports = { ConversationService };
