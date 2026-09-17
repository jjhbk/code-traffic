class ConversationService {
  constructor({ store, principal = 'signal-box-user', channel = 'desktop', proactivity = null, clock = () => Date.now() } = {}) {
    if (!store) throw new Error('Conversation service requires a store.');
    this.store = store;
    this.principal = principal;
    this.channel = channel;
    this.proactivity = proactivity;
    this.clock = clock;
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

  handle({ conversationId = null, text, externalId = null } = {}) {
    if (!this.proactivity) throw new Error('Assistant planning is unavailable.');
    const content = String(text || '').trim();
    if (!content) throw new Error('Enter a message for the assistant.');
    const conversation = this.open(conversationId || undefined);
    const duplicate = externalId && this.history(conversation.conversationId).some((message) => message.externalId === externalId);
    const inbound = this.receive(conversation.conversationId, content, externalId);
    if (duplicate || inbound.direction !== 'inbound') return { duplicate: true, response: null, decisions: [], history: this.history(conversation.conversationId) };
    const tasks = this.store.listTasks({ includeDismissed: true });
    const command = content.match(/^\s*(dismiss|snooze)\s+([a-f0-9-]{8,})(?:\s+(\d+))?\s*$/i);
    const workflowCommand = content.match(/^\s*cancel\s+(?:workflow|work)\s+([a-f0-9-]{8,})\s*$/i);
    const memoryCommand = content.match(/^\s*(?:remember|save preference)\s+([^:]{2,80})\s*:\s*(.{1,500})\s*$/i);
    let response;
    let reference = {};
    if (memoryCommand) {
      const recordKey = memoryCommand[1].trim().toLowerCase();
      const value = memoryCommand[2].trim();
      this.store.upsertContext({ recordType: 'preference', recordKey, value, source: { channel: this.channel, conversationId: conversation.conversationId }, confidence: 'high', confirmed: true });
      response = `I’ll remember your preference for “${recordKey}”.`;
    } else if (workflowCommand) {
      const workflow = this.store.getWorkflow(workflowCommand[1]);
      if (!workflow) response = `I couldn't find workflow ${workflowCommand[1]}.`;
      else if (['completed', 'cancelled'].includes(workflow.state)) response = `Workflow “${workflow.workflowType}” is already ${workflow.state}.`;
      else {
        const cancelled = this.store.updateWorkflow(workflow.workflowId, { state: 'cancelled', details: { reason: 'conversation-user-cancelled', channel: this.channel } });
        response = `Cancelled workflow “${cancelled.workflowType}”.`;
        reference = { workflowId: cancelled.workflowId };
      }
    } else if (command) {
      const task = tasks.find((item) => item.taskId === command[2]);
      if (!task) response = `I couldn't find task ${command[2]}.`;
      else if (command[1].toLowerCase() === 'dismiss') {
        this.store.setTaskStatus(task.taskId, 'dismissed', { source: 'assistant-conversation' });
        response = `Dismissed “${task.summary}”.`;
        reference = { taskId: task.taskId };
      } else {
        const hours = Math.min(24 * 30, Math.max(1, Number(command[3] || 24)));
        this.store.snoozeTask(task.taskId, this.clock() + hours * 60 * 60 * 1000);
        response = `Snoozed “${task.summary}” for ${hours} hour${hours === 1 ? '' : 's'}.`;
        reference = { taskId: task.taskId };
      }
    } else {
      const decisions = this.proactivity.evaluate(tasks);
      const actionable = decisions.filter((decision) => decision.type !== 'wait');
      const requestedMemory = /\b(remember|memory|preference|context)\b/i.test(content);
      if (requestedMemory) {
        const memory = this.store.listContext().slice(0, 8);
        response = memory.length
          ? `I remember ${memory.map((item) => `${item.recordType} “${item.recordKey}”`).join(', ')}.`
          : 'I do not have any saved personal context yet.';
      } else if (actionable.length) {
        const lines = actionable.slice(0, 8).map((decision) => {
          const task = tasks.find((item) => item.taskId === decision.taskId);
          return `• ${task?.summary || decision.taskId}: ${decision.type.replaceAll('_', ' ')} (${decision.reason.replaceAll('-', ' ')})`;
        });
        response = `Here is what needs attention:\n${lines.join('\n')}\n\nAsk “why” for the evidence, or use “snooze <task id> <hours>” / “dismiss <task id>” to change one explicitly.`;
        if (actionable.length === 1) reference = { taskId: actionable[0].taskId };
      } else {
        response = 'I found no triggered next steps. I will keep watching the active obligations.';
      }
    }
    this.respond(conversation.conversationId, response, reference);
    return { duplicate: false, response, decisions: this.proactivity.evaluate(this.store.listTasks()), history: this.history(conversation.conversationId), ...reference };
  }
}

module.exports = { ConversationService };
