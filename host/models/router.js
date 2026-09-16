const RANK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' } }, required: ['taskId', 'score', 'reason'] } } },
  required: ['items'],
};
const ENTITY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { entities: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['person', 'organization', 'location', 'project'] }, value: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['type', 'value', 'start', 'end'] } } },
  required: ['entities'],
};

function validateRanking(result, tasks) {
  if (!result || !Array.isArray(result.items)) throw new Error('Model ranking must contain an items array.');
  const validIds = new Set(tasks.map((task) => String(task.taskId)));
  const seen = new Set();
  return result.items.filter((item) => {
    const id = String(item?.taskId || '');
    const score = Number(item?.score);
    if (!validIds.has(id) || seen.has(id) || !Number.isFinite(score) || score < 0 || score > 1 || typeof item.reason !== 'string' || !item.reason.trim()) return false;
    seen.add(id);
    return true;
  });
}

class ModelRouter {
  constructor({ privacyGateway, localClient = null, frontierClient = null, mode = 'local' } = {}) {
    if (!privacyGateway) throw new Error('Model router requires a privacy gateway.');
    this.privacyGateway = privacyGateway;
    this.localClient = localClient;
    this.frontierClient = frontierClient;
    this.mode = ['off', 'local', 'frontier'].includes(mode) ? mode : 'local';
  }

  status() {
    return { mode: this.mode, local: Boolean(this.localClient), frontier: Boolean(this.frontierClient), active: this.mode === 'frontier' ? Boolean(this.frontierClient) : this.mode === 'local' && Boolean(this.localClient) };
  }

  async rank(tasks = []) {
    if (this.mode === 'off' || !tasks.length) return { items: [], source: 'deterministic' };
    const client = this.mode === 'frontier' ? this.frontierClient : this.localClient;
    if (!client) return { items: [], source: 'deterministic' };
    const safeTasks = await Promise.all(tasks.map(async (task) => {
      const source = { taskId: task.taskId, summary: task.summary, owner: task.owner, blocker: task.blocker, counterparty: task.counterparty, dueDate: task.dueDate, confidence: task.confidence };
      const safe = { ...source };
      for (const key of ['summary', 'counterparty']) {
        if (typeof source[key] === 'string') safe[key] = (await this.privacyGateway.pseudonymizeWithRecognizer(source[key], (text) => this.recognizeEntities(text))).text;
      }
      return this.privacyGateway.prepareRemotePayload(safe);
    }));
    const result = await client.complete({
      system: 'Rank personal obligations for a daily assistant. Return only JSON matching the schema. Never propose an action or change task state. Prefer precision over recall.',
      prompt: JSON.stringify({ tasks: safeTasks }),
      schema: RANK_SCHEMA,
    });
    return { items: validateRanking(result, tasks), source: this.mode };
  }

  async availability() {
    const localAvailable = this.localClient?.available ? await this.localClient.available() : null;
    return { ...this.status(), localAvailable, localModel: this.localClient?.model || null };
  }

  async recognizeEntities(text) {
    if (!this.localClient) return [];
    const result = await this.localClient.complete({
      system: 'Find named entities in the text. Return only exact spans from the text. Do not infer entities that are not present.',
      prompt: String(text || ''),
      schema: ENTITY_SCHEMA,
    });
    if (!Array.isArray(result?.entities)) return [];
    const input = String(text || '');
    return result.entities.filter((entity) => entity && ['person', 'organization', 'location', 'project'].includes(entity.type)
      && Number.isInteger(entity.start) && Number.isInteger(entity.end) && entity.start >= 0 && entity.end > entity.start && entity.end <= input.length
      && input.slice(entity.start, entity.end) === entity.value);
  }
}

module.exports = { ModelRouter, RANK_SCHEMA, ENTITY_SCHEMA, validateRanking };
