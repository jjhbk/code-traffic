function sessionArgs(agent, sessionId, reopening) {
  const resumableId = sessionId && !(agent === 'codex' && sessionId.startsWith('codex:')) ? sessionId : null;
  if (resumableId) return agent === 'codex' ? ['resume', resumableId] : ['--resume', resumableId];
  if (!reopening) return [];
  return agent === 'codex' ? ['resume', '--last'] : ['--continue'];
}

module.exports = { sessionArgs };
