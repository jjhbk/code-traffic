const { candidateFilters } = require('../mail/normalize');
const { candidatesFromObservation } = require('./extract');

class TaskService {
  constructor({ store, extractorVersion = 'local-1' } = {}) {
    if (!store) throw new Error('Task service requires a store.');
    this.store = store;
    this.extractorVersion = extractorVersion;
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
}

module.exports = { TaskService };
