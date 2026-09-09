function questionSignature(questions) {
  return JSON.stringify(questions || []);
}

function startCodexMonitor({ listSessions, getHistory, onApproval, intervalMs = 500 }) {
  const seen = new Map();
  const check = () => {
    for (const session of listSessions()) {
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
