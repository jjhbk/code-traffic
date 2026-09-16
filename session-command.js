const CLAUDE_SAFE_TOOLS = [
  'Read', 'Glob', 'Grep',
  'Bash(git *)', 'Bash(sed -n *)', 'Bash(sed --quiet *)',
  'Bash(npm test *)', 'Bash(npm run test *)', 'Bash(node --test *)',
  'Bash(npx jest *)', 'Bash(npx vitest *)', 'Bash(pytest *)',
  'Bash(python -m unittest *)', 'Bash(cargo test *)', 'Bash(go test *)',
  'Bash(test *)',
];

function claudeSafeToolArgs() { return ['--allowed-tools', ...CLAUDE_SAFE_TOOLS]; }

function sessionArgs(agent, sessionId, reopening) {
  if (agent === 'terminal') return [];
  // Codex has one global approval policy instead of Claude's tool allowlist.
  // Signal Box owns the embedded session controls, so avoid duplicate CLI
  // approval prompts in the PTY.
  const codexInputOptions = ['-a', 'never', '-c', 'disable_paste_burst=true'];
  const claudeOptions = claudeSafeToolArgs();
  const resumableId = sessionId && !(agent === 'codex' && sessionId.startsWith('codex:')) ? sessionId : null;
  if (resumableId) return agent === 'codex' ? ['resume', ...codexInputOptions, resumableId] : [...claudeOptions, '--resume', resumableId];
  if (!reopening) return agent === 'codex' ? codexInputOptions : claudeOptions;
  return agent === 'codex' ? ['resume', ...codexInputOptions, '--last'] : [...claudeOptions, '--continue'];
}

module.exports = { CLAUDE_SAFE_TOOLS, claudeSafeToolArgs, sessionArgs };
