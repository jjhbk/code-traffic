const assert = require('node:assert/strict');
const { recommendLocalModel, detectGpuProfile } = require('../host/models/profile');

assert.equal(recommendLocalModel({ totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 3 * 1024 ** 3 }).model, 'qwen3:1.7b');
assert.equal(recommendLocalModel({ totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, gpuMemoryBytes: 0, cpuCores: 4, cpuModel: 'Test CPU' }).model, 'qwen3:4b-instruct');
assert.equal(recommendLocalModel({ totalMemoryBytes: 24 * 1024 ** 3, availableMemoryBytes: 12 * 1024 ** 3, gpuMemoryBytes: 0, cpuCores: 8, cpuModel: 'Test CPU' }).model, 'qwen3:8b');
assert.equal(recommendLocalModel({ totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, cpuCores: 4, cpuModel: 'Test CPU' }).model, 'qwen3:4b-instruct');
assert.equal(recommendLocalModel({ totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 20 * 1024 ** 3, cpuCores: 8, cpuModel: 'Test CPU' }).model, 'qwen3:8b');
assert.equal(recommendLocalModel({ totalMemoryBytes: 8 * 1024 ** 3, availableMemoryBytes: 3 * 1024 ** 3, gpuMemoryBytes: 8 * 1024 ** 3 }).model, 'qwen3:4b-instruct');
assert.equal(detectGpuProfile({ exec: () => 'NVIDIA RTX Test, 12288\n' }).memoryBytes, 12288 * 1024 ** 2);
const macProfile = detectGpuProfile({ platform: 'darwin', exec: () => JSON.stringify({ SPDisplaysDataType: [{ _name: 'Apple M3 Pro', spdisplays_vram: '18 GB' }] }) });
assert.equal(macProfile.available, true);
assert.equal(macProfile.vendor, 'apple');
assert.equal(macProfile.devices[0].unified, true);
assert.equal(macProfile.memoryBytes, 18 * 1024 ** 3);
assert.equal(detectGpuProfile({ exec: () => { throw new Error('NVML unavailable'); } }).reason, 'gpu-query-failed');
console.log('model profile tests passed');
