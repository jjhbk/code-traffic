const DEFAULTS = Object.freeze({
  softLimitMs: 2 * 60 * 1000,
  hardLimitMs: 10 * 60 * 1000,
});

function livenessFor(session, now = Date.now(), limits = DEFAULTS) {
  if (!session || !['working', 'approval'].includes(session.state)) {
    return { status: 'inactive', level: null, ageMs: 0 };
  }
  const observedAt = Number(session.lastObservedAt || session.since || now);
  const ageMs = Math.max(0, now - observedAt);
  if (ageMs >= limits.hardLimitMs) return { status: 'unknown', level: 'hard', ageMs };
  if (ageMs >= limits.softLimitMs) return { status: 'stale', level: 'soft', ageMs };
  return { status: 'healthy', level: null, ageMs };
}

module.exports = { DEFAULTS, livenessFor };
