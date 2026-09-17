const OUTBOX_KEY = 'signal-box.mobile.outbox.v1';
const NOTIFICATION_CURSOR_KEY = 'signal-box.mobile.notifications.cursor.v1';

function assistantHealthStatus(payload = {}) {
  const core = payload.core || payload;
  const background = core.background || null;
  const jobs = core.jobs || {};
  const backgroundJobs = background?.jobs || {};
  const overdue = Number(jobs.overdue || 0) + Number(backgroundJobs.overdue || 0);
  const expiredRunning = Number(jobs.expiredRunning || 0) + Number(backgroundJobs.expiredRunning || 0);
  const queued = Number(jobs.queued || 0) + Number(backgroundJobs.queued || 0);
  if (core.paused || background?.paused) return { key: 'paused', label: 'PAUSED', detail: 'Monitoring is paused by you.', queued, overdue, expiredRunning };
  if (background?.lifecycle === 'recovering' || overdue > 0 || expiredRunning > 0) return { key: 'catching-up', label: 'CATCHING UP', detail: overdue || expiredRunning ? 'The assistant is working through delayed background work.' : 'The background host is recovering.', queued, overdue, expiredRunning };
  if (core.running === false && background?.running !== true) return { key: 'unavailable', label: 'UNAVAILABLE', detail: 'The Electron core is not reachable.', queued, overdue, expiredRunning };
  if (background?.lifecycle === 'starting') return { key: 'starting', label: 'STARTING', detail: 'The assistant is starting up.', queued, overdue, expiredRunning };
  if (core.running === true || background?.running === true) return { key: 'running', label: 'RUNNING', detail: queued ? `${queued} durable job${queued === 1 ? '' : 's'} queued.` : 'Monitoring your context and work.', queued, overdue, expiredRunning };
  return { key: 'unknown', label: 'CONNECTING', detail: 'Checking the Electron core.', queued, overdue, expiredRunning };
}

function id() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

class MobileApiError extends Error {
  constructor(message, { status = null, payload = null } = {}) {
    super(message); this.name = 'MobileApiError'; this.status = status; this.payload = payload;
  }
}

class MobileCoreClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, storage = null, clock = () => Date.now() } = {}) {
    if (!baseUrl || !token || typeof fetchImpl !== 'function') throw new Error('Mobile core client requires base URL, token, and fetch implementation.');
    this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl; this.storage = storage; this.clock = clock;
  }

  async request(path, { method = 'GET', body = undefined, idempotencyKey = null } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw Object.assign(new MobileApiError(`Signal Box core is unreachable: ${error.message}`), { code: 'NETWORK_UNAVAILABLE' });
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* Empty response. */ }
    if (!response.ok) throw new MobileApiError(payload?.error || `Core request failed with status ${response.status}.`, { status: response.status, payload });
    return payload;
  }

  health() { return this.request('/api/v1/mobile/health'); }
  async setAssistantPaused(paused) { return this.command('/api/v1/mobile/assistant/pause', { paused: Boolean(paused) }); }
  autonomousRuns(limit = 50) { return this.request(`/api/v1/mobile/assistant/autonomous-runs?limit=${encodeURIComponent(limit)}`); }
  today() { return this.request('/api/v1/mobile/today'); }
  taskGraph({ taskId = '', depth = 2, limit = 100 } = {}) { return this.request(`/api/v1/mobile/graph?taskId=${encodeURIComponent(taskId)}&depth=${encodeURIComponent(depth)}&limit=${encodeURIComponent(limit)}`); }
  conversation(conversationId = 'mobile:default') { return this.request(`/api/v1/mobile/conversation?conversationId=${encodeURIComponent(conversationId)}`); }
  workflows() { return this.request('/api/v1/mobile/workflows'); }
  context() { return this.request('/api/v1/mobile/context'); }
  permissions() { return this.request('/api/v1/mobile/permissions'); }
  approvals() { return this.request('/api/v1/mobile/approvals'); }
  connections() { return this.request('/api/v1/mobile/connections'); }
  notifications(after = '') { return this.request(`/api/v1/mobile/notifications?after=${encodeURIComponent(after)}`); }
  async syncNotifications() {
    let cursor = '';
    if (this.storage) cursor = (await this.storage.getItem(NOTIFICATION_CURSOR_KEY)) || '';
    const result = await this.notifications(cursor);
    if (this.storage && result.nextCursor) await this.storage.setItem(NOTIFICATION_CURSOR_KEY, result.nextCursor);
    return result;
  }
  pairDevice(code, deviceName = 'Signal Box mobile') { return this.request('/api/v1/mobile/pair', { method: 'POST', body: { code, deviceName }, idempotencyKey: `pair:${code}` }); }

  async sendMessage(text, { conversationId = 'mobile:default', externalId = id() } = {}) {
    return this.command('/api/v1/mobile/conversation/messages', { conversationId, text, externalId }, externalId);
  }

  async updateTask(taskId, body) { return this.command(`/api/v1/mobile/tasks/${encodeURIComponent(taskId)}/status`, body); }
  async cancelWorkflow(workflowId) { return this.command(`/api/v1/mobile/workflows/${encodeURIComponent(workflowId)}/cancel`, {}); }
  async createPermission(body) { return this.command('/api/v1/mobile/permissions', body); }
  async revokePermission(grantId) { return this.command(`/api/v1/mobile/permissions/${encodeURIComponent(grantId)}/revoke`, {}); }
  async decideApproval(requestId, optionId) { return this.command(`/api/v1/mobile/approvals/${encodeURIComponent(requestId)}/decide`, { optionId }); }
  async sendLocation(body) { return this.command('/api/v1/mobile/context/location', body); }
  async savePlace(body) { return this.command('/api/v1/mobile/context/place', body); }
  async sendSensor(body) { return this.command('/api/v1/mobile/context/sensor', body); }
  async deleteContext(recordType, recordKey) { return this.command(`/api/v1/mobile/context/${encodeURIComponent(recordType)}/${encodeURIComponent(recordKey)}/delete`, {}); }
  async acknowledgeNotification(notificationId) { return this.command(`/api/v1/mobile/notifications/${encodeURIComponent(notificationId)}/ack`, {}); }
  async registerPushToken(pushToken, platform = 'expo') { return this.command('/api/v1/mobile/devices/push-token', { pushToken, platform }); }
  async revokePushToken() { return this.command('/api/v1/mobile/devices/push-token/revoke', {}); }
  async confirmAutonomousRun(runId, evidence) { return this.command(`/api/v1/mobile/assistant/autonomous-runs/${encodeURIComponent(runId)}/confirm`, { evidence }); }

  async command(path, body, commandId = id()) {
    try { return await this.request(path, { method: 'POST', body, idempotencyKey: commandId }); }
    catch (error) {
      if (error.code !== 'NETWORK_UNAVAILABLE' || !this.storage) throw error;
      const outbox = await this.readOutbox();
      if (!outbox.some((item) => item.commandId === commandId)) { outbox.push({ commandId, path, body, createdAt: this.clock() }); await this.writeOutbox(outbox); }
      return { queued: true, commandId, pending: outbox.length };
    }
  }

  async flushOutbox() {
    const pending = await this.readOutbox(); const remaining = [];
    for (const item of pending) {
      try { await this.request(item.path, { method: 'POST', body: item.body, idempotencyKey: item.commandId }); }
      catch (error) { remaining.push(item); if (error.code === 'NETWORK_UNAVAILABLE') break; }
    }
    await this.writeOutbox(remaining); return { flushed: pending.length - remaining.length, pending: remaining.length };
  }

  async readOutbox() {
    if (!this.storage) return [];
    try { const value = await this.storage.getItem(OUTBOX_KEY); const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; }
    catch (_) { return []; }
  }

  async writeOutbox(items) { if (this.storage) await this.storage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-100))); }
}

module.exports = { MobileCoreClient, MobileApiError, OUTBOX_KEY, NOTIFICATION_CURSOR_KEY, assistantHealthStatus };
