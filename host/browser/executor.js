const { digest, validateRecipe } = require('./recipes');

function valueFor(name, inputs, context) {
  if (Object.prototype.hasOwnProperty.call(context, name)) return context[name];
  if (Object.prototype.hasOwnProperty.call(inputs, name)) return inputs[name];
  throw new Error(`Browser assertion references unknown value: ${name}.`);
}

function assertExpression(expression, inputs, context) {
  const present = /^present\s+([A-Za-z][\w]*)$/.exec(String(expression || '').trim());
  if (present) {
    const value = valueFor(present[1], inputs, context);
    if (value === undefined || value === null || String(value).trim() === '') throw new Error(`Browser assertion failed: ${present[1]} is not present.`);
    return;
  }
  const match = /^([A-Za-z][\w]*)\s*(<=|>=|===|==|<|>)\s*([A-Za-z][\w]*|-?\d+(?:\.\d+)?)$/.exec(String(expression || '').trim());
  if (!match) throw new Error('Browser assertion is not supported.');
  const left = valueFor(match[1], inputs, context);
  const right = /^[A-Za-z]/.test(match[3]) ? valueFor(match[3], inputs, context) : Number(match[3]);
  const bothNumbers = typeof left === 'number' && typeof right === 'number';
  const a = bothNumbers ? left : String(left);
  const b = bothNumbers ? right : String(right);
  const passed = {
    '<=': a <= b, '>=': a >= b, '<': a < b, '>': a > b,
    '==': a == b, // eslint-disable-line eqeqeq
    '===': a === b,
  }[match[2]];
  if (!passed) throw new Error(`Browser assertion failed: ${match[1]} ${match[2]} ${match[3]}.`);
}

class BrowserRecipeExecutor {
  constructor({ browser, policy, clock = () => Date.now() } = {}) {
    if (!browser) throw new Error('Browser recipe executor requires a browser adapter.');
    this.browser = browser;
    this.policy = policy;
    this.clock = clock;
  }

  async run(recipe, inputs = {}, { approve = null } = {}) {
    const checked = validateRecipe(recipe);
    for (const [name, type] of Object.entries(checked.inputs || {})) {
      if (typeof inputs[name] !== type) throw new Error(`Missing or invalid browser input: ${name}.`);
    }
    const action = { capability: `browser.${checked.effects}`, recipeId: checked.id, recipeDigest: checked.digest, origin: checked.origin, inputs: { ...inputs }, effects: checked.effects, autonomous: false };
    const receipt = { actionDigest: digest(action), recipeId: checked.id, status: 'prepared', steps: [], startedAt: this.clock() };
    const context = {};
    for (const step of checked.steps) {
      const value = typeof step.value === 'string' && step.value.startsWith('$') ? inputs[step.value.slice(1)] : step.value;
      if (step.commit === true) {
        if (this.policy) this.policy.evaluate(action, { surfaces: ['desktop'] });
        if (typeof approve !== 'function' || !(await approve(action))) { receipt.status = 'awaiting-approval'; receipt.finishedAt = this.clock(); return receipt; }
        receipt.status = 'authorized';
      }
      if (step.kind === 'assert') {
        assertExpression(step.expression, inputs, context);
        receipt.steps.push({ id: step.id, status: 'completed' });
        continue;
      }
      const result = await this.browser.perform({ ...step, value, inputs: { ...inputs, ...context } });
      if (step.kind === 'read') context[step.output || step.target] = Number(String(result).replace(/[^0-9.]/g, '')) || result;
      receipt.steps.push({ id: step.id, status: 'completed', result: step.kind === 'read' ? result : undefined });
    }
    receipt.outputs = { ...context };
    receipt.status = 'confirmed'; receipt.finishedAt = this.clock();
    return receipt;
  }
}

module.exports = { BrowserRecipeExecutor };
