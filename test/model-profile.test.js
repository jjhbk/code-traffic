const assert = require('node:assert/strict');
const { recommendLocalModel } = require('../host/models/profile');

assert.equal(recommendLocalModel({ totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 3 * 1024 ** 3 }).model, 'qwen3:1.7b');
assert.equal(recommendLocalModel({ totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3 }).model, 'qwen3:4b-instruct');
assert.equal(recommendLocalModel({ totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 20 * 1024 ** 3 }).model, 'qwen3:8b');
assert.equal(recommendLocalModel({ totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 3 * 1024 ** 3, gpuMemoryBytes: 8 * 1024 ** 3 }).model, 'qwen3:4b-instruct');
console.log('model profile tests passed');
