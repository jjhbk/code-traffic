const { matchesGrantConstraints } = require('../store/sqlite-store');

class ProactivityService {
  constructor({ store, modelRouter = null, clock = () => Date.now(), followUpAfterMs = 48 * 60 * 60 * 1000, modelCooldownMs = 15 * 60 * 1000, modelMaxCalls = 20, maxAutomaticActionsPerCycle = 3 } = {}) {
    if (!store) throw new Error('Proactivity service requires a store.');
    this.store = store;
    this.modelRouter = modelRouter;
    this.clock = clock;
    this.followUpAfterMs = followUpAfterMs;
    this.modelCooldownMs = modelCooldownMs;
    this.modelMaxCalls = modelMaxCalls;
    this.maxAutomaticActionsPerCycle = Number.isInteger(maxAutomaticActionsPerCycle) && maxAutomaticActionsPerCycle > 0
      ? maxAutomaticActionsPerCycle
      : 3;
    this.modelDecisionCache = new Map();
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

  contextForTask(task, context = [], { now = this.clock(), limit = 8 } = {}) {
    if (!task || !Array.isArray(context)) return [];
    const text = [task.summary, task.description, task.counterparty, task.threadId, task.evidence?.text].filter(Boolean).join(' ').toLowerCase();
    const tokens = new Set((text.match(/[a-z0-9][a-z0-9._@-]{2,}/g) || []).filter((token) => !['the', 'and', 'for', 'with', 'this', 'that'].includes(token)));
    const placeKey = task.contextTrigger?.placeKey || task.locationTrigger?.placeKey || null;
    return context
      .filter((record) => record && (record.validUntil === null || record.validUntil === undefined || !Number.isFinite(Number(record.validUntil)) || Number(record.validUntil) > now))
      .map((record) => {
        const key = String(record.recordKey || '').toLowerCase();
        const value = typeof record.value === 'string' ? record.value.toLowerCase() : JSON.stringify(record.value || {}).toLowerCase();
        const keyMatch = Boolean(key && tokens.has(key));
        const placeMatch = record.recordType === 'place' && placeKey && key === String(placeKey).toLowerCase();
        const overlap = [...tokens].some((token) => token.length >= 4 && (key.includes(token) || value.includes(token)));
        const durablePreference = Boolean(record.confirmed && ['goal', 'preference'].includes(record.recordType));
        const score = (placeMatch ? 4 : 0) + (keyMatch ? 3 : 0) + (overlap ? 2 : 0) + (durablePreference ? 1 : 0);
        return { record, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || Number(right.record.updatedAt || 0) - Number(left.record.updatedAt || 0))
      .slice(0, Math.max(0, Number(limit) || 0))
      .map(({ record }) => record);
  }

  async evaluateAsync(tasks = [], { now = this.clock(), context = [] } = {}) {
    const deterministic = this.evaluate(tasks, { now });
    if (!this.modelRouter?.proposeNextStep) return deterministic;
    const refined = [];
    let modelCalls = 0;
    for (let index = 0; index < deterministic.length; index += 1) {
      const decision = deterministic[index];
      const task = tasks[index];
      if (decision.type !== 'wait' || decision.reason !== 'no-trigger') { refined.push(decision); continue; }
      const version = `${task.updatedAt || task.createdAt || ''}:${task.status}:${task.dueAt || task.dueDate || ''}:${task.summary || ''}`;
      const cached = this.modelDecisionCache.get(task.taskId);
      if (cached && cached.version === version && now - cached.at < this.modelCooldownMs) { refined.push(cached.decision); continue; }
      if (modelCalls >= this.modelMaxCalls) { refined.push(decision); continue; }
      try {
        modelCalls += 1;
        const proposal = await this.modelRouter.proposeNextStep(task, this.contextForTask(task, context, { now }));
        const allowed = new Set(['wait', 'clarify', 'digest', 'draft_follow_up', 'suggest_resolution']);
        const proposedType = String(proposal?.decision || '');
        const proposedReason = String(proposal?.reason || '').trim();
        // Model output can suggest attention or a reviewed draft, but it can
        // never authorize an external write or invent a decision type. The
        // deterministic policy remains the fallback for malformed output.
        if (!proposal || proposedType === 'wait' || !allowed.has(proposedType) || !proposedReason) {
          this.modelDecisionCache.set(task.taskId, { version, at: now, decision }); refined.push(decision); continue;
        }
        const refinedDecision = this._decision(task, proposedType, proposedReason.slice(0, 240), decision.evidence, { source: String(proposal.source || 'model').slice(0, 80), requiresApproval: proposedType === 'draft_follow_up' ? true : Boolean(proposal.requiresApproval) });
        this.modelDecisionCache.set(task.taskId, { version, at: now, decision: refinedDecision });
        refined.push(refinedDecision);
      } catch (_) {
        this.modelDecisionCache.set(task.taskId, { version, at: now, decision });
        refined.push(decision);
      }
    }
    return refined;
  }

  selectAutomaticDecisions(decisions = [], { maxActions = this.maxAutomaticActionsPerCycle } = {}) {
    const limit = Number.isInteger(maxActions) && maxActions >= 0 ? maxActions : this.maxAutomaticActionsPerCycle;
    const eligible = decisions.filter((decision) => decision?.type === 'execute_browser');
    return {
      selected: eligible.slice(0, limit),
      deferred: eligible.slice(limit),
    };
  }

  enqueueAttentionNotifications(tasks = [], decisions = this.evaluate(tasks)) {
    const taskById = new Map(tasks.map((task) => [task.taskId, task]));
    const enqueued = [];
    for (const decision of decisions.filter((item) => item.type === 'suggest_resolution')) {
      const task = taskById.get(decision.taskId);
      if (!task) continue;
      const unknownRun = this.store.listAutonomousRuns().find((run) => run.action?.taskId === task.taskId && run.status === 'unknown');
      const notificationId = `assistant-attention:${task.taskId}:${unknownRun?.runId || decision.reason}`;
      const notification = this.store.enqueueNotification({
        notificationId,
        dateKey: notificationId,
        notificationClass: 'assistant-attention',
        items: [{ taskId: task.taskId, summary: task.summary, reason: 'An automatic action needs your verification.', evidence: { runId: unknownRun?.runId || null, decisionReason: decision.reason } }],
      });
      if (notification) enqueued.push(notification);
    }
    return enqueued;
  }

  enqueueDependencyNotification(task, { dependency = 'browser', reason = 'dependency-unavailable', evidence = null } = {}) {
    if (!task?.taskId) return null;
    const taskVersion = task.updatedAt || task.createdAt || 'unknown';
    return this.store.enqueueNotification({
      notificationId: `assistant-dependency:${task.taskId}:${taskVersion}:${dependency}:${reason}`,
      dateKey: `assistant-dependency:${task.taskId}:${taskVersion}:${dependency}:${reason}`,
      notificationClass: 'assistant-attention',
      items: [{ taskId: task.taskId, summary: task.summary, reason, evidence: { dependency, taskVersion, ...(evidence ? { detail: evidence } : {}) } }],
    });
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
