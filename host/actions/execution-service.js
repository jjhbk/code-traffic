/**
 * Executes already-approved provider actions through one durable boundary.
 *
 * The Electron process supplies provider factories and workflow callbacks, but
 * this service owns the safety-critical sequence: claim once, record each
 * execution transition, persist a receipt, and retain ambiguous outcomes.
 */
class ActionExecutionService {
  constructor({ store, approvals, registry = null, providers = {}, clock = () => Date.now(), preflight = null, onConfirmed = null, onFailure = null } = {}) {
    if (!store || !approvals) throw new Error('Action execution requires a store and approval service.');
    this.store = store;
    this.approvals = approvals;
    this.registry = registry;
    this.providers = providers;
    this.clock = clock;
    this.preflight = preflight;
    this.onConfirmed = onConfirmed;
    this.onFailure = onFailure;
  }

  async executeApproved(requestId, { principal, surface, decision = null } = {}) {
    const request = this.store.getApproval(requestId);
    if (!request) throw new Error('Approval request was not found.');
    const action = request.action || {};
    const providerKey = providerKeyFor(action.capability);
    const providerFactory = this.providers[providerKey];
    if (!providerFactory) throw new Error(`No provider is configured for ${action.capability}.`);
    this.registry?.validateAction(action);
    await this.preflight?.({ action, request, principal, surface });
    const resolvedDecision = decision || this.approvals.decide(requestId, optionFor(action.capability, request), { principal, surface });
    const attempt = this.approvals.claimExecution({ requestId, details: { capability: action.capability, surface, provider: providerKey } });
    this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: 'authorized', details: { decisionId: resolvedDecision.decisionId, surface } });
    try {
      const dispatchedAt = this.clock();
      this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: 'dispatched', details: { provider: providerKey, surface, dispatchedAt } });
      const provider = await providerFactory(action);
      const result = await dispatch(providerKey, provider, action, attempt.attemptId);
      this.approvals.execution({ attemptId: attempt.attemptId, requestId, status: 'confirmed', details: { provider: providerKey, surface, resultId: result?.id || result?.eventId || null } });
      const receipt = receiptFor(providerKey, action, result);
      const receiptRef = this.approvals.receipt({ attemptId: attempt.attemptId, receipt });
      await this.onConfirmed?.({ action, result, receipt, attempt, request, surface });
      return { status: 'confirmed', attemptId: attempt.attemptId, result, receipt, receiptRef };
    } catch (error) {
      const status = classifyFailure(error);
      this.approvals.execution({ attemptId: attempt.attemptId, requestId, status, details: { provider: providerKey, surface, error: error.message } });
      await this.onFailure?.({ action, error, status, attempt, request, surface });
      if (status === 'unknown') {
        error.code = 'EXECUTION_UNKNOWN';
        error.attemptId = attempt.attemptId;
        error.requestId = requestId;
      }
      throw error;
    }
  }

  async reconcileGmail(requestId, attemptId, { surface = 'desktop' } = {}) {
    const request = this.store.getApproval(requestId);
    const attempt = this.store.getExecutionAttempt(attemptId);
    if (!request || !attempt || attempt.requestId !== requestId || request.action?.capability !== 'gmail.send') throw new Error('Gmail execution record not found.');
    if (attempt.status !== 'unknown') return { status: attempt.status, attemptId };
    const provider = await this.providers.gmail(request.action);
    const result = await provider.reconcileReply({
      to: request.action.destination,
      subject: request.action.content.subject,
      body: request.action.content.body,
      threadId: request.action.threadId,
      signalBoxAttemptId: attempt.attemptId,
      sentAfter: attempt.details?.dispatchedAt || null,
      accountAddress: typeof this.providers.accountAddress === 'function' ? this.providers.accountAddress() : null,
    });
    if (!result.found) return { status: 'unknown', attemptId, reconciled: false };
    const receipt = receiptFor('gmail', request.action, result, { reconciled: true });
    this.approvals.execution({ attemptId, requestId, status: 'confirmed', details: { provider: 'gmail', surface, reconciled: true, messageId: result.messageId } });
    this.approvals.receipt({ attemptId, receipt });
    await this.onConfirmed?.({ action: request.action, result, receipt, attempt, request, surface, reconciled: true });
    return { status: 'confirmed', attemptId, messageId: result.messageId, reconciled: true };
  }
}

function providerKeyFor(capability) {
  if (capability === 'gmail.send') return 'gmail';
  if (capability === 'calendar.update') return 'calendar';
  throw new Error(`Unsupported provider action: ${capability}.`);
}

function optionFor(capability, request = {}) {
  const options = request.options || request.action?.options || [];
  const preferred = capability === 'gmail.send' ? 'send' : 'update';
  if (options.some((option) => option.optionId === preferred)) return preferred;
  return options.find((option) => option.optionId !== 'deny')?.optionId || preferred;
}

async function dispatch(providerKey, provider, action, attemptId) {
  if (providerKey === 'gmail') return provider.sendReply({
    to: action.destination,
    subject: action.content.subject,
    body: action.content.body,
    threadId: action.threadId,
    inReplyTo: action.inReplyTo,
    references: action.references,
    signalBoxAttemptId: attemptId,
  });
  const changes = { ...action.changes };
  for (const key of ['start', 'end']) if (typeof changes[key] === 'string') changes[key] = { dateTime: new Date(changes[key]).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return provider.updateEvent(action.eventId, changes, { etag: action.etag });
}

function receiptFor(providerKey, action, result, extra = {}) {
  if (providerKey === 'gmail') return { provider: 'gmail', messageId: result?.id || result?.messageId || null, threadId: result?.threadId || action.threadId, destination: action.destination, ...extra };
  return { provider: 'google-calendar', eventId: result?.id || result?.eventId || action.eventId, etag: result?.etag || null, changedFields: Object.keys(action.changes || {}), ...extra };
}

function classifyFailure(error) {
  return error?.name === 'AbortError' || /timeout|network|fetch/i.test(String(error?.message || '')) ? 'unknown' : 'failed';
}

module.exports = { ActionExecutionService, classifyFailure, receiptFor };
