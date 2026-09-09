function sessionArgs(agent, sessionId, reopening) {
  if (agent === 'terminal') return [];
  const codexInputOptions = ['-c', 'disable_paste_burst=true'];
  const resumableId = sessionId && !(agent === 'codex' && sessionId.startsWith('codex:')) ? sessionId : null;
  if (resumableId) return agent === 'codex' ? ['resume', ...codexInputOptions, resumableId] : ['--resume', resumableId];
  if (!reopening) return agent === 'codex' ? codexInputOptions : [];
  return agent === 'codex' ? ['resume', ...codexInputOptions, '--last'] : ['--continue'];
}

module.exports = { sessionArgs };
