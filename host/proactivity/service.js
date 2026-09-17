const { matchesGrantConstraints } = require('../store/sqlite-store');

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
    if (task.sourceUnavailable === true) return this._decision(task, 'wait', 'source-unavailable', task.evidence?.text ? [task.evidence.text] : []);
    if (task.counterparty && this.store.isSuppressed('counterparty', task.counterparty, now)) return this._decision(task, 'wait', 'counterparty-suppressed', []);
    const blockers = this._blockingTasks(task);
    if (blockers.length) return this._decision(task, 'wait', 'blocked-by-dependency', blockers.map((item) => `Waiting on “${item.summary || item.taskId}”.`), { blockingTaskIds: blockers.map((item) => item.taskId) });
    const automatic = this._automaticDecision(task, now);
    if (automatic) return automatic;
    const evidence = task.evidence?.text ? [task.evidence.text] : [];
    if (task.confidence === 'low' && !task.dueDate) return this._decision(task, 'clarify', 'low-confidence-obligation', evidence);
    if (task.dueDate === 'today' || task.dueDate === 'tomorrow') return this._decision(task, 'digest', `due-${task.dueDate}`, evidence);
    if (Number.isFinite(Number(task.dueAt)) && Number(task.dueAt) <= now + 24 * 60 * 60 * 1000) {
      return this._decision(task, 'digest', Number(task.dueAt) <= now ? 'deadline-passed' : 'deadline-within-24-hours', evidence);
    }
    if (task.owner === 'counterparty' && task.blocker === 'self') {
      const observedAt = Number(task.updatedAt || task.createdAt || 0);
      if (observedAt && now - observedAt >= this.followUpAfterMs) return this._decision(task, 'draft_follow_up', 'counterparty-response-overdue', evidence);
    }
    return this._decision(task, 'wait', 'no-trigger', evidence);
  }

  evaluate(tasks = [], options = {}) {
    return tasks.map((task) => this.decide(task, options));
  }

  _blockingTasks(task) {
    const relations = this.store.taskRelations(task.taskId);
    const tasks = new Map(this.store.listTasks({ includeDismissed: true }).map((item) => [item.taskId, item]));
    const blockerIds = relations.flatMap((relation) => {
      if (['depends_on', 'waiting_on'].includes(relation.relationType) && relation.fromTaskId === task.taskId) return [relation.toTaskId];
      if (relation.relationType === 'blocks' && relation.toTaskId === task.taskId) return [relation.fromTaskId];
      return [];
    });
    return [...new Set(blockerIds)].map((taskId) => tasks.get(taskId)).filter((item) => item && !['done', 'dismissed'].includes(item.status));
  }

  _automaticDecision(task, now) {
    const automation = task.automation;
    if (!automation || automation.type !== 'browser' || !automation.recipeId || !automation.capability) return null;
    const active = this.store.listWorkflows({ taskId: task.taskId, activeOnly: true });
    if (active.some((workflow) => workflow.workflowType === 'browser-action')) return this._decision(task, 'wait', 'automation-in-progress', []);
    const priorRuns = this.store.listAutonomousRuns().filter((run) => run.action?.taskId === task.taskId).sort((a, b) => b.createdAt - a.createdAt);
    if (priorRuns.some((run) => run.status === 'unknown')) return this._decision(task, 'suggest_resolution', 'automation-outcome-unknown', []);
    const confirmedRuns = priorRuns.filter((run) => run.status === 'confirmed');
    if (confirmedRuns.length && automation.repeat !== true) return this._decision(task, 'wait', 'automation-completed', []);
    if (confirmedRuns.length && Number(automation.cooldownMs) > 0 && now - confirmedRuns[0].createdAt < Number(automation.cooldownMs)) return this._decision(task, 'wait', 'automation-cooldown', []);
    const action = { capability: automation.capability, recipeId: automation.recipeId, origin: automation.origin || null, inputs: automation.inputs || {} };
    const grant = this.store.listStandingGrants({ principal: 'signal-box-user', includeInactive: false }).find((candidate) => candidate.status === 'active'
      && candidate.capability === action.capability
      && now < candidate.expiresAt
      && (candidate.maxUses === null || candidate.usedCount < candidate.maxUses)
      && (candidate.lastUsedAt === null || now - candidate.lastUsedAt >= candidate.cooldownMs)
      && matchesGrantConstraints(action, candidate.constraints));
    if (!grant) return this._decision(task, 'wait', 'automatic-action-not-authorized', []);
    return this._decision(task, 'execute_browser', 'standing-permission-matched', task.evidence?.text ? [task.evidence.text] : [], {
      capability: action.capability, requiresApproval: false, grantId: grant.grantId, recipeId: action.recipeId, inputs: action.inputs,
    });
  }

  _decision(task, type, reason, evidence, details = {}) {
    return { taskId: task.taskId, type, reason, evidence, ...details, capability: type === 'draft_follow_up' ? 'gmail.send' : null, requiresApproval: type === 'draft_follow_up' };
  }
}

module.exports = { ProactivityService };
