const crypto = require('crypto');

const EFFECTS = new Set(['read', 'reversible', 'commit']);

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateRecipe(recipe = {}) {
  if (!recipe.id || !recipe.origin || !EFFECTS.has(recipe.effects) || !Array.isArray(recipe.steps) || !recipe.steps.length) throw new Error('Browser recipes require an id, origin, effects class, and steps.');
  let origin;
  try { origin = new URL(recipe.origin).origin; }
  catch (_) { throw new Error('Browser recipes require a valid origin URL.'); }
  if (!['http:', 'https:'].includes(new URL(recipe.origin).protocol)) throw new Error('Browser recipes require an HTTP or HTTPS origin.');
  const allowedOrigins = recipe.allowedOrigins === undefined ? [origin] : recipe.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new Error('Browser recipes require at least one allowed origin.');
  const normalizedOrigins = allowedOrigins.map((value) => {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid');
      return parsed.origin;
    } catch (_) { throw new Error('Browser recipe allowed origins must be absolute HTTP or HTTPS origins.'); }
  });
  if (!normalizedOrigins.includes(origin)) throw new Error('A browser recipe origin must be included in its allowed origins.');
  const originSet = new Set(normalizedOrigins);
  let commitCount = 0;
  for (const step of recipe.steps) {
    if (!step.id || !['navigate', 'fill', 'select', 'read', 'click', 'assert'].includes(step.kind)) throw new Error('Browser recipe contains an invalid step.');
    if (step.kind === 'click' && step.commit === true && recipe.effects !== 'commit') throw new Error('A committing step requires a commit recipe.');
    if (step.commit === true) commitCount += 1;
    if (step.kind === 'navigate') {
      let stepOrigin;
      try { stepOrigin = new URL(step.url, origin).origin; } catch (_) { throw new Error('Browser recipe navigation URLs must be valid.'); }
      if (!originSet.has(stepOrigin)) throw new Error('Browser recipe navigation is outside its allowed origins.');
    }
  }
  if (commitCount > 1) throw new Error('Browser recipes may contain only one committing step.');
  return { ...recipe, origin, allowedOrigins: normalizedOrigins, version: recipe.version || 1, digest: digest({ ...recipe, origin, allowedOrigins: normalizedOrigins, digest: undefined }) };
}

const uberCabBooking = validateRecipe({
  id: 'uber.book-cab.v1',
  origin: 'https://m.uber.com',
  effects: 'commit',
  inputs: { pickup: 'string', destination: 'string', rideType: 'string', maxFare: 'number' },
  steps: [
    { id: 'open', kind: 'navigate', url: 'https://m.uber.com/looking' },
    { id: 'pickup', kind: 'fill', target: 'pickup', value: '$pickup' },
    { id: 'destination', kind: 'fill', target: 'destination', value: '$destination' },
    { id: 'ride', kind: 'select', target: 'rideType', value: '$rideType' },
    { id: 'quote', kind: 'read', target: 'fare', output: 'fare' },
    { id: 'fare-check', kind: 'assert', expression: 'fare <= maxFare' },
    { id: 'request', kind: 'click', target: 'requestRide', commit: true },
    { id: 'confirmation', kind: 'read', target: 'bookingConfirmation', output: 'bookingConfirmation' },
    { id: 'booking-confirmed', kind: 'assert', expression: 'present bookingConfirmation' },
  ],
});

const uberCabQuote = validateRecipe({
  id: 'uber.quote-cab.v1',
  origin: 'https://m.uber.com',
  effects: 'read',
  inputs: { pickup: 'string', destination: 'string', rideType: 'string', maxFare: 'number' },
  steps: [
    { id: 'open', kind: 'navigate', url: 'https://m.uber.com/looking' },
    { id: 'pickup', kind: 'fill', target: 'pickup', value: '$pickup' },
    { id: 'destination', kind: 'fill', target: 'destination', value: '$destination' },
    { id: 'ride', kind: 'select', target: 'rideType', value: '$rideType' },
    { id: 'quote', kind: 'read', target: 'fare', output: 'fare' },
    { id: 'fare-check', kind: 'assert', expression: 'fare <= maxFare' },
  ],
});

module.exports = { EFFECTS, digest, validateRecipe, uberCabBooking, uberCabQuote };
