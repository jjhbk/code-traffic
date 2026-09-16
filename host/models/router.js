const RANK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' }, score: { type: 'number' }, reason: { type: 'string' } }, required: ['taskId', 'score', 'reason'] } } },
  required: ['items'],
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
    const safeTasks = tasks.map((task) => this.privacyGateway.prepareRemotePayload({ taskId: task.taskId, summary: task.summary, owner: task.owner, blocker: task.blocker, counterparty: task.counterparty, dueDate: task.dueDate, confidence: task.confidence }));
    const result = await client.complete({
      system: 'Rank personal obligations for a daily assistant. Return only JSON matching the schema. Never propose an action or change task state. Prefer precision over recall.',
      prompt: JSON.stringify({ tasks: safeTasks }),
      schema: RANK_SCHEMA,
    });
    return { items: validateRanking(result, tasks), source: this.mode };
  }
}

module.exports = { ModelRouter, RANK_SCHEMA, validateRanking };
