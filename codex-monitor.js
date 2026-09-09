function questionSignature(questions) {
  return JSON.stringify(questions || []);
}

function startCodexMonitor({ listSessions, getHistory, onApproval, onQuestionsCleared, intervalMs = 500 }) {
  const seen = new Map();
  const check = () => {
    const sessions = listSessions();
    const live = new Set(sessions.map((session) => session.tile || session.key));
    for (const tile of seen.keys()) if (!live.has(tile)) seen.delete(tile);
    for (const session of sessions) {
      if (session.agent !== 'codex') continue;
      let questions = [];
      try { questions = getHistory(session)?.pendingQuestions || []; } catch (_) { continue; }
      const tile = session.tile || session.key;
      const signature = questionSignature(questions);
      if (questions.length) {
        if (seen.get(tile) !== signature) {
          seen.set(tile, signature);
          onApproval(session);
        }
      } else {
        if (seen.has(tile)) onQuestionsCleared?.(session);
        seen.delete(tile);
      }
    }
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { questionSignature, startCodexMonitor };

function terminalApprovalQuestion(output) {
  const text = String(output || '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
  const confirmation = /press enter to confirm or esc to cancel/i.exec(text);
  if (!confirmation || text.length - (confirmation.index + confirmation[0].length) > 2000
    || !/would you like to run the following command\?/i.test(text.slice(Math.max(0, confirmation.index - 1200), confirmation.index))) return null;
  const command = [...text.matchAll(/\$\s+(.+)\s*$/gm)].at(-1)?.[1]?.trim();
  return {
    header: 'Permission required',
    question: command ? `Codex wants permission to run:\n${command}` : 'Codex is waiting for permission to continue.',
    options: [
      { label: 'Allow', description: 'Run this command once.', keys: 'y\r' },
      { label: 'Always allow', description: 'Allow this command pattern.', keys: 'p\r' },
      { label: 'Deny', description: 'Cancel this command.', keys: '\x1b' },
    ],
  };
}

module.exports.terminalApprovalQuestion = terminalApprovalQuestion;
