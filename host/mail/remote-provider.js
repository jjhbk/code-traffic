class RemoteProvider {
  constructor({ request, kind } = {}) {
    if (typeof request !== 'function' || !kind) throw new Error('A remote provider requires a request function and kind.');
    this.request = request;
    this.kind = kind;
  }

  sync(options = {}) {
    return this.request(this.kind, options);
  }
}

module.exports = { RemoteProvider };
