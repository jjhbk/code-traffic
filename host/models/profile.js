const os = require('os');
const { execFileSync } = require('child_process');

function detectGpuProfile({ exec = execFileSync, platform = process.platform, wsl = Boolean(process.env.WSL_DISTRO_NAME) } = {}) {
  if (platform === 'darwin') return detectMacGpuProfile({ exec });
 const commands = platform === 'linux' && wsl ? ['/usr/lib/wsl/lib/nvidia-smi', 'nvidia-smi'] : ['nvidia-smi'];
  let lastError = null;
  for (const command of commands) {
  try {
    const output = exec(command, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 1500 });
    const rows = String(output).trim().split(/\r?\n/).filter(Boolean);
    const devices = rows.map((row) => {
      const match = row.match(/^(.+?),\s*([\d.]+)\s*$/);
      return match ? { name: match[1].trim(), memoryBytes: Number(match[2]) * 1024 ** 2 } : null;
    }).filter(Boolean);
    if (devices.length) return { available: true, vendor: 'nvidia', devices, memoryBytes: Math.max(...devices.map((device) => device.memoryBytes)), reason: null, command };
    lastError = Object.assign(new Error('GPU query returned no devices.'), { code: 'EMPTY' });
  } catch (error) {
    lastError = error;
  }
  }
  return { available: false, vendor: 'nvidia', devices: [], memoryBytes: 0, reason: lastError?.code === 'ENOENT' ? 'nvidia-smi-unavailable' : 'gpu-query-failed' };
}

function parseMacMemory(value) {
  const match = String(value || '').match(/([0-9.]+)[ ]*(GB|GiB|MB|MiB)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const multiplier = /(GB|GiB)/i.test(match[2]) ? Math.pow(1024, 3) : Math.pow(1024, 2);
  return amount * multiplier;
}

function detectMacGpuProfile({ exec = execFileSync } = {}) {
  try {
    const output = exec('system_profiler', ['SPDisplaysDataType', '-json'], { encoding: 'utf8', timeout: 3000 });
    const displays = JSON.parse(String(output)).SPDisplaysDataType || [];
    const devices = displays.map((display) => {
      const name = display._name || display.sppci_model || display.spdisplays_vendor || 'Apple GPU';
      const memoryBytes = parseMacMemory(display.spdisplays_vram || display.spdisplays_vram_dynamic || display.spdisplays_memory);
      return { name: String(name), memoryBytes, unified: /apple|m[0-9]/i.test(String(name)) };
    });
    if (devices.length) return { available: true, vendor: 'apple', devices, memoryBytes: Math.max(...devices.map((device) => device.memoryBytes)), reason: null, command: 'system_profiler' };
    return { available: false, vendor: 'apple', devices: [], memoryBytes: 0, reason: 'gpu-query-empty' };
  } catch (error) {
    return { available: false, vendor: 'apple', devices: [], memoryBytes: 0, reason: error.code === 'ENOENT' ? 'system-profiler-unavailable' : 'gpu-query-failed' };
  }
}

function recommendLocalModel({ totalMemoryBytes = os.totalmem(), availableMemoryBytes = os.freemem(), gpuMemoryBytes = 0, cpuCores = os.cpus().length, cpuModel = os.cpus()[0]?.model || 'Unknown CPU', architecture = process.arch } = {}) {
  const totalGiB = totalMemoryBytes / (1024 ** 3);
  const availableGiB = availableMemoryBytes / (1024 ** 3);
  const cores = Math.max(1, Number(cpuCores) || 1);
  const cpuLabel = String(cpuModel || architecture || 'CPU').trim();
  if (gpuMemoryBytes >= 12 * 1024 ** 3) return { model: 'qwen3:8b', tier: 'strong', reason: 'The GPU has enough memory for stronger background reasoning.' };
  if (gpuMemoryBytes >= 8 * 1024 ** 3) return { model: 'qwen3:4b-instruct', tier: 'balanced', reason: 'The GPU can run a capable model without making the desktop memory budget too tight.' };
  if (gpuMemoryBytes > 0) return { model: 'qwen3:1.7b', tier: 'efficient', reason: `The GPU reports less than 8 GiB, so Signal Box chooses a smaller model for responsive inference.` };
  if (totalGiB >= 24 && cores >= 8) return { model: 'qwen3:8b', tier: 'strong', reason: `${cpuLabel} with ${cores} CPU cores and ${totalGiB.toFixed(1)} GiB RAM can support stronger CPU inference.` };
  if (totalGiB >= 16 && cores >= 4) return { model: 'qwen3:4b-instruct', tier: 'balanced', reason: `${cpuLabel} with ${cores} CPU cores and ${totalGiB.toFixed(1)} GiB RAM is suitable for balanced CPU inference.` };
  return { model: 'qwen3:1.7b', tier: 'efficient', reason: `${cpuLabel} with ${cores} CPU cores, ${totalGiB.toFixed(1)} GiB total RAM, and ${availableGiB.toFixed(1)} GiB available RAM needs an efficient model for responsive CPU inference.` };
}
module.exports = { recommendLocalModel };
module.exports.detectGpuProfile = detectGpuProfile;
