const os = require('os');

function recommendLocalModel({ totalMemoryBytes = os.totalmem(), availableMemoryBytes = os.freemem(), gpuMemoryBytes = 0 } = {}) {
  const totalGiB = totalMemoryBytes / (1024 ** 3);
  const availableGiB = availableMemoryBytes / (1024 ** 3);
  if (gpuMemoryBytes >= 12 * 1024 ** 3 || totalGiB >= 24) return { model: 'qwen3:8b', tier: 'strong', reason: 'The machine has enough memory for stronger background reasoning.' };
  if (gpuMemoryBytes >= 8 * 1024 ** 3 || totalGiB >= 16) return { model: 'qwen3:4b-instruct', tier: 'balanced', reason: 'The machine can run a capable model without making the desktop memory budget too tight.' };
  return { model: 'qwen3:1.7b', tier: 'efficient', reason: `The machine reports ${totalGiB.toFixed(1)} GiB total and ${availableGiB.toFixed(1)} GiB available, so a smaller model protects responsiveness.` };
}

module.exports = { recommendLocalModel };
