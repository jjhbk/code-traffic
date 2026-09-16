const { candidateFilters } = require('../mail/normalize');
const { candidateFromObservation } = require('./extract');

function evaluateFixtures(fixtures, { extractorVersion = 'local-1' } = {}) {
  const results = fixtures.map((fixture) => {
    const filters = candidateFilters(fixture.observation, { existingTaskThreadIds: new Set() });
    const candidate = candidateFromObservation(fixture.observation, { filters, extractorVersion });
    const predicted = Boolean(candidate);
    return { id: fixture.id, expected: Boolean(fixture.expected), predicted, correct: predicted === Boolean(fixture.expected) };
  });
  const positives = results.filter((result) => result.predicted);
  const expectedPositives = results.filter((result) => result.expected);
  const truePositives = results.filter((result) => result.predicted && result.expected).length;
  return {
    total: results.length,
    correct: results.filter((result) => result.correct).length,
    precision: positives.length ? truePositives / positives.length : 1,
    recall: expectedPositives.length ? truePositives / expectedPositives.length : 1,
    results,
  };
}

module.exports = { evaluateFixtures };
