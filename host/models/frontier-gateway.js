const path = require('path');
const { fork } = require('child_process');

class IsolatedFrontierClient {
  constructor({ model, baseUrl, apiKey, workerPath = path.join(__dirname, 'frontier-worker.js'), forkImpl = fork } = {}) {
    if (!apiKey) throw new Error('A frontier model API key is required.');
    this.model = model;
    this.process = forkImpl(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, SIGNAL_BOX_FRONTIER_MODEL: model || '', SIGNAL_BOX_FRONTIER_BASE_URL: baseUrl || 'https://api.openai.com/v1', SIGNAL_BOX_FRONTIER_API_KEY: apiKey } });
    this.nextId = 1;
    this.pending = new Map();
    this.process.on('message', (message) => {
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    this.process.on('exit', () => {
      for (const request of this.pending.values()) request.reject(new Error('Frontier model gateway exited.'));
      this.pending.clear();
    });
  }

  available() { return Boolean(this.process.connected && !this.process.killed); }

  complete(payload) {
    if (!this.available()) return Promise.reject(new Error('Frontier model gateway is unavailable.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.send({ id, payload }, (error) => {
        if (error && this.pending.delete(id)) reject(error);
      });
    });
  }

  close() {
    for (const request of this.pending.values()) request.reject(new Error('Frontier model gateway closed.'));
    this.pending.clear();
    if (!this.process.killed) this.process.kill();
  }
}

module.exports = { IsolatedFrontierClient };
