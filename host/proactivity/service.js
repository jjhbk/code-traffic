class ProactivityService {
  constructor({ store, clock = () => Date.now(), followUpAfterMs = 48 * 60 * 60 * 1000 } = {}) {
    if (!store) throw new Error('Proactivity service requires a store.');
    this.store = store;
    this.clock = clock;
    this.followUpAfterMs = followUpAfterMs;
  }

  decide(task, { now = this.clock() } = {}) {
    if (!task || !task.taskId) throw new Error('A task is required.');
    if (['done', 'dismissed'].includes(task.status)) return this._decision(task, 'wait', 'task-closed', []);
    if (task.status === 'snoozed' && Number(task.snoozedUntil || 0) > now) return this._decision(task, 'wait', 'task-snoozed', []);
    if (task.counterparty && this.store.isSuppressed('counterparty', task.counterparty, now)) return this._decision(task, 'wait', 'counterparty-suppressed', []);
    const evidence = task.evidence?.text ? [task.evidence.text] : [];
    if (task.confidence === 'low' && !task.dueDate) return this._decision(task, 'clarify', 'low-confidence-obligation', evidence);
    if (task.dueDate === 'today' || task.dueDate === 'tomorrow') return this._decision(task, 'digest', `due-${task.dueDate}`, evidence);
    if (task.owner === 'counterparty' && task.blocker === 'self') {
      const observedAt = Number(task.updatedAt || task.createdAt || 0);
      if (observedAt && now - observedAt >= this.followUpAfterMs) return this._decision(task, 'draft_follow_up', 'counterparty-response-overdue', evidence);
    }
    return this._decision(task, 'wait', 'no-trigger', evidence);
  }

  evaluate(tasks = [], options = {}) {
    return tasks.map((task) => this.decide(task, options));
  }

  _decision(task, type, reason, evidence) {
    return { taskId: task.taskId, type, reason, evidence, capability: type === 'draft_follow_up' ? 'gmail.send' : null, requiresApproval: type === 'draft_follow_up' };
  }
}

module.exports = { ProactivityService };
