const crypto = require('crypto');

class BrowserBridge {
  constructor({ clock = () => Date.now(), ttlMs = 15_000, heartbeatMs = 3_000 } = {}) { this.clock = clock; this.ttlMs = ttlMs; this.heartbeatMs = heartbeatMs; this.pending = new Map(); this.waiters = new Map(); this.expiryTimers = new Map(); this.lastSeen = new Map(); }

  enqueue({ sessionId, step, origin } = {}) {
    if (!sessionId || !step || !origin) throw new Error('A browser request requires a session, step, and origin.');
    const requestId = crypto.randomUUID();
    this.pending.set(requestId, { requestId, sessionId, origin, step, expiresAt: this.clock() + this.ttlMs, claimed: false });
    const timer = setTimeout(() => this.expire(requestId), this.ttlMs);
    timer.unref?.();
    this.expiryTimers.set(requestId, timer);
    return requestId;
  }

  expire(requestId) {
    const request = this.pending.get(requestId);
    if (!request || request.expiresAt > this.clock()) return false;
    this.pending.delete(requestId);
    const timer = this.expiryTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(requestId);
    const waiter = this.waiters.get(requestId);
    if (waiter) {
      this.waiters.delete(requestId);
      waiter.reject(new Error('Browser request expired before the extension completed it.'));
    }
    return true;
  }

  wait(requestId) {
    const request = this.pending.get(requestId);
    if (!request) return Promise.reject(new Error('Browser request is unknown or expired.'));
    return new Promise((resolve, reject) => this.waiters.set(requestId, { resolve, reject, expiresAt: request.expiresAt }));
  }

  next({ sessionId } = {}) {
    const now = this.clock();
    if (sessionId) this.lastSeen.set(sessionId, now);
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) {
        this.expire(id);
      } else if (request.sessionId === sessionId && !request.claimed) {
        request.claimed = true;
        return { ...request };
      }
    }
    return null;
  }

  status(sessionId, now = this.clock()) {
    const lastSeenAt = this.lastSeen.get(sessionId) || null;
    const pending = [...this.pending.values()].filter((request) => request.sessionId === sessionId).length;
    return { sessionId, connected: Boolean(lastSeenAt && now - lastSeenAt <= this.heartbeatMs), lastSeenAt, pending };
  }

  complete({ requestId, sessionId, origin, result, error } = {}) {
    const request = this.pending.get(requestId);
    if (!request || request.sessionId !== sessionId || request.origin !== origin || request.expiresAt <= this.clock()) throw new Error('Browser request is unknown, expired, or bound to another session or origin.');
    this.pending.delete(requestId);
    const timer = this.expiryTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(requestId);
    const completed = { requestId, result, error: error || null };
    const waiter = this.waiters.get(requestId);
    if (waiter) { this.waiters.delete(requestId); if (error) waiter.reject(new Error(error)); else waiter.resolve(completed); }
    return completed;
  }
}

module.exports = { BrowserBridge };
