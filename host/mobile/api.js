const { normalizeIngestEvent } = require('../events/event-contract');

const PROTOCOL_VERSION = '1';
const MOBILE_CONVERSATION_ID = 'mobile:default';

class MobileApi {
  constructor({ store, conversation, proactivity, approvals = null, pairing = null, getStatus = null, clock = () => Date.now() } = {}) {
    if (!store || !conversation || !proactivity) throw new Error('Mobile API requires store, conversation, and proactivity services.');
    this.store = store;
    this.conversation = conversation;
    this.proactivity = proactivity;
    this.approvals = approvals; this.pairing = pairing;
    this.getStatus = getStatus || (() => ({ running: true }));
    this.clock = clock;
  }

  async handle({ method, path, query = {}, body = {}, headers = {}, device = null } = {}) {
    const operation = async () => {
      const parts = String(path || '').split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'mobile') throw this._error(404, 'Mobile endpoint not found.');
      const resource = parts[3] || '';
      if (method === 'POST' && resource === 'pair') return this.pair(body);
      if (method === 'GET' && resource === 'health') return { protocolVersion: PROTOCOL_VERSION, core: await this.getStatus() };
      if (method === 'GET' && resource === 'today') return this.today();
      if (method === 'GET' && resource === 'conversation') return { conversationId: this.conversationId(query.conversationId), messages: this.conversation.history(this.conversationId(query.conversationId)) };
      if (method === 'POST' && resource === 'conversation' && parts[4] === 'messages') return this.sendMessage(body);
      if (method === 'GET' && resource === 'workflows') return { workflows: this.store.listWorkflows({ activeOnly: query.activeOnly !== 'false' }) };
      if (method === 'POST' && resource === 'workflows' && parts[4] && parts[5] === 'cancel') return { workflow: this.store.updateWorkflow(parts[4], { state: 'cancelled', details: { reason: 'mobile-user-cancelled' } }) };
      if (method === 'GET' && resource === 'context') return { context: this.store.listContext() };
      if (method === 'GET' && resource === 'permissions') return { permissions: this.store.listStandingGrants({ principal: 'signal-box-user' }) };
      if (method === 'POST' && resource === 'permissions' && parts[4] && parts[5] === 'revoke') return { permission: this.revokePermission(parts[4]) };
      if (method === 'POST' && resource === 'permissions') return { permission: this.createPermission(body) };
      if (method === 'POST' && resource === 'tasks' && parts[4] && parts[5] === 'status') return { task: this.updateTask(parts[4], body) };
      if (method === 'POST' && resource === 'context' && parts[4] === 'location') return this.ingestLocation({ ...body, deviceId: body.deviceId || device?.deviceId });
      if (method === 'POST' && resource === 'context' && parts[4] === 'sensor') return this.ingestSensor(body);
      throw this._error(404, 'Mobile endpoint not found.');
    };
    if (method !== 'POST') return operation();
    const commandId = String(headers['idempotency-key'] || body.externalId || '').trim();
    if (!commandId || commandId.length > 200) throw this._error(400, 'An idempotency key is required for mobile commands.');
    const cached = this.store.getMobileCommand(commandId);
    if (cached) return { ...cached.result, replayed: true, ...(Object.prototype.hasOwnProperty.call(cached.result, 'duplicate') ? { duplicate: true } : {}) };
    const result = await operation();
    this.store.saveMobileCommand(commandId, `${method} ${path}`, result);
    return { ...result, replayed: false };
  }

  pair(body = {}) {
    if (!this.pairing) throw this._error(503, 'Mobile pairing is unavailable.');
    try { return this.pairing.pair({ code: body.code, deviceName: body.deviceName }); }
    catch (error) { throw this._error(400, error.message); }
  }

  authenticate(token) { return this.pairing?.authenticate(token) || null; }

  today() {
    const tasks = this.store.listTasks();
    return { protocolVersion: PROTOCOL_VERSION, generatedAt: this.clock(), tasks, decisions: this.proactivity.evaluate(tasks), workflows: this.store.listWorkflows({ activeOnly: true }) };
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

  ingestLocation(body = {}) {
    if (body.consent !== true) throw this._error(403, 'Location context requires explicit consent.');
    const latitude = Number(body.latitude); const longitude = Number(body.longitude); const accuracy = Number(body.accuracy);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(accuracy) || accuracy < 0) throw this._error(400, 'Location requires valid coordinates and non-negative accuracy.');
    return this.ingestContextEvent({ ...body, payload: { latitude, longitude, accuracy, capturedAt: Number(body.capturedAt || this.clock()), consentScope: String(body.consentScope || 'location') } }, 'location');
  }

  ingestSensor(body = {}) {
    if (body.consent !== true) throw this._error(403, 'Sensor context requires explicit consent.');
    const sensor = String(body.sensor || '').trim();
    if (!sensor || !body.value || typeof body.value !== 'object' || Array.isArray(body.value)) throw this._error(400, 'Sensor context requires a sensor name and structured value.');
    return this.ingestContextEvent({ ...body, payload: { sensor, value: body.value, capturedAt: Number(body.capturedAt || this.clock()), consentScope: String(body.consentScope || sensor) } }, 'sensor');
  }

  ingestContextEvent(body, kind) {
    try {
      const event = normalizeIngestEvent({ eventId: body.eventId, source: 'mobile', actorId: body.deviceId || 'paired-device', producerEpoch: body.producerEpoch, seq: body.sequence, kind: 'observation', payload: { contextType: kind, ...body.payload } });
      return { accepted: this.store.ingestEvent(event), event: { eventId: event.eventId, type: kind, receivedAt: this.clock() } };
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
