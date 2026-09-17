const { candidateFilters } = require('../mail/normalize');
const { candidatesFromObservation, candidatesFromStructured } = require('./extract');

class TaskService {
  constructor({ store, extractorVersion = 'local-1', modelRouter = null } = {}) {
    if (!store) throw new Error('Task service requires a store.');
    this.store = store;
    this.extractorVersion = extractorVersion;
    this.modelRouter = modelRouter;
  }

  processObservation(observation) {
    const filters = candidateFilters(observation, { existingTaskThreadIds: new Set(this.store.taskThreadIds()) });
    const candidates = candidatesFromObservation(observation, { filters, extractorVersion: this.extractorVersion });
    if (!candidates.length) return [];
    return candidates.map((candidate) => this.store.saveTaskCandidate(candidate));
  }

  processAll(adapterId = null) {
    return this.store.observations(adapterId).flatMap((observation) => this.processObservation(observation));
  }

  async processObservationAsync(observation) {
    const filters = candidateFilters(observation, { existingTaskThreadIds: new Set(this.store.taskThreadIds()) });
    if (this.modelRouter?.extractObligations) {
      try {
        const structured = await this.modelRouter.extractObligations(observation);
        const candidates = candidatesFromStructured(observation, structured.obligations, { filters, extractorVersion: structured.version || 'structured-1' });
        if (candidates.length) return candidates.map((candidate) => this.store.saveTaskCandidate(candidate));
      } catch (_) {
        // Model extraction is advisory. Deterministic extraction remains the safe fallback.
      }
    }
    return this.processObservation(observation);
  }

  async processAllAsync(adapterId = null) {
    const observations = this.store.observations(adapterId);
    const results = [];
    for (const observation of observations) results.push(...await this.processObservationAsync(observation));
    return results;
  }
}

module.exports = { TaskService };
