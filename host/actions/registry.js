const { digest, validateRecipe } = require('../browser/recipes');
const { CAPABILITIES } = require('../policy/engine');

class ActionRegistry {
  constructor({ recipes = [], capabilities = null } = {}) {
    this.browserRecipes = new Map();
    this.capabilities = new Map(capabilities || [...CAPABILITIES.entries()].map(([capability, definition]) => [capability, { ...definition }]));
    recipes.forEach((recipe) => this.registerBrowserRecipe(recipe));
  }

  registerCapability(capability, definition = {}) {
    const name = String(capability || '').trim();
    if (!name || !definition || typeof definition !== 'object' || !definition.effects) throw new Error('An action capability requires a name and effect class.');
    if (this.capabilities.has(name)) throw new Error(`Action capability is already registered: ${name}`);
    this.capabilities.set(name, { ...definition, capability: name });
    return this.capabilities.get(name);
  }

  capability(capability) {
    const definition = this.capabilities.get(String(capability || ''));
    if (!definition) throw new Error('This action capability is not registered for execution.');
    return definition;
  }

  validateAction(action = {}) {
    const capability = String(action.capability || '');
    const definition = this.capability(capability);
    if (capability.startsWith('browser.')) {
      this.validateBrowserAction(action);
    } else if (capability === 'gmail.send') {
      if (!/^\S+@\S+\.\S+$/.test(String(action.destination || '')) || !action.threadId || typeof action.threadId !== 'string'
        || typeof action.content?.subject !== 'string' || !action.content.subject.trim()
        || typeof action.content?.body !== 'string' || !action.content.body.trim()
        || Object.keys(action.content || {}).some((field) => !['subject', 'body'].includes(field))) {
        throw new Error('A Gmail send action requires a valid destination, subject, body, and thread.');
      }
      for (const field of ['inReplyTo', 'references']) if (action[field] != null && typeof action[field] !== 'string') throw new Error(`A Gmail ${field} must be text.`);
    } else if (capability === 'calendar.update') {
      const allowedFields = new Set(['summary', 'description', 'location', 'start', 'end']);
      if (!action.eventId || typeof action.eventId !== 'string' || !action.changes || typeof action.changes !== 'object' || Array.isArray(action.changes) || !Object.keys(action.changes).length
        || Object.keys(action.changes).some((field) => !allowedFields.has(field))) throw new Error('A Calendar update action requires an event and supported changes.');
      if (action.etag != null && typeof action.etag !== 'string') throw new Error('A Calendar event etag must be text.');
    }
    if (action.effects && action.effects !== definition.effects) throw new Error('Action effect class does not match its registered capability.');
    return definition;
  }

  registerBrowserRecipe(recipe) {
    const checked = validateRecipe(recipe);
    if (this.browserRecipes.has(checked.id)) throw new Error(`Browser recipe is already registered: ${checked.id}`);
    this.browserRecipes.set(checked.id, checked);
    return checked;
  }

  browserRecipe(recipeId, expectedDigest = null) {
    const recipe = this.browserRecipes.get(String(recipeId || ''));
    if (!recipe) throw new Error('This browser recipe is not registered for automatic execution.');
    if (expectedDigest && expectedDigest !== recipe.digest) throw new Error('The browser recipe changed after the plan was created.');
    return recipe;
  }

  validateBrowserAction(action = {}) {
    if (!action.recipeId) throw new Error('A browser action must identify its capability and recipe.');
    const recipe = this.browserRecipe(action.recipeId, action.recipeDigest || null);
    if (`browser.${recipe.effects}` !== action.capability) throw new Error('Browser action capability does not match the registered recipe.');
    return recipe;
  }

  list() {
    return [...this.browserRecipes.values()].map((recipe) => ({ id: recipe.id, digest: recipe.digest || digest({ ...recipe, digest: undefined }), effects: recipe.effects, origin: recipe.origin }));
  }
}

module.exports = { ActionRegistry };
