const { digest, validateRecipe } = require('../browser/recipes');

class ActionRegistry {
  constructor({ recipes = [] } = {}) {
    this.browserRecipes = new Map();
    recipes.forEach((recipe) => this.registerBrowserRecipe(recipe));
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
    if (!action.recipeId || action.capability !== `browser.${action.effects || ''}`) throw new Error('A browser action must identify its capability and recipe.');
    const recipe = this.browserRecipe(action.recipeId, action.recipeDigest || null);
    if (`browser.${recipe.effects}` !== action.capability) throw new Error('Browser action capability does not match the registered recipe.');
    return recipe;
  }

  list() {
    return [...this.browserRecipes.values()].map((recipe) => ({ id: recipe.id, digest: recipe.digest || digest({ ...recipe, digest: undefined }), effects: recipe.effects, origin: recipe.origin }));
  }
}

module.exports = { ActionRegistry };
