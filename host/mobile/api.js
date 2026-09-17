const { normalizeIngestEvent } = require('../events/event-contract');
const { WorkflowService } = require('../workflows/service');

const PROTOCOL_VERSION = '1';
const MOBILE_CONVERSATION_ID = 'mobile:default';

function decodeNotificationCursor(value) {
  if (!value) return { createdAt: 0, notificationId: '' };
  if (/^\d+$/.test(String(value))) return { createdAt: Number(value), notificationId: '' };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Number.isFinite(Number(parsed.createdAt)) || typeof parsed.notificationId !== 'string') throw new Error('invalid cursor');
    return { createdAt: Number(parsed.createdAt), notificationId: parsed.notificationId };
  } catch (_) { throw Object.assign(new Error('Invalid notification cursor.'), { status: 400 }); }
}

function encodeNotificationCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

class MobileApi {
  constructor({ store, conversation, proactivity, approvals = null, pairing = null, context = null, onApproval = null, onPause = null, onReconcile = null, getStatus = null, getConnections = null, clock = () => Date.now(), mobileContextRetentionMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    if (!store || !conversation || !proactivity) throw new Error('Mobile API requires store, conversation, and proactivity services.');
    this.store = store;
    this.conversation = conversation;
    this.proactivity = proactivity;
    this.approvals = approvals; this.pairing = pairing; this.context = context; this.onApproval = onApproval; this.onPause = onPause; this.onReconcile = onReconcile;
    this.getStatus = getStatus || (() => ({ running: true })); this.getConnections = getConnections || (() => []);
    this.clock = clock;
    this.mobileContextRetentionMs = Number.isFinite(Number(mobileContextRetentionMs)) && Number(mobileContextRetentionMs) > 0 ? Number(mobileContextRetentionMs) : 30 * 24 * 60 * 60 * 1000;
  }

  async handle({ method, path, query = {}, body = {}, headers = {}, device = null } = {}) {
    const operation = async () => {
      const parts = String(path || '').split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'mobile') throw this._error(404, 'Mobile endpoint not found.');
      const resource = parts[3] || '';
      if (method === 'POST' && resource === 'pair') return this.pair(body);
      if (method === 'GET' && resource === 'health') return { protocolVersion: PROTOCOL_VERSION, core: await this.getStatus() };
      if (method === 'POST' && resource === 'assistant' && parts[4] === 'pause') return this.pauseAssistant(body);
      if (method === 'GET' && resource === 'assistant' && parts[4] === 'autonomous-runs') return { runs: this.store.listAutonomousRuns({ limit: Number(query.limit || 50) }) };
      if (method === 'POST' && resource === 'assistant' && parts[4] === 'autonomous-runs' && parts[6] === 'confirm') return this.confirmAutonomousRun(parts[5], body);
      if (method === 'GET' && resource === 'today') return this.today(device, query);
      if (method === 'GET' && resource === 'graph') return { graph: this.store.taskGraph({ includeDismissed: false, taskId: query.taskId || null, depth: query.depth === undefined ? 2 : Number(query.depth), limit: Number(query.limit || 100) }) };
      if (method === 'GET' && resource === 'notifications') return this.notifications(device, query);
      if (method === 'GET' && resource === 'approvals') return { approvals: this.store.listPendingApprovals({ principal: 'signal-box-user', surface: 'mobile', now: this.clock() }) };
      if (method === 'GET' && resource === 'connections') return { connections: await this.getConnections() };
      if (method === 'POST' && resource === 'devices' && parts[4] === 'push-token' && parts[5] === 'revoke') return this.revokePushToken(device);
      if (method === 'POST' && resource === 'devices' && parts[4] === 'push-token') return this.registerPushToken(body, device);
      if (method === 'GET' && resource === 'conversation') return { conversationId: this.conversationId(query.conversationId), messages: this.conversation.history(this.conversationId(query.conversationId)) };
      if (method === 'POST' && resource === 'conversation' && parts[4] === 'messages') return this.sendMessage(body);
      if (method === 'GET' && resource === 'workflows') return { workflows: this.store.listWorkflows({ activeOnly: query.activeOnly !== 'false' }) };
      if (method === 'POST' && resource === 'workflows' && parts[4] && parts[5] === 'cancel') return this.cancelWorkflow(parts[4]);
      if (method === 'POST' && resource === 'approvals' && parts[4] && parts[5] === 'decide') return this.decideApproval(parts[4], body);
      if (method === 'POST' && resource === 'notifications' && parts[4] && parts[5] === 'ack') return this.acknowledgeNotification(parts[4], device);
      if (method === 'GET' && resource === 'context') return { context: this.store.listContext({ recordType: query.recordType || null }) };
      if (method === 'POST' && resource === 'context' && parts[4] && parts[5] && parts[6] === 'delete') return this.deleteContext(parts[4], parts[5]);
      if (method === 'GET' && resource === 'permissions') return { permissions: this.store.listStandingGrants({ principal: 'signal-box-user' }) };
      if (method === 'POST' && resource === 'permissions' && parts[4] && parts[5] === 'revoke') return { permission: this.revokePermission(parts[4]) };
      if (method === 'POST' && resource === 'permissions') return { permission: this.createPermission(body) };
      if (method === 'POST' && resource === 'tasks' && parts[4] && parts[5] === 'status') return { task: this.updateTask(parts[4], body) };
      if (method === 'POST' && resource === 'tasks' && parts[4] && parts[5] === 'context-trigger') return { task: this.setTaskContextTrigger(parts[4], body) };
      if (method === 'POST' && resource === 'context' && parts[4] === 'location') return this.ingestLocation(body, device);
      if (method === 'POST' && resource === 'context' && parts[4] === 'sensor') return this.ingestSensor(body, device);
      if (method === 'POST' && resource === 'context' && parts[4] === 'place') return this.savePlace(body);
      throw this._error(404, 'Mobile endpoint not found.');
    };
    if (method !== 'POST') return operation();
    const commandId = String(headers['idempotency-key'] || body.externalId || '').trim();
    if (!commandId || commandId.length > 200) throw this._error(400, 'An idempotency key is required for mobile commands.');
    const scopedCommandId = `${device?.deviceId || 'legacy-mobile'}:${commandId}`;
    const cached = this.store.getMobileCommand(scopedCommandId);
    if (cached) return { ...cached.result, replayed: true, ...(Object.prototype.hasOwnProperty.call(cached.result, 'duplicate') ? { duplicate: true } : {}) };
    const result = await operation();
    this.store.saveMobileCommand(scopedCommandId, `${method} ${path}`, result);
    return { ...result, replayed: false };
  }

  pair(body = {}) {
    if (!this.pairing) throw this._error(503, 'Mobile pairing is unavailable.');
    try { return this.pairing.pair({ code: body.code, deviceName: body.deviceName }); }
    catch (error) { throw this._error(400, error.message); }
  }

  async decideApproval(requestId, body = {}) {
    if (!this.approvals) throw this._error(503, 'Approval controls are unavailable.');
    const optionId = String(body.optionId || '').trim();
    if (!optionId) throw this._error(400, 'An approval option is required.');
    try {
      const result = this.onApproval
        ? await this.onApproval({ requestId, optionId })
        : this.approvals.decide(requestId, optionId, { principal: 'signal-box-user', surface: 'mobile' });
      return { requestId, optionId, result };
    } catch (error) { throw this._error(error.status || 409, error.message); }
  }

  async pauseAssistant(body = {}) {
    if (!this.onPause) throw this._error(503, 'Assistant pause control is unavailable.');
    if (typeof body.paused !== 'boolean') throw this._error(400, 'Assistant pause requires a boolean paused value.');
    try { return { health: await this.onPause({ paused: body.paused }) }; }
    catch (error) { throw this._error(error.status || 409, error.message); }
  }

  async confirmAutonomousRun(runId, body = {}) {
    if (!this.onReconcile) throw this._error(503, 'Autonomous run reconciliation is unavailable.');
    try { return { run: await this.onReconcile({ runId, evidence: body.evidence }) }; }
    catch (error) { throw this._error(error.status || 409, error.message); }
  }

  authenticate(token) { return this.pairing?.authenticate(token) || null; }

  async today(device = null, query = {}) {
    const tasks = this.store.listTasks();
    const decisions = this.proactivity.evaluateAsync
      ? await this.proactivity.evaluateAsync(tasks, { context: this.store.listContext() })
      : this.proactivity.evaluate(tasks);
    return { protocolVersion: PROTOCOL_VERSION, generatedAt: this.clock(), tasks, decisions, workflows: this.store.listWorkflows({ activeOnly: true }), goals: this.store.listContext({ recordType: 'goal' }), notifications: this.notifications(device, query).notifications };
  }

  notifications(device = null, query = {}) {
    const deviceId = device?.deviceId || 'legacy-mobile';
    const cursor = decodeNotificationCursor(query.after);
    const notifications = this.store.listMobileNotifications({ deviceId, afterCreatedAt: cursor.createdAt, afterNotificationId: cursor.notificationId, limit: Number(query.limit || 50) });
    const nextCursor = encodeNotificationCursor(notifications.length ? { createdAt: notifications[notifications.length - 1].createdAt, notificationId: notifications[notifications.length - 1].notificationId } : cursor);
    return { notifications, nextCursor };
  }

  acknowledgeNotification(notificationId, device = null) {
    try { return this.store.acknowledgeMobileNotification(notificationId, device?.deviceId || 'legacy-mobile'); }
    catch (error) { throw this._error(error.message === 'Notification not found.' ? 404 : 400, error.message); }
  }

  registerPushToken(body = {}, device = null) {
    const deviceId = device?.deviceId || body.deviceId || 'legacy-mobile';
    if (!deviceId || (device && body.deviceId && body.deviceId !== device.deviceId)) throw this._error(403, 'Push token device identity does not match the authenticated device.');
    try { return { registration: this.store.registerMobilePushToken({ deviceId, pushToken: body.pushToken, platform: body.platform || 'expo' }) }; }
    catch (error) { throw this._error(400, error.message); }
  }

  revokePushToken(device = null) {
    try { return { registration: this.store.revokeMobilePushToken(device?.deviceId || 'legacy-mobile') }; }
    catch (error) { throw this._error(400, error.message); }
  }

  sendMessage(body = {}) {
    const conversationId = this.conversationId(body.conversationId);
    const text = String(body.text || '').trim();
    const externalId = String(body.externalId || '').trim();
    if (!text || text.length > 4_000) throw this._error(400, 'Message text is required and must be at most 4,000 characters.');
    if (!externalId || externalId.length > 200) throw this._error(400, 'A bounded client message ID is required.');
    return this.conversation.handle({ conversationId, text, externalId });
  }

  createPermission(body = {}) {
    if (!this.approvals) throw this._error(503, 'Permission controls are unavailable.');
    try {
      return this.approvals.createStandingGrant({ capability: body.capability }, {
        principal: 'signal-box-user',
        // The mobile client controls authority; the Electron core remains the
        // execution surface for local browser actions.
        surface: body.executionSurface || 'desktop',
        constraints: body.constraints || {},
        expiresAt: Number(body.expiresAt),
        maxUses: body.maxUses == null ? null : Number(body.maxUses),
        cooldownMs: body.cooldownMs == null ? 0 : Number(body.cooldownMs),
      });
    } catch (error) { throw this._error(400, error.message); }
  }

  revokePermission(grantId) {
    const grant = this.store.getStandingGrant(grantId);
    if (!grant || grant.principal !== 'signal-box-user') throw this._error(404, 'Mobile permission was not found.');
    try { return this.store.revokeStandingGrant(grantId, 'mobile-user-revoked'); }
    catch (error) { throw this._error(409, error.message); }
  }

  updateTask(taskId, body = {}) {
    try {
      if (body.status) return this.store.setTaskStatus(taskId, body.status, { source: 'mobile' });
      if (body.snoozeUntilAt !== undefined) return this.store.snoozeTask(taskId, Number(body.snoozeUntilAt));
      throw new Error('A task status or snoozeUntilAt is required.');
    } catch (error) { throw this._error(400, error.message); }
  }

  setTaskContextTrigger(taskId, body = {}) {
    try { return this.store.setTaskContextTrigger(taskId, body); }
    catch (error) { throw this._error(400, error.message); }
  }

  cancelWorkflow(workflowId) {
    try { return { workflow: new WorkflowService({ store: this.store }).cancel(workflowId, 'mobile-user-cancelled') }; }
    catch (error) { throw this._error(409, error.message); }
  }

  savePlace(body = {}) {
    if (!this.context) throw this._error(503, 'Location context is unavailable.');
    try { return { place: this.context.savePlace(body) }; }
    catch (error) { throw this._error(400, error.message); }
  }

  deleteContext(recordType, recordKey) {
    try { return { deleted: this.store.deleteContext(recordType, decodeURIComponent(recordKey)) }; }
    catch (error) { throw this._error(400, error.message); }
  }

  ingestLocation(body = {}, device = null) {
    if (body.consent !== true) throw this._error(403, 'Location context requires explicit consent.');
    const deviceId = this.contextDeviceId(body, device);
    const latitude = Number(body.latitude); const longitude = Number(body.longitude); const accuracy = Number(body.accuracy);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(accuracy) || accuracy < 0) throw this._error(400, 'Location requires valid coordinates and non-negative accuracy.');
    const capturedAt = Number(body.capturedAt || this.clock());
    const result = this.ingestContextEvent({ ...body, deviceId, payload: { latitude, longitude, accuracy, capturedAt, consentScope: String(body.consentScope || 'location') } }, 'location');
    return { ...result, location: this.context?.processLocation({ eventId: result.event.eventId, latitude, longitude, accuracy, capturedAt, deviceId }) || { stale: true, triggers: [] } };
  }

  ingestSensor(body = {}, device = null) {
    if (body.consent !== true) throw this._error(403, 'Sensor context requires explicit consent.');
    const deviceId = this.contextDeviceId(body, device);
    const sensor = String(body.sensor || '').trim().toLowerCase();
    if (!sensor || !body.value || typeof body.value !== 'object' || Array.isArray(body.value)) throw this._error(400, 'Sensor context requires a sensor name and structured value.');
    const capturedAt = Number(body.capturedAt || this.clock());
    const result = this.ingestContextEvent({ ...body, deviceId, payload: { sensor, value: body.value, capturedAt, consentScope: String(body.consentScope || sensor) } }, 'sensor');
    const sensorContext = result.accepted.accepted
      ? this.context?.processSensor({ sensor, value: body.value, capturedAt, deviceId, consentScope: body.consentScope || sensor }) || { stale: true, context: null }
      : { stale: false, duplicate: true, context: null };
    return { ...result, sensorContext };
  }

  contextDeviceId(body = {}, device = null) {
    const supplied = body.deviceId ? String(body.deviceId) : null;
    const authenticated = device?.deviceId ? String(device.deviceId) : null;
    if (authenticated && supplied && supplied !== authenticated) throw this._error(403, 'Context device identity does not match the authenticated device.');
    return authenticated || supplied || 'paired-device';
  }

  ingestContextEvent(body, kind) {
    try {
      const event = normalizeIngestEvent({ eventId: body.eventId, source: 'mobile', actorId: body.deviceId || 'paired-device', producerEpoch: body.producerEpoch, seq: body.sequence, kind: 'observation', payload: { contextType: kind, ...body.payload } });
      const accepted = this.store.ingestEvent(event);
      const purged = this.store.purgeMobileContextEvents(this.clock() - this.mobileContextRetentionMs);
      return { accepted, purged, event: { eventId: event.eventId, type: kind, receivedAt: this.clock() } };
    } catch (error) { throw this._error(400, error.message); }
  }

  conversationId(value) {
    const candidate = String(value || MOBILE_CONVERSATION_ID);
    if (!/^[A-Za-z0-9:_-]{1,100}$/.test(candidate)) throw this._error(400, 'Invalid conversation ID.');
    return candidate;
  }

  _error(status, message) { return Object.assign(new Error(message), { status }); }
}

module.exports = { MobileApi, PROTOCOL_VERSION, MOBILE_CONVERSATION_ID };
