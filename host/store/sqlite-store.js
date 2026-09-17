const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadSqlite() {
  try { return require('node:sqlite'); }
  catch (error) { throw new Error(`SQLite requires a runtime with node:sqlite support: ${error.message}`); }
}

function matchesGrantConstraints(action, constraints = {}) {
  for (const key of ['recipeId', 'origin', 'destination', 'recipient']) {
    if (constraints[key] !== undefined && String(action[key] || '') !== String(constraints[key])) return false;
  }
  for (const key of ['allowedOrigins', 'allowedRecipients', 'allowedRecipeIds']) {
    if (constraints[key] !== undefined && (!Array.isArray(constraints[key]) || !constraints[key].includes(action[key]))) return false;
  }
  if (constraints.maxAmount !== undefined) {
    const amount = Number(action.amount ?? action.cost ?? action.inputs?.amount);
    if (!Number.isFinite(amount) || amount > Number(constraints.maxAmount)) return false;
  }
  if (constraints.inputs && typeof constraints.inputs === 'object') {
    for (const [key, value] of Object.entries(constraints.inputs)) if (action.inputs?.[key] !== value) return false;
  }
  return true;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS adapters (
    adapter_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    producer_epoch TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    adapter_id TEXT NOT NULL,
    producer_epoch TEXT,
    sequence INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    accepted_at INTEGER NOT NULL,
    UNIQUE(adapter_id, producer_epoch, sequence)
  );
  CREATE TABLE IF NOT EXISTS approval_requests (
    request_id TEXT PRIMARY KEY,
    action_json TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    principal TEXT NOT NULL,
    surfaces_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS approval_options (
    request_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    option_json TEXT NOT NULL,
    PRIMARY KEY(request_id, option_id),
    FOREIGN KEY(request_id) REFERENCES approval_requests(request_id)
  );
  CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    option_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    surface TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    FOREIGN KEY(request_id) REFERENCES approval_requests(request_id)
  );
  CREATE TABLE IF NOT EXISTS audit_entries (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    request_id TEXT,
    action_digest TEXT,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY,
    owned INTEGER NOT NULL,
    tile TEXT,
    session_json TEXT NOT NULL,
    imported_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS store_imports (
    source TEXT PRIMARY KEY,
    imported_at INTEGER NOT NULL,
    record_count INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS execution_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(request_id) REFERENCES approval_requests(request_id)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    receipt_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(attempt_id) REFERENCES execution_attempts(attempt_id)
  );`,
  `CREATE TABLE IF NOT EXISTS connector_cursors (
    adapter_id TEXT PRIMARY KEY,
    cursor TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS observations (
    observation_id TEXT PRIMARY KEY,
    adapter_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    UNIQUE(adapter_id, message_id, observation_id)
  );`,
  `CREATE TABLE IF NOT EXISTS connector_health (
    adapter_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    details_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE,
    task_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_evidence (
    task_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    evidence_text TEXT NOT NULL,
    PRIMARY KEY(task_id, observation_id, start_offset, end_offset),
    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
  );
  CREATE TABLE IF NOT EXISTS task_history (
    history_id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
  );`,
  `CREATE TABLE IF NOT EXISTS notification_ledger (
    date_key TEXT NOT NULL,
    notification_class TEXT NOT NULL,
    reserved_count INTEGER NOT NULL,
    cap INTEGER NOT NULL,
    PRIMARY KEY(date_key, notification_class)
  );
  CREATE TABLE IF NOT EXISTS notification_outbox (
    notification_id TEXT PRIMARY KEY,
    date_key TEXT NOT NULL,
    notification_class TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  `ALTER TABLE notification_outbox ADD COLUMN claimed_at INTEGER;`,
  `CREATE TABLE IF NOT EXISTS suppressions (
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    until_at INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_type, scope_key)
  );`,
  `CREATE TABLE IF NOT EXISTS notification_feedback (
    notification_id TEXT PRIMARY KEY,
    useful INTEGER NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    lease_token TEXT,
    lease_until INTEGER,
    dedupe_key TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe
    ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');`,
  `CREATE TABLE IF NOT EXISTS task_relations (
    from_task_id TEXT NOT NULL,
    to_task_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(from_task_id, to_task_id, relation_type),
    FOREIGN KEY(from_task_id) REFERENCES tasks(task_id),
    FOREIGN KEY(to_task_id) REFERENCES tasks(task_id)
  );`,
  `CREATE TABLE IF NOT EXISTS task_corrections (
    task_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    value_json TEXT NOT NULL,
    corrected_at INTEGER NOT NULL,
    PRIMARY KEY(task_id, field_name),
    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
  );`,
  `ALTER TABLE tasks ADD COLUMN obligation_key TEXT;
   CREATE INDEX IF NOT EXISTS tasks_obligation_key ON tasks(obligation_key);`,
  `CREATE TABLE IF NOT EXISTS context_records (
    record_id TEXT PRIMARY KEY,
    record_type TEXT NOT NULL,
    record_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    source_json TEXT NOT NULL,
    confidence TEXT NOT NULL,
    confirmed INTEGER NOT NULL,
    valid_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(record_type, record_key)
  );`,
  `CREATE TABLE IF NOT EXISTS workflows (
    workflow_id TEXT PRIMARY KEY,
    workflow_type TEXT NOT NULL,
    version INTEGER NOT NULL,
    task_id TEXT,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    wake_at INTEGER,
    input_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(task_id)
  );
  CREATE TABLE IF NOT EXISTS workflow_steps (
    workflow_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    state TEXT NOT NULL,
    details_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(workflow_id, step_id),
    FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id)
  );`,
  `CREATE TABLE IF NOT EXISTS conversations (
    conversation_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    channel TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    external_id TEXT,
    direction TEXT NOT NULL,
    content TEXT NOT NULL,
    task_id TEXT,
    workflow_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id),
    FOREIGN KEY(task_id) REFERENCES tasks(task_id),
    FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id),
    UNIQUE(conversation_id, external_id)
  );`,
  `CREATE TABLE IF NOT EXISTS standing_grants (
    grant_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    capability TEXT NOT NULL,
    surface TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER,
    used_count INTEGER NOT NULL,
    cooldown_ms INTEGER NOT NULL,
    last_used_at INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS autonomous_runs (
    run_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    action_json TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    status TEXT NOT NULL,
    details_json TEXT NOT NULL,
    receipt_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
];

class SqliteStore {
  constructor({ filename = ':memory:', clock = () => Date.now() } = {}) {
    const { DatabaseSync } = loadSqlite();
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.clock = clock;
    this.db.exec('PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);');
    this.migrate();
  }

  migrate() {
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get();
    for (let version = Number(row.version) + 1; version <= MIGRATIONS.length; version += 1) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version - 1]);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, this.clock());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close() { this.db.close(); }

  enqueueJob({ jobId = crypto.randomUUID(), kind, payload = {}, runAt = this.clock(), maxAttempts = 5, dedupeKey = null } = {}) {
    if (!kind || !payload || typeof payload !== 'object' || !Number.isFinite(runAt) || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('Invalid job.');
    }
    const existing = dedupeKey
      ? this.db.prepare("SELECT job_id AS jobId, kind, status, run_at AS runAt, attempts FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')").get(dedupeKey)
      : null;
    if (existing) return { ...existing, deduplicated: true };
    const now = this.clock();
    this.db.prepare(`INSERT INTO jobs(job_id, kind, payload_json, status, run_at, attempts, max_attempts, lease_token, lease_until, dedupe_key, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, 0, ?, NULL, NULL, ?, NULL, ?, ?)`)
      .run(jobId, String(kind), JSON.stringify(payload), runAt, maxAttempts, dedupeKey, now, now);
    this.audit('job-enqueued', null, null, { jobId, kind, runAt, dedupeKey });
    return { jobId, kind: String(kind), status: 'queued', runAt, attempts: 0, deduplicated: false };
  }

  claimJobs({ limit = 10, leaseMs = 60_000, workerId = crypto.randomUUID(), now = this.clock(), kinds = null } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Job lease must be positive.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const kindFilter = Array.isArray(kinds) && kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
      const rows = this.db.prepare(`SELECT job_id AS jobId FROM jobs
        WHERE ((status = 'queued' AND run_at <= ?) OR (status = 'running' AND lease_until < ?))${kindFilter}
        ORDER BY run_at, created_at LIMIT ?`).all(now, now, ...(Array.isArray(kinds) && kinds.length ? kinds : []), safeLimit);
      const claimed = [];
      const update = this.db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ?, updated_at = ?
        WHERE job_id = ? AND (status = 'queued' OR (status = 'running' AND lease_until < ?))`);
      for (const row of rows) {
        const token = `${workerId}:${crypto.randomUUID()}`;
        const result = update.run(token, now + leaseMs, now, row.jobId, now);
        if (Number(result.changes) !== 1) continue;
        const job = this.db.prepare('SELECT job_id AS jobId, kind, payload_json AS payloadJson, status, run_at AS runAt, attempts, max_attempts AS maxAttempts, lease_token AS leaseToken, lease_until AS leaseUntil, dedupe_key AS dedupeKey FROM jobs WHERE job_id = ?').get(row.jobId);
        claimed.push({ ...job, payload: JSON.parse(job.payloadJson) });
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  renewJob(jobId, leaseToken, leaseMs = 60_000, now = this.clock()) {
    if (!jobId || !leaseToken || !Number.isFinite(leaseMs) || leaseMs <= 0 || !Number.isFinite(now)) throw new Error('Invalid job lease renewal.');
    const result = this.db.prepare(`UPDATE jobs SET lease_until = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running' AND lease_token = ? AND lease_until >= ?`)
      .run(now + leaseMs, now, jobId, leaseToken, now);
    if (Number(result.changes) !== 1) throw new Error('Job lease is missing or expired.');
    this.audit('job-lease-renewed', null, null, { jobId, leaseUntil: now + leaseMs });
    return true;
  }

  completeJob(jobId, leaseToken, { status = 'completed', runAt = null, error = null } = {}) {
    if (!['completed', 'queued', 'failed'].includes(status)) throw new Error('Invalid job completion status.');
    const now = this.clock();
    const result = this.db.prepare(`UPDATE jobs SET status = ?, run_at = COALESCE(?, run_at), lease_token = NULL, lease_until = NULL,
      last_error = ?, updated_at = ? WHERE job_id = ? AND status = 'running' AND lease_token = ?`).run(status, runAt, error, now, jobId, leaseToken);
    if (Number(result.changes) !== 1) throw new Error('Job lease is missing or expired.');
    this.audit(`job-${status}`, null, null, { jobId, error: error || null });
    return this.getJob(jobId);
  }

  getJob(jobId) {
    const row = this.db.prepare('SELECT job_id AS jobId, kind, payload_json AS payloadJson, status, run_at AS runAt, attempts, max_attempts AS maxAttempts, lease_token AS leaseToken, lease_until AS leaseUntil, dedupe_key AS dedupeKey, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE job_id = ?').get(jobId);
    return row ? { ...row, payload: JSON.parse(row.payloadJson) } : null;
  }

  ingestEvent({ eventId, adapterId, producerEpoch = null, sequence = null, type, payload }) {
    if (!eventId || !adapterId || !type || !payload || typeof payload !== 'object') throw new Error('Invalid event.');
    const existing = this.db.prepare('SELECT event_id AS eventId, accepted_at AS acceptedAt FROM events WHERE event_id = ?').get(eventId);
    if (existing) return { accepted: false, duplicate: true, eventId };
    if (sequence !== null && (!Number.isInteger(sequence) || sequence < 0)) throw new Error('Invalid event sequence.');
    if (sequence !== null && producerEpoch !== null) {
      const previous = this.db.prepare('SELECT sequence FROM events WHERE adapter_id = ? AND producer_epoch = ? ORDER BY sequence DESC LIMIT 1').get(adapterId, producerEpoch);
      if (previous && sequence <= previous.sequence) return { accepted: false, duplicate: false, stale: true, eventId };
    }
    this.db.prepare(`INSERT INTO adapters(adapter_id, kind, producer_epoch, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(adapter_id) DO UPDATE SET producer_epoch = excluded.producer_epoch`).run(adapterId, adapterId, producerEpoch, this.clock());
    this.db.prepare(`INSERT INTO events(event_id, adapter_id, producer_epoch, sequence, event_type, payload_json, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(eventId, adapterId, producerEpoch, sequence, type, JSON.stringify(payload), this.clock());
    this.audit('event-ingested', null, null, { eventId, adapterId, type, sequence });
    return { accepted: true, duplicate: false, eventId };
  }

  createApproval({ requestId = crypto.randomUUID(), action, options, principal, surfaces = ['desktop'], expiresAt, policyVersion = '1' }) {
    if (!requestId || !action || !Array.isArray(options) || !options.length || !principal || !Number.isFinite(expiresAt)) throw new Error('Invalid approval request.');
    const actionJson = JSON.stringify(action);
    const actionDigest = crypto.createHash('sha256').update(actionJson).digest('hex');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO approval_requests(request_id, action_json, action_digest, principal, surfaces_json, expires_at, policy_version, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(requestId, actionJson, actionDigest, principal, JSON.stringify(surfaces), expiresAt, policyVersion, this.clock());
      const insert = this.db.prepare('INSERT INTO approval_options(request_id, option_id, option_json) VALUES (?, ?, ?)');
      options.forEach((option, index) => {
        const optionId = option.optionId || option.id || `option-${index + 1}`;
        insert.run(requestId, optionId, JSON.stringify({ ...option, optionId }));
      });
      this.audit('approval-requested', requestId, actionDigest, { principal, policyVersion });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getApproval(requestId);
  }

  importSessions(records, source = 'legacy-sessions-v1') {
    if (!Array.isArray(records)) throw new Error('Session records must be an array.');
    const alreadyImported = this.db.prepare('SELECT source FROM store_imports WHERE source = ?').get(source);
    if (alreadyImported) return { imported: false, count: 0 };
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(`INSERT INTO sessions(session_key, owned, tile, session_json, imported_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_key) DO NOTHING`);
      for (const record of records) {
        if (!record?.key) continue;
        insert.run(record.key, record.owned ? 1 : 0, record.tile || null, JSON.stringify(record), this.clock());
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
      this.db.prepare('INSERT INTO store_imports(source, imported_at, record_count) VALUES (?, ?, ?)').run(source, this.clock(), count);
      this.db.exec('COMMIT');
      return { imported: true, count };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  importedSessions() {
    return this.db.prepare('SELECT session_json AS sessionJson FROM sessions ORDER BY imported_at, session_key')
      .all().map((row) => JSON.parse(row.sessionJson));
  }

  recordExecutionAttempt({ attemptId = crypto.randomUUID(), requestId, status, details = {} }) {
    const allowed = new Set(['prepared', 'authorized', 'dispatched', 'confirmed', 'failed', 'unknown']);
    if (!requestId || !allowed.has(status)) throw new Error('Invalid execution attempt.');
    const request = this.db.prepare('SELECT request_id FROM approval_requests WHERE request_id = ?').get(requestId);
    if (!request) throw new Error('Approval request not found.');
    const now = this.clock();
    const existing = this.db.prepare('SELECT attempt_id FROM execution_attempts WHERE attempt_id = ?').get(attemptId);
    if (existing) {
      const current = this.db.prepare('SELECT status FROM execution_attempts WHERE attempt_id = ?').get(attemptId).status;
      const transitions = {
        prepared: new Set(['authorized', 'failed', 'unknown']),
        authorized: new Set(['dispatched', 'failed', 'unknown']),
        dispatched: new Set(['confirmed', 'failed', 'unknown']),
        unknown: new Set(['confirmed', 'failed']),
        confirmed: new Set(),
        failed: new Set(),
      };
      if (current === status) return { attemptId, requestId, status };
      if (!transitions[current]?.has(status)) throw new Error(`Invalid execution transition: ${current} to ${status}.`);
      this.db.prepare('UPDATE execution_attempts SET status = ?, details_json = ?, updated_at = ? WHERE attempt_id = ?')
        .run(status, JSON.stringify(details), now, attemptId);
    } else {
      this.db.prepare(`INSERT INTO execution_attempts(attempt_id, request_id, status, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(attemptId, requestId, status, JSON.stringify(details), now, now);
    }
    this.audit(`execution-${status}`, requestId, null, { attemptId, ...details });
    return { attemptId, requestId, status };
  }

  claimExecutionAttempt({ attemptId = crypto.randomUUID(), requestId, details = {} } = {}) {
    if (!requestId) throw new Error('Approval request is required.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const request = this.db.prepare('SELECT request_id FROM approval_requests WHERE request_id = ?').get(requestId);
      if (!request) throw new Error('Approval request not found.');
      if (this.db.prepare('SELECT attempt_id FROM execution_attempts WHERE request_id = ? LIMIT 1').get(requestId)) throw new Error('Approval has already been consumed.');
      const now = this.clock();
      this.db.prepare(`INSERT INTO execution_attempts(attempt_id, request_id, status, details_json, created_at, updated_at)
        VALUES (?, ?, 'prepared', ?, ?, ?)`).run(attemptId, requestId, JSON.stringify(details), now, now);
      this.audit('execution-prepared', requestId, null, { attemptId, ...details });
      this.db.exec('COMMIT');
      return this.getExecutionAttempt(attemptId);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* Preserve the original claim error. */ }
      throw error;
    }
  }

  getExecutionAttempt(attemptId) {
    const row = this.db.prepare('SELECT attempt_id AS attemptId, request_id AS requestId, status, details_json AS detailsJson, created_at AS createdAt, updated_at AS updatedAt FROM execution_attempts WHERE attempt_id = ?').get(attemptId);
    return row ? { ...row, details: JSON.parse(row.detailsJson) } : null;
  }

  getExecutionAttempts(requestId) {
    return this.db.prepare('SELECT attempt_id AS attemptId, request_id AS requestId, status, details_json AS detailsJson, created_at AS createdAt, updated_at AS updatedAt FROM execution_attempts WHERE request_id = ? ORDER BY created_at, attempt_id')
      .all(requestId).map((row) => ({ ...row, details: JSON.parse(row.detailsJson) }));
  }

  createStandingGrant({ grantId = crypto.randomUUID(), principal, capability, surface, constraints = {}, policyVersion = '1', expiresAt, maxUses = null, cooldownMs = 0 } = {}) {
    if (!grantId || !principal || !capability || !surface || !constraints || typeof constraints !== 'object' || Array.isArray(constraints) || !Number.isFinite(expiresAt) || (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) || !Number.isInteger(cooldownMs) || cooldownMs < 0) throw new Error('Invalid standing grant.');
    const now = this.clock();
    if (expiresAt <= now) throw new Error('Standing grant must expire in the future.');
    this.db.prepare(`INSERT INTO standing_grants(grant_id, principal, capability, surface, constraints_json, policy_version, expires_at, max_uses, used_count, cooldown_ms, last_used_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 'active', ?, ?)`)
      .run(grantId, principal, capability, surface, JSON.stringify(constraints), policyVersion, expiresAt, maxUses, cooldownMs, now, now);
    this.audit('standing-grant-created', null, null, { grantId, principal, capability, surface, expiresAt, maxUses });
    return this.getStandingGrant(grantId);
  }

  getStandingGrant(grantId) {
    const row = this.db.prepare(`SELECT grant_id AS grantId, principal, capability, surface, constraints_json AS constraintsJson, policy_version AS policyVersion, expires_at AS expiresAt, max_uses AS maxUses, used_count AS usedCount, cooldown_ms AS cooldownMs, last_used_at AS lastUsedAt, status, created_at AS createdAt, updated_at AS updatedAt FROM standing_grants WHERE grant_id = ?`).get(grantId);
    return row ? { ...row, constraints: JSON.parse(row.constraintsJson) } : null;
  }

  listStandingGrants({ principal = null, includeInactive = true } = {}) {
    const clauses = [];
    const params = [];
    if (principal) { clauses.push('principal = ?'); params.push(principal); }
    if (!includeInactive) clauses.push("status = 'active'");
    const rows = this.db.prepare(`SELECT grant_id AS grantId FROM standing_grants ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`).all(...params);
    return rows.map((row) => this.getStandingGrant(row.grantId));
  }

  revokeStandingGrant(grantId, reason = 'user-revoked') {
    const result = this.db.prepare("UPDATE standing_grants SET status = 'revoked', updated_at = ? WHERE grant_id = ? AND status = 'active'").run(this.clock(), grantId);
    if (!Number(result.changes)) throw new Error('Standing grant not found or already inactive.');
    this.audit('standing-grant-revoked', null, null, { grantId, reason });
    return this.getStandingGrant(grantId);
  }

  consumeStandingGrant(grantId, action, { principal, surface, policyVersion = null, now = this.clock() } = {}) {
    if (!grantId || !action || !principal || !surface || !Number.isFinite(now)) throw new Error('Standing grant authorization is incomplete.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const grant = this.getStandingGrant(grantId);
      if (!grant || grant.status !== 'active') throw new Error('Standing grant is not active.');
      if (grant.principal !== principal || grant.surface !== surface || grant.capability !== action.capability) throw new Error('Standing grant does not match this action.');
      if (policyVersion && grant.policyVersion !== policyVersion) throw new Error('Standing grant uses an outdated policy.');
      if (now >= grant.expiresAt) throw new Error('Standing grant has expired.');
      if (grant.maxUses !== null && grant.usedCount >= grant.maxUses) throw new Error('Standing grant usage limit reached.');
      if (grant.lastUsedAt !== null && now - grant.lastUsedAt < grant.cooldownMs) throw new Error('Standing grant cooldown is active.');
      if (!matchesGrantConstraints(action, grant.constraints)) throw new Error('Action is outside standing grant constraints.');
      this.db.prepare('UPDATE standing_grants SET used_count = used_count + 1, last_used_at = ?, updated_at = ? WHERE grant_id = ? AND status = \'active\'').run(now, now, grantId);
      this.audit('standing-grant-consumed', null, null, { grantId, capability: action.capability, surface });
      this.db.exec('COMMIT');
      return this.getStandingGrant(grantId);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }

  createAutonomousRun({ runId = crypto.randomUUID(), grantId, action, actionDigest, status = 'prepared', details = {} } = {}) {
    if (!runId || !grantId || !action || !actionDigest || !['prepared', 'authorized', 'dispatched', 'confirmed', 'failed', 'unknown'].includes(status)) throw new Error('Invalid autonomous run.');
    const now = this.clock();
    this.db.prepare(`INSERT INTO autonomous_runs(run_id, grant_id, action_json, action_digest, status, details_json, receipt_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(runId, grantId, JSON.stringify(action), actionDigest, status, JSON.stringify(details), now, now);
    this.audit(`autonomous-run-${status}`, null, actionDigest, { runId, grantId, ...details });
    return this.getAutonomousRun(runId);
  }

  updateAutonomousRun(runId, status, { details = {}, receipt = null } = {}) {
    const run = this.getAutonomousRun(runId);
    if (!run) throw new Error('Autonomous run not found.');
    const transitions = { prepared: new Set(['authorized', 'failed']), authorized: new Set(['dispatched', 'failed']), dispatched: new Set(['confirmed', 'failed', 'unknown']), unknown: new Set(['confirmed', 'failed']), confirmed: new Set(), failed: new Set() };
    if (run.status !== status && !transitions[run.status]?.has(status)) throw new Error(`Invalid autonomous run transition: ${run.status} to ${status}.`);
    this.db.prepare('UPDATE autonomous_runs SET status = ?, details_json = ?, receipt_json = COALESCE(?, receipt_json), updated_at = ? WHERE run_id = ?').run(status, JSON.stringify(details), receipt ? JSON.stringify(receipt) : null, this.clock(), runId);
    this.audit(`autonomous-run-${status}`, null, run.actionDigest, { runId, ...details });
    return this.getAutonomousRun(runId);
  }

  getAutonomousRun(runId) {
    const row = this.db.prepare('SELECT run_id AS runId, grant_id AS grantId, action_json AS actionJson, action_digest AS actionDigest, status, details_json AS detailsJson, receipt_json AS receiptJson, created_at AS createdAt, updated_at AS updatedAt FROM autonomous_runs WHERE run_id = ?').get(runId);
    return row ? { ...row, action: JSON.parse(row.actionJson), details: JSON.parse(row.detailsJson), receipt: row.receiptJson ? JSON.parse(row.receiptJson) : null } : null;
  }

  listAutonomousRuns({ grantId = null, limit = 100 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = grantId
      ? this.db.prepare('SELECT run_id AS runId FROM autonomous_runs WHERE grant_id = ? ORDER BY created_at DESC LIMIT ?').all(grantId, safeLimit)
      : this.db.prepare('SELECT run_id AS runId FROM autonomous_runs ORDER BY created_at DESC LIMIT ?').all(safeLimit);
    return rows.map((row) => this.getAutonomousRun(row.runId));
  }

  recordReceipt({ receiptId = crypto.randomUUID(), attemptId, receipt }) {
    if (!attemptId || !receipt || typeof receipt !== 'object') throw new Error('Invalid execution receipt.');
    const attempt = this.db.prepare('SELECT attempt_id FROM execution_attempts WHERE attempt_id = ?').get(attemptId);
    if (!attempt) throw new Error('Execution attempt not found.');
    this.db.prepare('INSERT INTO receipts(receipt_id, attempt_id, receipt_json, created_at) VALUES (?, ?, ?, ?)')
      .run(receiptId, attemptId, JSON.stringify(receipt), this.clock());
    this.audit('execution-receipt', null, null, { receiptId, attemptId, status: receipt.status || null });
    return { receiptId, attemptId };
  }

  getReceipt(receiptId) {
    const row = this.db.prepare('SELECT receipt_id AS receiptId, attempt_id AS attemptId, receipt_json AS receiptJson, created_at AS createdAt FROM receipts WHERE receipt_id = ?').get(receiptId);
    return row ? { ...row, receipt: JSON.parse(row.receiptJson) } : null;
  }

  getConnectorCursor(adapterId) {
    return this.db.prepare('SELECT cursor FROM connector_cursors WHERE adapter_id = ?').get(adapterId)?.cursor || null;
  }

  setConnectorCursor(adapterId, cursor) {
    this.db.prepare(`INSERT INTO connector_cursors(adapter_id, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(adapter_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`)
      .run(adapterId, cursor, this.clock());
  }

  saveObservation(observation, adapterId) {
    if (!observation?.observationId || !observation.messageId || !observation.threadId) throw new Error('Invalid mail observation.');
    const result = this.db.prepare(`INSERT INTO observations(observation_id, adapter_id, message_id, thread_id, observation_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(observation_id) DO NOTHING`)
      .run(observation.observationId, adapterId, observation.messageId, observation.threadId, JSON.stringify(observation), this.clock());
    if (Number(result.changes) === 1) this.audit('observation-saved', null, null, { observationId: observation.observationId, adapterId, messageId: observation.messageId });
    return Number(result.changes) === 1;
  }

  observations(adapterId = null) {
    const rows = adapterId
      ? this.db.prepare('SELECT observation_json AS observationJson FROM observations WHERE adapter_id = ? ORDER BY observed_at').all(adapterId)
      : this.db.prepare('SELECT observation_json AS observationJson FROM observations ORDER BY observed_at').all();
    return rows.map((row) => JSON.parse(row.observationJson));
  }

  setConnectorHealth(adapterId, status, details = {}) {
    this.db.prepare(`INSERT INTO connector_health(adapter_id, status, details_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(adapter_id) DO UPDATE SET status = excluded.status, details_json = excluded.details_json, updated_at = excluded.updated_at`)
      .run(adapterId, status, JSON.stringify(details), this.clock());
    this.audit('connector-health', null, null, { adapterId, status });
  }

  getConnectorHealth(adapterId) {
    const row = this.db.prepare('SELECT status, details_json AS detailsJson, updated_at AS updatedAt FROM connector_health WHERE adapter_id = ?').get(adapterId);
    return row ? { status: row.status, details: JSON.parse(row.detailsJson), updatedAt: row.updatedAt } : null;
  }

  taskThreadIds() {
    return this.db.prepare('SELECT DISTINCT json_extract(task_json, \'$.threadId\') AS threadId FROM tasks').all()
      .map((row) => row.threadId).filter(Boolean);
  }

  upsertContext({ recordId = crypto.randomUUID(), recordType, recordKey, value, source = {}, confidence = 'inferred', confirmed = false, validUntil = null } = {}) {
    const types = new Set(['person', 'project', 'goal', 'preference', 'fact']);
    const confidences = new Set(['inferred', 'low', 'medium', 'high']);
    if (!types.has(recordType) || !recordKey || value === undefined || !confidences.has(confidence) || typeof confirmed !== 'boolean') throw new Error('Invalid context record.');
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Context source must be an object.');
    const now = this.clock();
    this.db.prepare(`INSERT INTO context_records(record_id, record_type, record_key, value_json, source_json, confidence, confirmed, valid_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_type, record_key) DO UPDATE SET value_json = excluded.value_json, source_json = excluded.source_json,
      confidence = excluded.confidence, confirmed = excluded.confirmed, valid_until = excluded.valid_until, updated_at = excluded.updated_at`)
      .run(recordId, recordType, String(recordKey), JSON.stringify(value), JSON.stringify(source), confidence, confirmed ? 1 : 0, validUntil, now, now);
    this.audit('context-upserted', null, null, { recordType, recordKey: String(recordKey), confirmed });
    return this.getContext(recordType, recordKey);
  }

  getContext(recordType, recordKey, now = this.clock()) {
    const row = this.db.prepare(`SELECT record_id AS recordId, record_type AS recordType, record_key AS recordKey, value_json AS valueJson,
      source_json AS sourceJson, confidence, confirmed, valid_until AS validUntil, created_at AS createdAt, updated_at AS updatedAt
      FROM context_records WHERE record_type = ? AND record_key = ? AND (valid_until IS NULL OR valid_until > ?)`)
      .get(recordType, String(recordKey), now);
    return row ? this._contextRow(row) : null;
  }

  listContext({ recordType = null, includeExpired = false, now = this.clock() } = {}) {
    const clauses = [];
    const params = [];
    if (recordType) { clauses.push('record_type = ?'); params.push(recordType); }
    if (!includeExpired) { clauses.push('(valid_until IS NULL OR valid_until > ?)'); params.push(now); }
    const rows = this.db.prepare(`SELECT record_id AS recordId, record_type AS recordType, record_key AS recordKey, value_json AS valueJson,
      source_json AS sourceJson, confidence, confirmed, valid_until AS validUntil, created_at AS createdAt, updated_at AS updatedAt
      FROM context_records ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...params);
    return rows.map((row) => this._contextRow(row));
  }

  _contextRow(row) {
    return { ...row, value: JSON.parse(row.valueJson), source: JSON.parse(row.sourceJson), confirmed: Boolean(row.confirmed) };
  }

  deleteContext(recordType, recordKey) {
    const result = this.db.prepare('DELETE FROM context_records WHERE record_type = ? AND record_key = ?').run(recordType, String(recordKey));
    if (Number(result.changes)) this.audit('context-deleted', null, null, { recordType, recordKey: String(recordKey) });
    return Number(result.changes) === 1;
  }

  createWorkflow({ workflowId = crypto.randomUUID(), workflowType, version = 1, taskId = null, payload = {}, state = 'ready', inputVersion = 1, wakeAt = null } = {}) {
    const states = new Set(['ready', 'evaluating', 'awaiting_input', 'awaiting_approval', 'executing', 'waiting_event', 'verifying', 'completed', 'cancelled', 'needs_attention']);
    if (!workflowType || !states.has(state) || !payload || typeof payload !== 'object' || !Number.isInteger(version) || !Number.isInteger(inputVersion)) throw new Error('Invalid workflow.');
    if (taskId && !this.db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(taskId)) throw new Error('Workflow task not found.');
    const now = this.clock();
    this.db.prepare(`INSERT INTO workflows(workflow_id, workflow_type, version, task_id, state, payload_json, wake_at, input_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workflowId, workflowType, version, taskId, state, JSON.stringify(payload), wakeAt, inputVersion, now, now);
    this.audit('workflow-created', null, null, { workflowId, workflowType, taskId, state });
    return this.getWorkflow(workflowId);
  }

  getWorkflow(workflowId) {
    const row = this.db.prepare(`SELECT workflow_id AS workflowId, workflow_type AS workflowType, version, task_id AS taskId, state,
      payload_json AS payloadJson, wake_at AS wakeAt, input_version AS inputVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM workflows WHERE workflow_id = ?`).get(workflowId);
    if (!row) return null;
    const steps = this.db.prepare('SELECT step_id AS stepId, step_index AS stepIndex, state, details_json AS detailsJson, updated_at AS updatedAt FROM workflow_steps WHERE workflow_id = ? ORDER BY step_index').all(workflowId)
      .map((step) => ({ ...step, details: JSON.parse(step.detailsJson) }));
    return { ...row, payload: JSON.parse(row.payloadJson), steps };
  }

  listWorkflows({ taskId = null, activeOnly = false } = {}) {
    const clauses = [];
    const params = [];
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (activeOnly) { clauses.push("state NOT IN ('completed', 'cancelled')"); }
    const rows = this.db.prepare(`SELECT workflow_id AS workflowId FROM workflows ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...params);
    return rows.map((row) => this.getWorkflow(row.workflowId));
  }

  updateWorkflow(workflowId, { state, payload, wakeAt, inputVersion = null, details = {} } = {}) {
    const allowed = new Set(['ready', 'evaluating', 'awaiting_input', 'awaiting_approval', 'executing', 'waiting_event', 'verifying', 'completed', 'cancelled', 'needs_attention']);
    if (!allowed.has(state)) throw new Error('Invalid workflow state.');
    const existing = this.getWorkflow(workflowId);
    if (!existing) throw new Error('Workflow not found.');
    const now = this.clock();
    this.db.prepare(`UPDATE workflows SET state = ?, payload_json = ?, wake_at = ?, input_version = COALESCE(?, input_version), updated_at = ? WHERE workflow_id = ?`)
      .run(state, JSON.stringify(payload === undefined ? existing.payload : payload), wakeAt === undefined ? existing.wakeAt : wakeAt, inputVersion, now, workflowId);
    if (details && Object.keys(details).length) this.audit('workflow-transition', null, null, { workflowId, state, ...details });
    return this.getWorkflow(workflowId);
  }

  upsertWorkflowStep(workflowId, { stepId, stepIndex, state, details = {} } = {}) {
    if (!this.getWorkflow(workflowId) || !stepId || !Number.isInteger(stepIndex) || !state) throw new Error('Invalid workflow step.');
    const now = this.clock();
    this.db.prepare(`INSERT INTO workflow_steps(workflow_id, step_id, step_index, state, details_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, step_id) DO UPDATE SET step_index = excluded.step_index, state = excluded.state, details_json = excluded.details_json, updated_at = excluded.updated_at`)
      .run(workflowId, stepId, stepIndex, state, JSON.stringify(details), now);
    return this.getWorkflow(workflowId).steps.find((step) => step.stepId === stepId);
  }

  getOrCreateConversation({ conversationId = crypto.randomUUID(), principal, channel } = {}) {
    if (!principal || !channel) throw new Error('Conversation identity is required.');
    const existing = this.db.prepare('SELECT conversation_id AS conversationId, principal, channel, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE conversation_id = ?').get(conversationId);
    if (existing) return existing;
    const now = this.clock();
    this.db.prepare('INSERT INTO conversations(conversation_id, principal, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(conversationId, principal, channel, now, now);
    return { conversationId, principal, channel, createdAt: now, updatedAt: now };
  }

  appendConversationMessage({ messageId = crypto.randomUUID(), conversationId, externalId = null, direction, content, taskId = null, workflowId = null } = {}) {
    if (!conversationId || !['inbound', 'outbound', 'system'].includes(direction) || !String(content || '').trim()) throw new Error('Invalid conversation message.');
    if (!this.db.prepare('SELECT conversation_id FROM conversations WHERE conversation_id = ?').get(conversationId)) throw new Error('Conversation not found.');
    const existing = externalId ? this.db.prepare('SELECT message_id AS messageId FROM conversation_messages WHERE conversation_id = ? AND external_id = ?').get(conversationId, externalId) : null;
    if (existing) return this.getConversationMessage(existing.messageId);
    const now = this.clock();
    this.db.prepare(`INSERT INTO conversation_messages(message_id, conversation_id, external_id, direction, content, task_id, workflow_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(messageId, conversationId, externalId, direction, String(content), taskId, workflowId, now);
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE conversation_id = ?').run(now, conversationId);
    return this.getConversationMessage(messageId);
  }

  getConversationMessage(messageId) {
    const row = this.db.prepare(`SELECT message_id AS messageId, conversation_id AS conversationId, external_id AS externalId, direction, content, task_id AS taskId, workflow_id AS workflowId, created_at AS createdAt FROM conversation_messages WHERE message_id = ?`).get(messageId);
    return row || null;
  }

  listConversationMessages(conversationId, limit = 100) {
    return this.db.prepare(`SELECT message_id AS messageId, conversation_id AS conversationId, external_id AS externalId, direction, content, task_id AS taskId, workflow_id AS workflowId, created_at AS createdAt FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`).all(conversationId, Math.min(500, Math.max(1, Number(limit) || 100))).reverse();
  }

  saveTaskCandidate(candidate) {
    if (!candidate?.candidateId || !candidate.observationId) throw new Error('Invalid task candidate.');
    const now = this.clock();
    const existing = this.db.prepare('SELECT task_id AS taskId, status, task_json AS taskJson FROM tasks WHERE candidate_id = ?').get(candidate.candidateId);
    if (existing) return { ...JSON.parse(existing.taskJson), taskId: existing.taskId, status: existing.status, preserved: true };
    const evidenced = this.db.prepare(`SELECT t.task_id AS taskId, t.status, t.task_json AS taskJson
      FROM task_evidence te JOIN tasks t ON t.task_id = te.task_id
      WHERE te.observation_id = ? AND te.evidence_text = ? ORDER BY t.updated_at DESC LIMIT 1`).get(candidate.observationId, candidate.evidence?.text || '');
    if (evidenced) return { ...JSON.parse(evidenced.taskJson), taskId: evidenced.taskId, status: evidenced.status, preserved: true };
    const reconciled = candidate.obligationKey
      ? this.db.prepare("SELECT task_id AS taskId, status, task_json AS taskJson FROM tasks WHERE obligation_key = ? AND status NOT IN ('done', 'dismissed') ORDER BY updated_at DESC LIMIT 1").get(candidate.obligationKey)
      : null;
    if (reconciled) {
      const prior = JSON.parse(reconciled.taskJson);
      const corrected = this.db.prepare('SELECT field_name AS fieldName, value_json AS valueJson FROM task_corrections WHERE task_id = ?').all(reconciled.taskId);
      const next = { ...prior, ...candidate, taskId: reconciled.taskId, obligationKey: candidate.obligationKey };
      for (const row of corrected) next[row.fieldName] = JSON.parse(row.valueJson);
      this.db.exec('BEGIN');
      try {
        this.db.prepare('UPDATE tasks SET task_json = ?, obligation_key = ?, updated_at = ? WHERE task_id = ?')
          .run(JSON.stringify(next), candidate.obligationKey, now, reconciled.taskId);
        this.db.prepare(`INSERT INTO task_evidence(task_id, observation_id, start_offset, end_offset, evidence_text)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, observation_id, start_offset, end_offset) DO NOTHING`)
          .run(reconciled.taskId, candidate.observationId, candidate.evidence.start, candidate.evidence.end, candidate.evidence.text);
        this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, \'reconciled\', ?, ?)')
          .run(reconciled.taskId, JSON.stringify({ observationId: candidate.observationId, extractorVersion: candidate.extractorVersion }), now);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return { ...next, status: reconciled.status, preserved: false, reconciled: true };
    }
    const taskId = candidate.candidateId;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO tasks(task_id, candidate_id, task_json, status, obligation_key, created_at, updated_at) VALUES (?, ?, ?, \'active\', ?, ?, ?)')
        .run(taskId, candidate.candidateId, JSON.stringify(candidate), candidate.obligationKey || null, now, now);
      this.db.prepare('INSERT INTO task_evidence(task_id, observation_id, start_offset, end_offset, evidence_text) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, candidate.observationId, candidate.evidence.start, candidate.evidence.end, candidate.evidence.text);
      this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, \'extracted\', ?, ?)')
        .run(taskId, JSON.stringify({ extractorVersion: candidate.extractorVersion }), now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ...candidate, taskId, status: 'active', preserved: false };
  }

  listTasks({ includeDismissed = false } = {}) {
    const rows = this.db.prepare(includeDismissed
      ? 'SELECT task_id AS taskId, task_json AS taskJson, status, created_at AS createdAt, updated_at AS updatedAt FROM tasks ORDER BY updated_at DESC'
      : `SELECT task_id AS taskId, task_json AS taskJson, status, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE status NOT IN ('dismissed', 'done') ORDER BY updated_at DESC`).all();
    return rows.map((row) => ({ ...JSON.parse(row.taskJson), taskId: row.taskId, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt }));
  }

  taskGraph({ includeDismissed = true } = {}) {
    const tasks = this.listTasks({ includeDismissed });
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const evidenceRows = this.db.prepare(`SELECT te.task_id AS taskId, te.observation_id AS observationId,
      te.evidence_text AS evidenceText, o.observation_json AS observationJson
      FROM task_evidence te JOIN observations o ON o.observation_id = te.observation_id`).all();
    const nodes = tasks.map((task) => ({ id: `task:${task.taskId}`, type: 'task', label: task.summary || 'Untitled task', status: task.status, owner: task.owner || null, dueDate: task.dueDate || null }));
    const edges = [];
    const seenObservations = new Set();
    for (const row of evidenceRows) {
      if (!taskIds.has(row.taskId)) continue;
      const observationId = `observation:${row.observationId}`;
      if (!seenObservations.has(observationId)) {
        let observation = {};
        try { observation = JSON.parse(row.observationJson); } catch (_) {}
        nodes.push({ id: observationId, type: 'observation', label: observation.subject || observation.title || observation.source || 'Source observation', source: observation.source || null });
        seenObservations.add(observationId);
      }
      edges.push({ from: `task:${row.taskId}`, to: observationId, type: 'evidence', label: row.evidenceText || '' });
    }
    const relationRows = this.db.prepare(`SELECT from_task_id AS fromTaskId, to_task_id AS toTaskId, relation_type AS relationType, details_json AS detailsJson
      FROM task_relations`).all();
    for (const row of relationRows) {
      if (!taskIds.has(row.fromTaskId) || !taskIds.has(row.toTaskId)) continue;
      let details = {};
      try { details = JSON.parse(row.detailsJson); } catch (_) {}
      edges.push({ from: `task:${row.fromTaskId}`, to: `task:${row.toTaskId}`, type: row.relationType, ...details });
    }
    return { nodes, edges };
  }

  addTaskRelation(fromTaskId, toTaskId, relationType, details = {}) {
    const allowed = new Set(['depends_on', 'blocks', 'belongs_to', 'waiting_on', 'supersedes', 'related_to']);
    if (!allowed.has(relationType)) throw new Error('Invalid task relation.');
    if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) throw new Error('A task relation requires two distinct tasks.');
    if (!details || typeof details !== 'object' || Array.isArray(details)) throw new Error('Task relation details must be an object.');
    const exists = this.db.prepare('SELECT task_id FROM tasks WHERE task_id IN (?, ?)').all(fromTaskId, toTaskId);
    if (exists.length !== 2) throw new Error('Both related tasks must exist.');
    if (relationType === 'depends_on' && this._taskRelationReaches(toTaskId, fromTaskId, 'depends_on')) throw new Error('Task dependency would create a cycle.');
    this.db.prepare(`INSERT INTO task_relations(from_task_id, to_task_id, relation_type, details_json, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(from_task_id, to_task_id, relation_type) DO UPDATE SET details_json = excluded.details_json`).run(fromTaskId, toTaskId, relationType, JSON.stringify(details), this.clock());
    this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, ?, ?, ?)')
      .run(fromTaskId, `relation-${relationType}`, JSON.stringify({ toTaskId, ...details }), this.clock());
    return { fromTaskId, toTaskId, relationType, details };
  }

  _taskRelationReaches(startTaskId, targetTaskId, relationType, seen = new Set()) {
    if (startTaskId === targetTaskId) return true;
    if (seen.has(startTaskId)) return false;
    seen.add(startTaskId);
    const next = this.db.prepare('SELECT to_task_id AS taskId FROM task_relations WHERE from_task_id = ? AND relation_type = ?').all(startTaskId, relationType);
    return next.some((row) => this._taskRelationReaches(row.taskId, targetTaskId, relationType, seen));
  }

  taskRelations(taskId = null) {
    const rows = taskId
      ? this.db.prepare('SELECT from_task_id AS fromTaskId, to_task_id AS toTaskId, relation_type AS relationType, details_json AS detailsJson, created_at AS createdAt FROM task_relations WHERE from_task_id = ? OR to_task_id = ? ORDER BY created_at').all(taskId, taskId)
      : this.db.prepare('SELECT from_task_id AS fromTaskId, to_task_id AS toTaskId, relation_type AS relationType, details_json AS detailsJson, created_at AS createdAt FROM task_relations ORDER BY created_at').all();
    return rows.map((row) => ({ ...row, details: JSON.parse(row.detailsJson) }));
  }

  setTaskStatus(taskId, status, details = {}) {
    if (!['active', 'done', 'snoozed', 'dismissed'].includes(status)) throw new Error('Invalid task status.');
    const task = this.db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(taskId);
    if (!task) throw new Error('Task not found.');
    const now = this.clock();
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(status, now, taskId);
    this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, `status-${status}`, JSON.stringify(details), now);
    return this.listTasks({ includeDismissed: true }).find((item) => item.taskId === taskId);
  }

  snoozeTask(taskId, untilAt) {
    if (!Number.isFinite(untilAt) || untilAt <= this.clock()) throw new Error('Snooze time must be in the future.');
    const row = this.db.prepare('SELECT task_json AS taskJson FROM tasks WHERE task_id = ?').get(taskId);
    if (!row) throw new Error('Task not found.');
    const task = { ...JSON.parse(row.taskJson), snoozedUntil: untilAt };
    const now = this.clock();
    this.db.prepare('UPDATE tasks SET task_json = ?, status = \'snoozed\', updated_at = ? WHERE task_id = ?').run(JSON.stringify(task), now, taskId);
    this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, \'snoozed\', ?, ?)').run(taskId, JSON.stringify({ untilAt }), now);
    return { ...task, taskId, status: 'snoozed' };
  }

  wakeSnoozedTasks(now = this.clock()) {
    for (const row of this.db.prepare(`SELECT task_id AS taskId, task_json AS taskJson FROM tasks WHERE status = 'snoozed'`).all()) {
      const task = JSON.parse(row.taskJson);
      if (Number(task.snoozedUntil) <= now) {
        delete task.snoozedUntil;
        this.db.prepare('UPDATE tasks SET task_json = ?, status = \'active\', updated_at = ? WHERE task_id = ?').run(JSON.stringify(task), now, row.taskId);
      }
    }
  }

  setSuppression(scopeType, scopeKey, untilAt = null, reason = '') {
    if (!scopeType || !scopeKey) throw new Error('Suppression scope is required.');
    this.db.prepare(`INSERT INTO suppressions(scope_type, scope_key, until_at, reason, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_key) DO UPDATE SET until_at = excluded.until_at, reason = excluded.reason`).run(scopeType, scopeKey, untilAt, reason, this.clock());
  }

  isSuppressed(scopeType, scopeKey, now = this.clock()) {
    const row = this.db.prepare('SELECT until_at AS untilAt FROM suppressions WHERE scope_type = ? AND scope_key = ?').get(scopeType, scopeKey);
    return Boolean(row && (row.untilAt === null || row.untilAt > now));
  }

  listSuppressions() {
    return this.db.prepare('SELECT scope_type AS scopeType, scope_key AS scopeKey, until_at AS untilAt, reason, created_at AS createdAt FROM suppressions ORDER BY created_at DESC').all();
  }

  removeSuppression(scopeType, scopeKey) {
    this.db.prepare('DELETE FROM suppressions WHERE scope_type = ? AND scope_key = ?').run(scopeType, scopeKey);
  }

  recordNotificationFeedback(notificationId, useful, details = {}) {
    if (!notificationId || typeof useful !== 'boolean') throw new Error('Invalid notification feedback.');
    this.db.prepare(`INSERT INTO notification_feedback(notification_id, useful, details_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(notification_id) DO UPDATE SET useful = excluded.useful, details_json = excluded.details_json, created_at = excluded.created_at`)
      .run(notificationId, useful ? 1 : 0, JSON.stringify(details), this.clock());
    this.audit('notification-feedback', null, null, { notificationId, useful });
  }

  notificationStats() {
    const delivery = this.db.prepare(`SELECT status, COUNT(*) AS count FROM notification_outbox GROUP BY status`).all();
    const feedback = this.db.prepare(`SELECT useful, COUNT(*) AS count FROM notification_feedback GROUP BY useful`).all();
    return {
      delivery: Object.fromEntries(delivery.map((row) => [row.status, Number(row.count)])),
      feedback: Object.fromEntries(feedback.map((row) => [row.useful ? 'useful' : 'notUseful', Number(row.count)])),
    };
  }

  listNotifications(limit = 20) {
    return this.db.prepare(`SELECT notification_id AS notificationId, date_key AS dateKey, notification_class AS notificationClass,
      status, created_at AS createdAt FROM notification_outbox ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  exportData() {
    const tables = ['sessions', 'events', 'approval_requests', 'approval_options', 'decisions', 'audit_entries', 'execution_attempts', 'receipts', 'connector_cursors', 'observations', 'connector_health', 'tasks', 'task_evidence', 'task_history', 'task_corrections', 'task_relations', 'context_records', 'workflows', 'workflow_steps', 'conversations', 'conversation_messages', 'notification_ledger', 'notification_outbox', 'suppressions', 'notification_feedback', 'jobs'];
    return {
      exportedAt: new Date(this.clock()).toISOString(),
      formatVersion: 1,
      data: Object.fromEntries(tables.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all()])),
    };
  }

  deleteMailData() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const counts = {};
      for (const [table, sql] of [
        ['workflow_steps', 'DELETE FROM workflow_steps'],
        ['workflows', 'DELETE FROM workflows'],
        ['conversation_references', 'UPDATE conversation_messages SET task_id = NULL, workflow_id = NULL'],
        ['task_relations', 'DELETE FROM task_relations'],
        ['task_evidence', 'DELETE FROM task_evidence'],
        ['task_history', 'DELETE FROM task_history'],
        ['task_corrections', 'DELETE FROM task_corrections'],
        ['tasks', 'DELETE FROM tasks'],
        ['observations', "DELETE FROM observations WHERE adapter_id LIKE 'gmail:%'"],
        ['connector_cursors', "DELETE FROM connector_cursors WHERE adapter_id LIKE 'gmail:%'"],
        ['connector_health', "DELETE FROM connector_health WHERE adapter_id LIKE 'gmail:%'"],
        ['notification_feedback', "DELETE FROM notification_feedback WHERE notification_id IN (SELECT notification_id FROM notification_outbox WHERE notification_class = 'digest')"],
        ['notification_outbox', "DELETE FROM notification_outbox WHERE notification_class = 'digest'"],
        ['notification_ledger', "DELETE FROM notification_ledger WHERE notification_class = 'digest'"],
      ]) {
        const result = this.db.prepare(sql).run();
        counts[table] = Number(result.changes);
      }
      this.db.exec('COMMIT');
      return counts;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  correctTask(taskId, changes) {
    const row = this.db.prepare('SELECT task_json AS taskJson FROM tasks WHERE task_id = ?').get(taskId);
    if (!row || !changes || typeof changes !== 'object') throw new Error('Task correction is invalid.');
    const next = { ...JSON.parse(row.taskJson), ...changes };
    const now = this.clock();
    this.db.prepare('UPDATE tasks SET task_json = ?, updated_at = ? WHERE task_id = ?').run(JSON.stringify(next), now, taskId);
    const correction = this.db.prepare(`INSERT INTO task_corrections(task_id, field_name, value_json, corrected_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, field_name) DO UPDATE SET value_json = excluded.value_json, corrected_at = excluded.corrected_at`);
    for (const [field, value] of Object.entries(changes)) correction.run(taskId, field, JSON.stringify(value), now);
    this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, \'corrected\', ?, ?)')
      .run(taskId, JSON.stringify(changes), now);
    return { ...next, taskId, status: this.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId).status };
  }

  reserveDigest({ dateKey, budgetDateKey = dateKey, items, cap, notificationClass = 'digest' }) {
    if (!dateKey || !Array.isArray(items) || !Number.isInteger(cap) || cap < 1) throw new Error('Invalid digest reservation.');
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ledger = this.db.prepare('SELECT reserved_count AS reservedCount, cap FROM notification_ledger WHERE date_key = ? AND notification_class = ?').get(budgetDateKey, notificationClass);
      const existing = ledger?.reservedCount || 0;
      const limit = ledger?.cap || cap;
      const available = Math.max(0, limit - existing);
      const selected = items.slice(0, available);
      if (!selected.length) { this.db.exec('COMMIT'); return null; }
      this.db.prepare(`INSERT INTO notification_ledger(date_key, notification_class, reserved_count, cap) VALUES (?, ?, ?, ?)
        ON CONFLICT(date_key, notification_class) DO UPDATE SET reserved_count = reserved_count + excluded.reserved_count`).run(budgetDateKey, notificationClass, selected.length, limit);
      const notificationId = crypto.randomUUID();
      this.db.prepare('INSERT INTO notification_outbox(notification_id, date_key, notification_class, payload_json, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?)')
        .run(notificationId, dateKey, notificationClass, JSON.stringify(selected), now);
      this.db.exec('COMMIT');
      return { notificationId, dateKey, items: selected, status: 'pending' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  hasNotificationForDate(dateKey, notificationClass = 'digest') {
    return Boolean(this.db.prepare('SELECT 1 FROM notification_outbox WHERE date_key = ? AND notification_class = ?').get(dateKey, notificationClass));
  }

  claimNotification(notificationClass = 'digest') {
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT notification_id AS notificationId, date_key AS dateKey, payload_json AS payloadJson
        FROM notification_outbox WHERE notification_class = ? AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?)) ORDER BY created_at LIMIT 1`).get(notificationClass, now - 10 * 60 * 1000);
      if (!row) { this.db.exec('COMMIT'); return null; }
      this.db.prepare('UPDATE notification_outbox SET status = \'sending\', claimed_at = ? WHERE notification_id = ?').run(now, row.notificationId);
      this.db.exec('COMMIT');
      return { notificationId: row.notificationId, dateKey: row.dateKey, items: JSON.parse(row.payloadJson), status: 'sending' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  completeNotification(notificationId, status, details = {}) {
    if (!['sent', 'failed', 'unknown'].includes(status)) throw new Error('Invalid notification status.');
    const result = this.db.prepare('UPDATE notification_outbox SET status = ?, payload_json = json_set(payload_json, \'$.delivery\', json(?)) WHERE notification_id = ?')
      .run(status, JSON.stringify(details), notificationId);
    if (Number(result.changes) !== 1) throw new Error('Notification not found.');
    this.audit(`notification-${status}`, null, null, { notificationId });
    return { notificationId, status, details };
  }

  getApproval(requestId) {
    const request = this.db.prepare('SELECT * FROM approval_requests WHERE request_id = ?').get(requestId);
    if (!request) return null;
    const options = this.db.prepare('SELECT option_id AS optionId, option_json AS optionJson FROM approval_options WHERE request_id = ?').all(requestId)
      .map((row) => ({ ...JSON.parse(row.optionJson), optionId: row.optionId }));
    return { ...request, action: JSON.parse(request.action_json), surfaces: JSON.parse(request.surfaces_json), options };
  }

  getDecision(requestId) {
    const row = this.db.prepare('SELECT decision_id AS decisionId, request_id AS requestId, option_id AS optionId, principal, surface, decided_at AS decidedAt FROM decisions WHERE request_id = ?').get(requestId);
    return row || null;
  }

  decide({ requestId, optionId, principal, surface }) {
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const request = this.db.prepare('SELECT * FROM approval_requests WHERE request_id = ?').get(requestId);
      if (!request) throw new Error('Approval request not found.');
      if (request.status !== 'pending') throw new Error('Approval request is already resolved.');
      if (request.principal !== principal) throw new Error('Approval principal mismatch.');
      if (!JSON.parse(request.surfaces_json).includes(surface)) throw new Error('Approval surface is not allowed.');
      if (now >= request.expires_at) {
        this.db.prepare('UPDATE approval_requests SET status = \'expired\', resolved_at = ? WHERE request_id = ?').run(now, requestId);
        this.audit('approval-expired', requestId, request.action_digest, { principal, surface });
        this.db.exec('COMMIT');
        throw new Error('Approval request has expired.');
      }
      const option = this.db.prepare('SELECT option_id FROM approval_options WHERE request_id = ? AND option_id = ?').get(requestId, optionId);
      if (!option) throw new Error('Approval option is invalid.');
      const decisionId = crypto.randomUUID();
      this.db.prepare('UPDATE approval_requests SET status = \'resolved\', resolved_at = ? WHERE request_id = ? AND status = \'pending\'').run(now, requestId);
      this.db.prepare('INSERT INTO decisions(decision_id, request_id, option_id, principal, surface, decided_at) VALUES (?, ?, ?, ?, ?, ?)').run(decisionId, requestId, optionId, principal, surface, now);
      this.audit('approval-decided', requestId, request.action_digest, { decisionId, optionId, principal, surface });
      this.db.exec('COMMIT');
      return { decisionId, requestId, optionId, actionDigest: request.action_digest };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* Transaction may already be committed for expiry. */ }
      throw error;
    }
  }

  audit(kind, requestId, actionDigest, details) {
    this.db.prepare('INSERT INTO audit_entries(kind, request_id, action_digest, details_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, requestId, actionDigest, JSON.stringify(details), this.clock());
  }

  recentAudit(limit = 50) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.db.prepare('SELECT audit_id AS auditId, kind, details_json AS detailsJson, created_at AS createdAt FROM audit_entries ORDER BY audit_id DESC LIMIT ?')
      .all(safeLimit).map((row) => ({ auditId: row.auditId, kind: row.kind, details: JSON.parse(row.detailsJson), createdAt: row.createdAt }));
  }
}

module.exports = { SqliteStore, MIGRATIONS, matchesGrantConstraints };
