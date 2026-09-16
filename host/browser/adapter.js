const { URL } = require('url');

class BrowserAdapter {
  constructor({ page, allowedOrigins = [] } = {}) {
    if (!page) throw new Error('A browser page is required.');
    this.page = page;
    this.allowedOrigins = new Set(allowedOrigins);
  }

  assertAllowed(url) {
    const origin = new URL(url, this.page.url?.() || undefined).origin;
    if (!this.allowedOrigins.has(origin)) throw new Error(`Browser navigation is outside the recipe origin: ${origin}`);
  }

  assertCurrentOrigin() {
    const current = this.page.url?.();
    if (!current) throw new Error('Browser page URL is unavailable.');
    this.assertAllowed(current);
  }

  async perform(step) {
    if (step.kind === 'navigate') {
      this.assertAllowed(step.url);
      await this.page.goto(step.url);
      return { url: this.page.url?.() || step.url };
    }
    if (step.kind === 'fill') {
      this.assertCurrentOrigin();
      if (!step.target || typeof this.page.fill !== 'function') throw new Error(`Browser fill target is unavailable: ${step.target}`);
      await this.page.fill(`[data-signal-box-target="${step.target}"]`, String(step.value ?? ''));
      return { target: step.target };
    }
    if (step.kind === 'select') {
      this.assertCurrentOrigin();
      if (!step.target || typeof this.page.selectOption !== 'function') throw new Error(`Browser select target is unavailable: ${step.target}`);
      await this.page.selectOption(`[data-signal-box-target="${step.target}"]`, String(step.value ?? ''));
      return { target: step.target };
    }
    if (step.kind === 'read') {
      this.assertCurrentOrigin();
      if (!step.target || typeof this.page.textContent !== 'function') throw new Error(`Browser read target is unavailable: ${step.target}`);
      const value = await this.page.textContent(`[data-signal-box-target="${step.target}"]`);
      if (value === null || value === '') throw new Error(`Browser response drift: missing ${step.target}`);
      return value;
    }
    if (step.kind === 'assert') {
      if (step.expression === 'fare <= maxFare' && Number(step.inputs?.fare) > Number(step.inputs?.maxFare)) throw new Error('Browser precondition failed: fare exceeds maxFare.');
      return { asserted: step.expression };
    }
    if (step.kind === 'click') {
      this.assertCurrentOrigin();
      if (!step.target || typeof this.page.click !== 'function') throw new Error(`Browser click target is unavailable: ${step.target}`);
      await this.page.click(`[data-signal-box-target="${step.target}"]`);
      return { target: step.target };
    }
    throw new Error(`Unsupported browser step: ${step.kind}`);
  }
}

module.exports = { BrowserAdapter };
