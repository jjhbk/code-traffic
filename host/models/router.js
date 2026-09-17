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
const NEXT_STEP_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['wait', 'clarify', 'draft_follow_up', 'suggest_resolution'] },
    reason: { type: 'string' },
    requiresApproval: { type: 'boolean' },
  },
  required: ['decision', 'reason', 'requiresApproval'],
};
const DRAFT_REPLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
};
const OBLIGATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { obligations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    summary: { type: 'string' }, owner: { type: 'string', enum: ['self', 'counterparty', 'uncertain'] }, blocker: { type: 'string', enum: ['self', 'counterparty', 'uncertain'] }, counterparty: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] }, dueDateBasis: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, evidenceText: { type: 'string' }, evidenceStart: { type: 'integer' }, evidenceEnd: { type: 'integer' },
  }, required: ['summary', 'owner', 'blocker', 'counterparty', 'dueDate', 'dueDateBasis', 'confidence', 'evidenceText', 'evidenceStart', 'evidenceEnd'] } } },
  required: ['obligations'],
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

function validateNextStep(result) {
  const decisions = new Set(['wait', 'clarify', 'draft_follow_up', 'suggest_resolution']);
  if (!result || !decisions.has(result.decision) || typeof result.reason !== 'string' || !result.reason.trim() || typeof result.requiresApproval !== 'boolean') throw new Error('Invalid next-step proposal.');
  if (result.decision === 'draft_follow_up' && !result.requiresApproval) throw new Error('A follow-up proposal requires approval.');
  return { decision: result.decision, reason: result.reason.trim(), requiresApproval: result.requiresApproval };
}

function validateDraftReply(result) {
  if (!result || typeof result.subject !== 'string' || !result.subject.trim() || typeof result.body !== 'string' || !result.body.trim() || result.body.length > 10_000) throw new Error('Invalid reply draft.');
  return { subject: result.subject.replace(/[\r\n]/g, ' ').trim(), body: result.body.trim() };
}

function validateObligations(result, sourceText) {
  if (!result || !Array.isArray(result.obligations)) throw new Error('Model extraction must contain an obligations array.');
  const source = String(sourceText || '');
  const obligations = result.obligations.map((item) => {
    if (!item || typeof item.summary !== 'string' || !item.summary.trim() || !['self', 'counterparty', 'uncertain'].includes(item.owner) || !['self', 'counterparty', 'uncertain'].includes(item.blocker) || !['low', 'medium', 'high'].includes(item.confidence)) return null;
    const evidenceText = String(item.evidenceText || '');
    const start = Number(item.evidenceStart);
    const end = Number(item.evidenceEnd);
    if (!evidenceText || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length || source.slice(start, end) !== evidenceText) return null;
    return { ...item, summary: item.summary.trim(), evidenceText, evidenceStart: start, evidenceEnd: end, counterparty: item.counterparty || null, dueDate: item.dueDate || null, dueDateBasis: item.dueDateBasis || null };
  }).filter(Boolean);
  return { obligations };
}

class ModelRouter {
  constructor({ privacyGateway, localClient = null, frontierClient = null, mode = 'local' } = {}) {
    if (!privacyGateway) throw new Error('Model router requires a privacy gateway.');
    this.privacyGateway = privacyGateway;
    this.localClient = localClient;
    this.frontierClient = frontierClient;
    this.mode = ['off', 'local', 'frontier'].includes(mode) ? mode : 'local';
    this.metrics = {
      rankingCalls: 0,
      localCalls: 0,
      frontierCalls: 0,
      privacyTransforms: 0,
      lastLocalCall: null,
      lastRanking: null,
      planningCalls: 0,
      lastDecision: null,
      lastPrivacyCheck: null,
    };
  }

  status() {
    return { mode: this.mode, local: Boolean(this.localClient), frontier: Boolean(this.frontierClient), active: this.mode === 'frontier' ? Boolean(this.frontierClient && this.localClient) : this.mode === 'local' && Boolean(this.localClient) };
  }

  diagnostics() {
    return {
      ...this.status(),
      localModel: this.localClient?.model || null,
      frontierModel: this.frontierClient?.model || null,
      metrics: JSON.parse(JSON.stringify(this.metrics)),
    };
  }

  async rank(tasks = []) {
    this.metrics.rankingCalls += 1;
    this.metrics.lastRanking = { source: 'pending', taskCount: tasks.length, status: 'running', at: Date.now() };
    if (this.mode === 'off' || !tasks.length) {
      this.metrics.lastRanking = { source: 'deterministic', taskCount: tasks.length, at: Date.now() };
      return { items: [], source: 'deterministic' };
    }
    const client = this.mode === 'frontier' ? this.frontierClient : this.localClient;
    if (!client) {
      this.metrics.lastRanking = { source: 'deterministic', reason: 'model-not-configured', taskCount: tasks.length, at: Date.now() };
      return { items: [], source: 'deterministic' };
    }
    // Do not call an unavailable local model. This keeps an uninstalled Ollama
    // model from producing a request error on every scheduled digest.
    if (typeof this.localClient?.availabilityDetails === 'function') {
      let localDetails;
      try { localDetails = await this.localClient.availabilityDetails(); } catch (_) { localDetails = { available: false, reason: 'local-model-unavailable' }; }
      if (!localDetails.available) {
        const reason = this.mode === 'frontier' ? 'local-privacy-model-unavailable' : localDetails.reason || 'local-model-unavailable';
        this.metrics.lastRanking = { source: 'deterministic', reason, taskCount: tasks.length, at: Date.now() };
        return { items: [], source: 'deterministic', reason };
      }
    } else if (this.mode === 'frontier' && typeof this.localClient?.available === 'function') {
      let localAvailable = false;
      try { localAvailable = await this.localClient.available(); } catch (_) { localAvailable = false; }
      if (!localAvailable) {
        this.metrics.lastRanking = { source: 'deterministic', reason: 'local-privacy-model-unavailable', taskCount: tasks.length, at: Date.now() };
        return { items: [], source: 'deterministic', reason: 'local-privacy-model-unavailable' };
      }
    }
    const safeTasks = await Promise.all(tasks.map(async (task) => {
      const source = { taskId: task.taskId, summary: task.summary, owner: task.owner, blocker: task.blocker, counterparty: task.counterparty, dueDate: task.dueDate, confidence: task.confidence };
      const safe = { ...source };
      for (const key of ['summary', 'counterparty']) {
        if (typeof source[key] === 'string') {
          safe[key] = (await this.privacyGateway.pseudonymizeWithRecognizer(source[key], (text) => this.recognizeEntities(text), { failClosed: this.mode === 'frontier' })).text;
          this.metrics.privacyTransforms += 1;
        }
      }
      return this.privacyGateway.prepareRemotePayload(safe);
    }));
    const payloadText = JSON.stringify({ tasks: safeTasks });
    this.metrics.lastPrivacyCheck = {
      at: Date.now(),
      fields: safeTasks.length,
      redacted: !payloadText.match(/@[A-Z0-9.-]+\.[A-Z]{2,}/i),
      payloadBytes: Buffer.byteLength(payloadText),
      boundary: this.mode === 'frontier' ? 'pseudonymized-to-frontier' : 'local-model-only',
    };
    try {
      if (this.mode === 'frontier') this.metrics.frontierCalls += 1;
      else this.metrics.localCalls += 1;
      const result = await client.complete({
        system: 'Rank personal obligations for a daily assistant. Return only JSON matching the schema. Never propose an action or change task state. Prefer precision over recall.',
        prompt: payloadText,
        schema: RANK_SCHEMA,
      });
      const items = validateRanking(result, tasks);
      this.metrics.lastRanking = { source: this.mode, taskCount: tasks.length, returned: items.length, at: Date.now(), status: 'ok' };
      return { items, source: this.mode };
    } catch (error) {
      this.metrics.lastRanking = { source: this.mode, taskCount: tasks.length, at: Date.now(), status: 'error', error: error.message };
      throw error;
    }
  }

  async extractObligations(observation) {
    const source = `${observation?.subject || ''}\n${observation?.body || ''}`.trim();
    if (!source || this.mode === 'off' || !this.localClient) return { obligations: [], source: 'deterministic', version: 'structured-1' };
    if (typeof this.localClient.availabilityDetails === 'function') {
      const details = await this.localClient.availabilityDetails();
      if (!details.available) return { obligations: [], source: 'deterministic', reason: details.reason, version: 'structured-1' };
    }
    const safeSource = this.mode === 'frontier'
      ? (await this.privacyGateway.pseudonymizeWithRecognizer(source, (text) => this.recognizeEntities(text), { failClosed: true })).text
      : source;
    if (this.mode === 'frontier') return { obligations: [], source: 'deterministic', reason: 'frontier-evidence-offsets-unavailable', version: 'structured-1' };
    this.metrics.localCalls += 1;
    const result = validateObligations(await this.localClient.complete({
      system: 'Extract personal obligations from the source. Return only JSON matching the schema. Extract separate commitments separately. Use only exact source spans for evidence. Do not invent tasks, people, dates, or actions.',
      prompt: JSON.stringify({ source: safeSource, direction: observation.direction || null }),
      schema: OBLIGATION_SCHEMA,
    }), source);
    return { ...result, source: 'local', version: 'structured-1' };
  }

  async proposeNextStep(task, context = []) {
    if (!task?.taskId) throw new Error('A task is required for planning.');
    this.metrics.planningCalls += 1;
    const fallback = () => {
      if (task.confidence === 'low' && !task.dueDate) return { decision: 'clarify', reason: 'The obligation is uncertain and has no deadline.', requiresApproval: false };
      if (task.owner === 'counterparty' && task.blocker === 'self') return { decision: 'draft_follow_up', reason: 'The other party appears to be blocking progress.', requiresApproval: true };
      return { decision: 'wait', reason: 'There is no safe next action yet.', requiresApproval: false };
    };
    if (this.mode === 'off') return { ...fallback(), source: 'deterministic' };
    const client = this.mode === 'frontier' ? this.frontierClient : this.localClient;
    if (!client) return { ...fallback(), source: 'deterministic', reason: 'model-not-configured' };
    const safeTask = {};
    for (const [key, value] of Object.entries({ taskId: task.taskId, summary: task.summary, owner: task.owner, blocker: task.blocker, counterparty: task.counterparty, dueDate: task.dueDate, confidence: task.confidence })) {
      safeTask[key] = typeof value === 'string'
        ? (await this.privacyGateway.pseudonymizeWithRecognizer(value, (text) => this.recognizeEntities(text), { failClosed: this.mode === 'frontier' })).text
        : value;
    }
    const safeContext = context.slice(0, 12).map((item) => this.privacyGateway.prepareRemotePayload(item, ['sourceId', 'summary', 'status', 'dueDate', 'recordType', 'recordKey', 'value', 'confidence', 'confirmed']));
    const payload = JSON.stringify({ task: this.privacyGateway.prepareRemotePayload(safeTask), context: safeContext });
    this.metrics.lastPrivacyCheck = { at: Date.now(), fields: 1 + safeContext.length, redacted: !/@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(payload), payloadBytes: Buffer.byteLength(payload), boundary: this.mode === 'frontier' ? 'pseudonymized-to-frontier' : 'local-model-only' };
    try {
      if (this.mode === 'frontier') this.metrics.frontierCalls += 1; else this.metrics.localCalls += 1;
      const result = validateNextStep(await client.complete({
        system: 'Choose the safest next step for a personal obligation. Return only JSON matching the schema. Never send, change, or approve anything. A draft follow-up always requires approval.',
        prompt: payload,
        schema: NEXT_STEP_SCHEMA,
      }));
      this.metrics.lastDecision = { source: this.mode, taskId: task.taskId, decision: result.decision, at: Date.now(), status: 'ok' };
      return { ...result, source: this.mode };
    } catch (error) {
      this.metrics.lastDecision = { source: this.mode, taskId: task.taskId, at: Date.now(), status: 'error', error: error.message };
      throw error;
    }
  }

  async draftReply(task, context = []) {
    if (!task?.taskId) throw new Error('A task is required for drafting.');
    const fallback = { subject: String(task.summary || 'Follow up').startsWith('Re:') ? String(task.summary) : `Re: ${task.summary || 'Follow up'}`, body: `Hi,\n\nI’m following up on ${task.summary || 'this request'}. Could you share an update when you have a chance?\n\nThanks.` };
    if (this.mode === 'off') return { ...fallback, source: 'deterministic' };
    const client = this.mode === 'frontier' ? this.frontierClient : this.localClient;
    if (!client) return { ...fallback, source: 'deterministic', reason: 'model-not-configured' };
    const safeTask = this.privacyGateway.prepareRemotePayload({ taskId: task.taskId, summary: task.summary, counterparty: task.counterparty, dueDate: task.dueDate, evidence: task.evidence?.text });
    if (this.mode === 'frontier') {
      for (const key of ['summary', 'counterparty', 'evidence']) {
        if (typeof task[key] === 'string') safeTask[key] = (await this.privacyGateway.pseudonymizeWithRecognizer(task[key], (text) => this.recognizeEntities(text), { failClosed: true })).text;
      }
    }
    const safeContext = context.slice(0, 12).map((item) => this.privacyGateway.prepareRemotePayload(item, ['sourceId', 'summary', 'status', 'dueDate', 'recordType', 'recordKey', 'value', 'confidence', 'confirmed']));
    try {
      if (this.mode === 'frontier') this.metrics.frontierCalls += 1; else this.metrics.localCalls += 1;
      const draft = validateDraftReply(await client.complete({
        system: 'Draft one concise, respectful follow-up email for a personal assistant. Return only JSON matching the schema. Do not claim work was completed. Do not add recipients or send the email.',
        prompt: JSON.stringify({ task: safeTask, context: safeContext }),
        schema: DRAFT_REPLY_SCHEMA,
      }));
      return { ...draft, source: this.mode };
    } catch (error) {
      return { ...fallback, source: 'deterministic', reason: error.message };
    }
  }

  async availability() {
    let localAvailable = null;
    let localError = null;
    if (this.localClient?.available) {
      try {
        if (typeof this.localClient.availabilityDetails === 'function') {
          const details = await this.localClient.availabilityDetails();
          localAvailable = details.available;
          localError = details.reason;
        } else localAvailable = await this.localClient.available();
      }
      catch (error) { localAvailable = false; localError = error.message; }
    }
    return { ...this.status(), localAvailable, localError, localModel: this.localClient?.model || null };
  }

  async recognizeEntities(text) {
    if (!this.localClient) return [];
    this.metrics.localCalls += 1;
    this.metrics.lastLocalCall = { at: Date.now(), purpose: 'entity-recognition', status: 'running' };
    try {
      const result = await this.localClient.complete({
        system: 'Find named entities in the text. Return only exact spans from the text. Do not infer entities that are not present.',
        prompt: String(text || ''),
        schema: ENTITY_SCHEMA,
      });
      this.metrics.lastLocalCall = { at: Date.now(), purpose: 'entity-recognition', status: 'ok' };
      if (!Array.isArray(result?.entities)) return [];
      const input = String(text || '');
      return result.entities.filter((entity) => entity && ['person', 'organization', 'location', 'project'].includes(entity.type)
        && Number.isInteger(entity.start) && Number.isInteger(entity.end) && entity.start >= 0 && entity.end > entity.start && entity.end <= input.length
        && input.slice(entity.start, entity.end) === entity.value);
    } catch (error) {
      this.metrics.lastLocalCall = { at: Date.now(), purpose: 'entity-recognition', status: 'error', error: error.message };
      throw error;
    }
  }

  async probe() {
    if (!this.localClient) throw new Error('No local model is configured.');
    const marker = 'diagnostic.person@example.com';
    const source = `Follow up with Morgan at ${marker} about the launch. Todo for Project Aurora.`;
    const entities = await this.recognizeEntities(source);
    const safe = (await this.privacyGateway.pseudonymizeWithRecognizer(source, (text) => this.recognizeEntities(text))).text;
    const payload = JSON.stringify({ summary: safe });
    const redacted = !payload.includes(marker) && !payload.includes('Morgan');
    const leaks = [marker, 'Morgan'].filter((value) => payload.includes(value));
    this.metrics.lastPrivacyCheck = { at: Date.now(), fields: 1, redacted, leaks, payloadBytes: Buffer.byteLength(payload), boundary: 'local-recognition-to-pseudonymized-payload' };
    return { localCall: true, entitiesDetected: entities.length, redacted, leaks, sample: safe.replace(/ent_[a-f0-9]+/g, 'ent_[stable-id]') };
  }
}

module.exports = { ModelRouter, RANK_SCHEMA, ENTITY_SCHEMA, NEXT_STEP_SCHEMA, DRAFT_REPLY_SCHEMA, OBLIGATION_SCHEMA, validateRanking, validateNextStep, validateDraftReply, validateObligations };
