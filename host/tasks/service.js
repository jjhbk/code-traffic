const { candidateFilters } = require('../mail/normalize');
const { candidateFromObservation } = require('./extract');

class TaskService {
  constructor({ store, extractorVersion = 'local-1' } = {}) {
    if (!store) throw new Error('Task service requires a store.');
    this.store = store;
    this.extractorVersion = extractorVersion;
  }

  processObservation(observation) {
    const filters = candidateFilters(observation, { existingTaskThreadIds: new Set(this.store.taskThreadIds()) });
    const candidate = candidateFromObservation(observation, { filters, extractorVersion: this.extractorVersion });
    if (!candidate) return null;
    return this.store.saveTaskCandidate(candidate);
  }

  processAll(adapterId = null) {
    return this.store.observations(adapterId).map((observation) => this.processObservation(observation)).filter(Boolean);
  }
}

module.exports = { TaskService };
