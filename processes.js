const fs = require('fs');
const { execFileSync } = require('child_process');

function runningAgents() {
  if (process.platform !== 'linux') return [];
  let rows;
  try {
    rows = execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8' });
  } catch (_) {
    return [];
  }

  const currentPid = String(process.pid);
  return rows.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(claude|codex)$/i);
    if (!match || match[1] === currentPid) return [];
    try {
      const cwd = fs.readlinkSync(`/proc/${match[1]}/cwd`);
      return cwd ? [{ pid: match[1], agent: match[2].toLowerCase(), cwd }] : [];
    } catch (_) {
      return [];
    }
  });
}

module.exports = { runningAgents };
