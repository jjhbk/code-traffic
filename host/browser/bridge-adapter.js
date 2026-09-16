class BridgeBrowserAdapter {
  constructor({ bridge, sessionId, origin } = {}) {
    if (!bridge || !sessionId || !origin) throw new Error('Bridge browser adapter requires a bridge, session, and origin.');
    this.bridge = bridge; this.sessionId = sessionId; this.origin = origin;
  }

  async perform(step) {
    const requestId = this.bridge.enqueue({ sessionId: this.sessionId, origin: this.origin, step });
    const result = await this.bridge.wait(requestId);
    if (result.error) throw new Error(result.error);
    return result.result;
  }
}

module.exports = { BridgeBrowserAdapter };
