const crypto = require('crypto');

const EFFECTS = new Set(['read', 'reversible', 'commit']);

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateRecipe(recipe = {}) {
  if (!recipe.id || !recipe.origin || !EFFECTS.has(recipe.effects) || !Array.isArray(recipe.steps) || !recipe.steps.length) throw new Error('Browser recipes require an id, origin, effects class, and steps.');
  for (const step of recipe.steps) {
    if (!step.id || !['navigate', 'fill', 'select', 'read', 'click', 'assert'].includes(step.kind)) throw new Error('Browser recipe contains an invalid step.');
    if (step.kind === 'click' && step.commit === true && recipe.effects !== 'commit') throw new Error('A committing step requires a commit recipe.');
  }
  return { ...recipe, version: recipe.version || 1, digest: digest({ ...recipe, digest: undefined }) };
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
