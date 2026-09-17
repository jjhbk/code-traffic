const crypto = require('crypto');

class ProviderAutonomousActionService {
  constructor({ store, approvals, registry = null, providers = {}, clock = () => Date.now() } = {}) {
    if (!store || !approvals) throw new Error('Provider autonomous actions require a store and approval service.');
    this.store = store;
    this.approvals = approvals;
    this.registry = registry;
    this.providers = providers;
    this.clock = clock;
  }

  async executeWithStandingGrant(action, { grantId, principal = 'signal-box-user', surface = 'desktop' } = {}) {
    const checked = this._validate(action);
    if (!grantId) throw new Error('A standing grant is required.');
    this._assertFresh(checked);
    if (checked.taskId && this.store.listAutonomousRuns().some((run) => run.action?.taskId === checked.taskId && ['prepared', 'authorized', 'dispatched'].includes(run.status))) {
      throw new Error('An autonomous provider action is already in progress for this task.');
    }
    const authorized = { ...checked, autonomous: false };
    this.approvals.authorizeStanding(authorized, { grantId, principal, surface });
    const actionDigest = digest(checked);
    const run = this.store.createAutonomousRun({ grantId, action: checked, actionDigest, details: { capability: checked.capability, surface } });
    this.store.updateAutonomousRun(run.runId, 'authorized', { details: { principal, surface } });
    try {
      this.store.updateAutonomousRun(run.runId, 'dispatched', { details: { surface } });
      const result = await this._dispatch(checked, run.runId);
      const receipt = receiptFor(checked, result, run.runId, grantId, actionDigest);
      this.store.updateAutonomousRun(run.runId, 'confirmed', { details: { surface, receiptStatus: receipt.status || 'confirmed' }, receipt });
      return { runId: run.runId, receipt, result };
    } catch (error) {
      const status = isUnknown(error) ? 'unknown' : 'failed';
      this.store.updateAutonomousRun(run.runId, status, { details: { surface, error: error.message } });
      error.runId = run.runId;
      throw error;
    }
  }

  async reconcileUnknownRun(runId, { principal = 'signal-box-user', surface = 'desktop' } = {}) {
    const run = this.store.getAutonomousRun(runId);
    if (!run || run.status !== 'unknown') throw new Error('Only an unknown provider run can be reconciled.');
    const grant = this.store.getStandingGrant(run.grantId);
    if (!grant || grant.principal !== principal || grant.surface !== surface) throw new Error('The autonomous run is not owned by this user and surface.');
    const action = this._validate(run.action);
    let result;
    if (action.capability === 'gmail.send') {
      const provider = this._provider('gmail', action);
      result = await provider.reconcileReply({
        to: action.destination,
        subject: action.content.subject,
        body: action.content.body,
        threadId: action.threadId,
        signalBoxAttemptId: run.runId,
        sentAfter: run.createdAt,
        accountAddress: typeof this.providers.accountAddress === 'function' ? this.providers.accountAddress() : null,
      });
    } else {
      const provider = this._provider('calendar', action);
      const event = await provider.getEvent(action.eventId);
      result = { found: changesMatch(event, action.changes), eventId: action.eventId, etag: event.etag || null };
    }
    if (!result.found) return { status: 'unknown', runId, reconciled: false };
    const receipt = receiptFor(action, result, runId, run.grantId, run.actionDigest, { reconciled: true });
    return this.store.updateAutonomousRun(runId, 'confirmed', { details: { ...run.details, reconciledAt: this.clock(), surface }, receipt });
  }

  _validate(action = {}) {
    if (!['gmail.send', 'calendar.update'].includes(action.capability)) throw new Error('Unsupported autonomous provider action.');
    this.registry?.validateAction(action);
    return { ...action, effects: action.effects || 'commit' };
  }

  _provider(key, action) {
    const factory = this.providers[key];
    if (typeof factory !== 'function') throw new Error(`No ${key} provider is configured.`);
    return factory(action);
  }

  _assertFresh(action) {
    if (!action.taskId || action.taskVersion == null) return;
    const current = this.store.listTasks({ includeDismissed: true }).find((task) => task.taskId === action.taskId);
    if (!current || current.status !== 'active' || Number(current.updatedAt) !== Number(action.taskVersion)) throw new Error('This provider action is stale because the task changed.');
  }

  async _dispatch(action, runId) {
    if (action.capability === 'gmail.send') {
      return this._provider('gmail', action).sendReply({ ...action.content, to: action.destination, threadId: action.threadId, inReplyTo: action.inReplyTo, references: action.references, signalBoxAttemptId: runId });
    }
    const changes = { ...action.changes };
    for (const key of ['start', 'end']) if (typeof changes[key] === 'string') changes[key] = { dateTime: new Date(changes[key]).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    return this._provider('calendar', action).updateEvent(action.eventId, changes, { etag: action.etag });
  }
}

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function receiptFor(action, result, runId, grantId, actionDigest, extra = {}) {
  return action.capability === 'gmail.send'
    ? { status: result?.found === false ? 'unknown' : 'confirmed', provider: 'gmail', messageId: result?.id || result?.messageId || null, threadId: result?.threadId || action.threadId, runId, grantId, actionDigest, ...extra }
    : { status: result?.found === false ? 'unknown' : 'confirmed', provider: 'google-calendar', eventId: result?.id || result?.eventId || action.eventId, etag: result?.etag || null, changedFields: Object.keys(action.changes || {}), runId, grantId, actionDigest, ...extra };
}

function changesMatch(event, changes = {}) {
  return Object.entries(changes).every(([key, value]) => {
    if (['start', 'end'].includes(key) && typeof value === 'string') return event[key]?.dateTime === new Date(value).toISOString();
    return JSON.stringify(event?.[key] ?? null) === JSON.stringify(value);
  });
}

function isUnknown(error) { return error?.name === 'AbortError' || /timeout|network|fetch/i.test(String(error?.message || '')); }

module.exports = { ProviderAutonomousActionService, changesMatch, isUnknown };
