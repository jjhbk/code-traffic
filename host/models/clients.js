class JsonModelClient {
  constructor({ model, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    if (!model) throw new Error('A model name is required.');
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000;
  }

  requestOptions(options = {}) {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined;
    return signal ? { ...options, signal } : options;
  }
}

class OllamaClient extends JsonModelClient {
  constructor({ model = 'qwen3:4b-instruct', baseUrl = 'http://127.0.0.1:11434', ...options } = {}) {
    super({ model, ...options });
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async available() {
    return (await this.availabilityDetails()).available;
  }

  async availabilityDetails() {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(1500) : undefined;
    let response;
    try { response = await this.fetch(`${this.baseUrl}/api/tags`, signal ? { signal } : undefined); }
    catch (_) { return { available: false, reason: 'ollama-unreachable' }; }
    if (!response.ok) return { available: false, reason: `ollama-http-${response.status}` };
    let body;
    try { body = await response.json(); } catch (_) { return { available: false, reason: 'ollama-invalid-response' }; }
    if (!Array.isArray(body.models)) return { available: false, reason: 'ollama-invalid-model-list' };
    const available = body.models.some((item) => item.name === this.model || item.name?.startsWith(`${this.model}:`));
    return { available, reason: available ? null : 'model-not-installed' };
  }

  async complete({ system, prompt, schema } = {}) {
    const response = await this.fetch(`${this.baseUrl}/api/chat`, this.requestOptions({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, stream: false, format: schema, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    }));
    const body = await response.json();
    if (!response.ok) throw new Error(`Local model request failed: ${body.error || response.status}`);
    try { return JSON.parse(body.message?.content || '{}'); } catch (_) { throw new Error('Local model returned invalid JSON.'); }
  }
}

class OpenAICompatibleClient extends JsonModelClient {
  constructor({ model, baseUrl = 'https://api.openai.com/v1', apiKey, ...options } = {}) {
    super({ model, ...options });
    if (!apiKey) throw new Error('A frontier model API key is required.');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async complete({ system, prompt, schema } = {}) {
    const response = await this.fetch(`${this.baseUrl}/chat/completions`, this.requestOptions({
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, temperature: 0, response_format: { type: 'json_schema', json_schema: { name: 'signal_box_result', strict: true, schema } }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    }));
    const body = await response.json();
    if (!response.ok) throw new Error(`Frontier model request failed: ${body.error?.message || body.error || response.status}`);
    try { return JSON.parse(body.choices?.[0]?.message?.content || '{}'); } catch (_) { throw new Error('Frontier model returned invalid JSON.'); }
  }
}

module.exports = { OllamaClient, OpenAICompatibleClient };
