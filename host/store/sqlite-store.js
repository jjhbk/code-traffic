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
  `CREATE TABLE IF NOT EXISTS mobile_commands (
    command_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS telegram_callbacks (
    token TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    action_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    claimed_at INTEGER,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS telegram_callbacks_expiry ON telegram_callbacks(expires_at, status);`,
  `CREATE TABLE IF NOT EXISTS mobile_pairing_codes (
    code_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mobile_devices (
    device_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS location_triggers (
    trigger_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    place_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    triggered_at INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS mobile_notification_receipts (
    notification_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    acknowledged_at INTEGER NOT NULL,
    PRIMARY KEY(notification_id, device_id)
  );`,
  `CREATE TABLE IF NOT EXISTS mobile_push_tokens (
    device_id TEXT PRIMARY KEY,
    push_token TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revoked_at INTEGER
  );`,
  `CREATE TABLE IF NOT EXISTS mobile_push_deliveries (
    notification_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(notification_id, device_id)
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

  transaction(callback) {
    if (typeof callback !== 'function') throw new Error('A transaction callback is required.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  getMobileCommand(commandId) {
    if (!commandId) return null;
    const row = this.db.prepare('SELECT command_id AS commandId, operation, result_json AS resultJson, created_at AS createdAt FROM mobile_commands WHERE command_id = ?').get(commandId);
    return row ? { ...row, result: JSON.parse(row.resultJson) } : null;
  }

  saveMobileCommand(commandId, operation, result) {
    if (!commandId || !operation || !result || typeof result !== 'object') throw new Error('Invalid mobile command receipt.');
    this.db.prepare('INSERT INTO mobile_commands(command_id, operation, result_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(command_id) DO NOTHING')
      .run(commandId, operation, JSON.stringify(result), this.clock());
    return this.getMobileCommand(commandId);
  }

  saveTelegramCallback({ token, chatId, action, expiresAt = this.clock() + 24 * 60 * 60 * 1000 } = {}) {
    if (!token || !chatId || !action || typeof action !== 'object' || Array.isArray(action) || !Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw new Error('Invalid Telegram callback.');
    const now = this.clock();
    this.db.prepare(`INSERT INTO telegram_callbacks(token, chat_id, action_json, expires_at, status, claimed_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)
      ON CONFLICT(token) DO UPDATE SET chat_id = excluded.chat_id, action_json = excluded.action_json, expires_at = excluded.expires_at, status = 'pending', claimed_at = NULL, consumed_at = NULL`).run(String(token), String(chatId), JSON.stringify(action), expiresAt, now);
    return { token: String(token), chatId: String(chatId), action, expiresAt, status: 'pending' };
  }

  claimTelegramCallback(token, chatId, { reclaimAfterMs = 10 * 60 * 1000 } = {}) {
    if (!token || !chatId) return null;
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT token, chat_id AS chatId, action_json AS actionJson, expires_at AS expiresAt, status, claimed_at AS claimedAt FROM telegram_callbacks WHERE token = ? AND chat_id = ?').get(String(token), String(chatId));
      if (!row || now >= row.expiresAt || row.status === 'consumed') { this.db.exec('COMMIT'); return null; }
      if (row.status === 'claimed' && Number(row.claimedAt || 0) + reclaimAfterMs > now) { this.db.exec('COMMIT'); return null; }
      this.db.prepare("UPDATE telegram_callbacks SET status = 'claimed', claimed_at = ? WHERE token = ? AND chat_id = ?").run(now, String(token), String(chatId));
      this.db.exec('COMMIT');
      return { ...row, action: JSON.parse(row.actionJson), status: 'claimed', claimedAt: now };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }

  completeTelegramCallback(token, chatId) {
    const result = this.db.prepare("UPDATE telegram_callbacks SET status = 'consumed', consumed_at = ?, claimed_at = NULL WHERE token = ? AND chat_id = ? AND status = 'claimed'").run(this.clock(), String(token), String(chatId));
    return Number(result.changes) > 0;
  }

  releaseTelegramCallback(token, chatId) {
    const result = this.db.prepare("UPDATE telegram_callbacks SET status = 'pending', claimed_at = NULL WHERE token = ? AND chat_id = ? AND status = 'claimed'").run(String(token), String(chatId));
    return Number(result.changes) > 0;
  }

  createMobilePairingCode({ codeId = crypto.randomUUID(), codeHash, expiresAt } = {}) {
    if (!codeId || !codeHash || !Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw new Error('Invalid mobile pairing code.');
    const now = this.clock();
    this.db.prepare('INSERT INTO mobile_pairing_codes(code_id, code_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)').run(codeId, codeHash, expiresAt, now);
    return { codeId, expiresAt };
  }

  consumeMobilePairingCode({ codeHash, deviceId, deviceName, tokenHash } = {}) {
    if (!codeHash || !deviceId || !deviceName || !tokenHash) throw new Error('Invalid mobile pairing request.');
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pairing = this.db.prepare('SELECT code_id AS codeId, expires_at AS expiresAt, used_at AS usedAt FROM mobile_pairing_codes WHERE code_hash = ?').get(codeHash);
      if (!pairing || pairing.usedAt !== null || now >= pairing.expiresAt) throw new Error('Mobile pairing code is invalid or expired.');
      this.db.prepare('UPDATE mobile_pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(now, codeHash);
      this.db.prepare('INSERT INTO mobile_devices(device_id, device_name, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)')
        .run(deviceId, String(deviceName).slice(0, 120), tokenHash, now, now);
      this.db.exec('COMMIT');
      return this.getMobileDevice(deviceId);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }

  getMobileDevice(deviceId) {
    const row = this.db.prepare('SELECT device_id AS deviceId, device_name AS deviceName, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM mobile_devices WHERE device_id = ?').get(deviceId);
    return row || null;
  }

  authenticateMobileDevice(tokenHash) {
    if (!tokenHash) return null;
    const row = this.db.prepare('SELECT device_id AS deviceId, device_name AS deviceName, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM mobile_devices WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash);
    if (!row) return null;
    this.db.prepare('UPDATE mobile_devices SET last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(this.clock(), row.deviceId);
    return { ...row, lastSeenAt: this.clock() };
  }

  revokeMobileDevice(deviceId) {
    const result = this.db.prepare('UPDATE mobile_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(this.clock(), deviceId);
    if (!Number(result.changes)) throw new Error('Mobile device not found or already revoked.');
    this.audit('mobile-device-revoked', null, null, { deviceId });
    return this.getMobileDevice(deviceId);
  }

  listMobileDevices() {
    return this.db.prepare('SELECT device_id AS deviceId, device_name AS deviceName, created_at AS createdAt, last_seen_at AS lastSeenAt, revoked_at AS revokedAt FROM mobile_devices ORDER BY created_at DESC').all();
  }

  registerMobilePushToken({ deviceId, pushToken, platform = 'expo' } = {}) {
    if (!deviceId || !pushToken || !['expo', 'ios', 'android', 'fcm'].includes(platform)) throw new Error('Invalid mobile push registration.');
    if (String(pushToken).length > 512) throw new Error('Mobile push token is too long.');
    const now = this.clock();
    this.db.prepare(`INSERT INTO mobile_push_tokens(device_id, push_token, platform, created_at, updated_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(device_id) DO UPDATE SET push_token = excluded.push_token, platform = excluded.platform, updated_at = excluded.updated_at, revoked_at = NULL`)
      .run(String(deviceId), String(pushToken), platform, now, now);
    this.audit('mobile-push-registered', null, null, { deviceId: String(deviceId), platform });
    return { deviceId: String(deviceId), platform, registered: true };
  }

  listMobilePushTokens({ deviceId = null, includeRevoked = false } = {}) {
    const clauses = [];
    const params = [];
    if (deviceId) { clauses.push('device_id = ?'); params.push(String(deviceId)); }
    if (!includeRevoked) clauses.push('revoked_at IS NULL');
    return this.db.prepare(`SELECT device_id AS deviceId, push_token AS pushToken, platform, created_at AS createdAt, updated_at AS updatedAt, revoked_at AS revokedAt
      FROM mobile_push_tokens ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...params);
  }

  revokeMobilePushToken(deviceId) {
    if (!deviceId) throw new Error('A mobile device is required.');
    const result = this.db.prepare('UPDATE mobile_push_tokens SET revoked_at = ?, updated_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(this.clock(), this.clock(), String(deviceId));
    if (Number(result.changes)) this.audit('mobile-push-revoked', null, null, { deviceId: String(deviceId) });
    return { deviceId: String(deviceId), revoked: Number(result.changes) === 1 };
  }

  listMobilePushWork({ limit = 50 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
    return this.db.prepare(`SELECT n.notification_id AS notificationId, n.created_at AS createdAt,
      t.device_id AS deviceId, t.push_token AS pushToken, t.platform,
      COALESCE(d.attempts, 0) AS attempts, d.status AS deliveryStatus
      FROM notification_outbox n JOIN mobile_push_tokens t ON t.revoked_at IS NULL AND n.created_at >= t.created_at
      LEFT JOIN mobile_push_deliveries d ON d.notification_id = n.notification_id AND d.device_id = t.device_id
      WHERE d.status IS NULL OR (d.status = 'failed' AND d.attempts < 5)
      ORDER BY n.created_at, n.notification_id LIMIT ?`).all(safeLimit);
  }

  recordMobilePushDelivery({ notificationId, deviceId, status, error = null } = {}) {
    if (!notificationId || !deviceId || !['sent', 'failed'].includes(status)) throw new Error('Invalid mobile push delivery.');
    const now = this.clock();
    this.db.prepare(`INSERT INTO mobile_push_deliveries(notification_id, device_id, status, attempts, last_error, sent_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(notification_id, device_id) DO UPDATE SET status = excluded.status,
      attempts = mobile_push_deliveries.attempts + 1, last_error = excluded.last_error,
      sent_at = CASE WHEN excluded.status = 'sent' THEN excluded.sent_at ELSE mobile_push_deliveries.sent_at END,
      updated_at = excluded.updated_at`)
      .run(String(notificationId), String(deviceId), status, error ? String(error).slice(0, 500) : null, status === 'sent' ? now : null, now);
    this.audit(`mobile-push-${status}`, null, null, { notificationId: String(notificationId), deviceId: String(deviceId), error: error || null });
    return { notificationId: String(notificationId), deviceId: String(deviceId), status };
  }

  recordLocationTrigger({ triggerKey, taskId, placeKey, eventId, triggeredAt = this.clock() } = {}) {
    if (!triggerKey || !taskId || !placeKey || !eventId || !Number.isFinite(triggeredAt)) throw new Error('Invalid location trigger.');
    const result = this.db.prepare('INSERT INTO location_triggers(trigger_key, task_id, place_key, event_id, triggered_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(trigger_key) DO NOTHING')
      .run(triggerKey, taskId, placeKey, eventId, triggeredAt);
    return Number(result.changes) === 1;
  }

  listLocationTriggers({ taskId = null, placeKey = null } = {}) {
    const clauses = []; const params = [];
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (placeKey) { clauses.push('place_key = ?'); params.push(placeKey); }
    return this.db.prepare(`SELECT trigger_key AS triggerKey, task_id AS taskId, place_key AS placeKey, event_id AS eventId, triggered_at AS triggeredAt FROM location_triggers ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY triggered_at DESC`).all(...params);
  }

  enqueueNotification({ notificationId = crypto.randomUUID(), dateKey, notificationClass, items } = {}) {
    if (!notificationId || !dateKey || !notificationClass || !Array.isArray(items) || !items.length) throw new Error('Invalid notification.');
    const now = this.clock();
    try {
      this.db.prepare('INSERT INTO notification_outbox(notification_id, date_key, notification_class, payload_json, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?)')
        .run(notificationId, dateKey, notificationClass, JSON.stringify(items), now);
      this.audit('notification-enqueued', null, null, { notificationId, notificationClass });
      return { notificationId, dateKey, notificationClass, items, status: 'pending' };
    } catch (error) {
      if (/UNIQUE|constraint/i.test(error.message)) return null;
      throw error;
    }
  }

  listPendingNotifications({ notificationClass = null, limit = 50 } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const row = notificationClass
      ? this.db.prepare("SELECT notification_id AS notificationId, date_key AS dateKey, notification_class AS notificationClass, payload_json AS payloadJson, status, created_at AS createdAt FROM notification_outbox WHERE notification_class = ? AND status = 'pending' ORDER BY created_at DESC LIMIT ?").all(notificationClass, safeLimit)
      : this.db.prepare("SELECT notification_id AS notificationId, date_key AS dateKey, notification_class AS notificationClass, payload_json AS payloadJson, status, created_at AS createdAt FROM notification_outbox WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?").all(safeLimit);
    return row.map((item) => ({ ...item, items: JSON.parse(item.payloadJson) }));
  }

  listMobileNotifications({ deviceId, afterCreatedAt = 0, afterNotificationId = '', limit = 50 } = {}) {
    if (!deviceId) throw new Error('A mobile device is required.');
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.db.prepare(`SELECT n.notification_id AS notificationId, n.date_key AS dateKey, n.notification_class AS notificationClass,
      n.payload_json AS payloadJson, n.status, n.created_at AS createdAt,
      CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS acknowledged
      FROM notification_outbox n LEFT JOIN mobile_notification_receipts r ON r.notification_id = n.notification_id AND r.device_id = ?
      WHERE (n.created_at > ? OR (n.created_at = ? AND n.notification_id > ?)) ORDER BY n.created_at, n.notification_id LIMIT ?`).all(deviceId, Number(afterCreatedAt) || 0, Number(afterCreatedAt) || 0, String(afterNotificationId || ''), safeLimit)
      .map((item) => ({ ...item, acknowledged: Boolean(item.acknowledged), items: JSON.parse(item.payloadJson) }));
  }

  acknowledgeMobileNotification(notificationId, deviceId) {
    if (!notificationId || !deviceId) throw new Error('A notification and mobile device are required.');
    if (!this.db.prepare('SELECT notification_id FROM notification_outbox WHERE notification_id = ?').get(notificationId)) throw new Error('Notification not found.');
    this.db.prepare('INSERT INTO mobile_notification_receipts(notification_id, device_id, acknowledged_at) VALUES (?, ?, ?) ON CONFLICT(notification_id, device_id) DO UPDATE SET acknowledged_at = excluded.acknowledged_at')
      .run(notificationId, deviceId, this.clock());
    this.audit('mobile-notification-acknowledged', null, null, { notificationId, deviceId });
    return { notificationId, deviceId, acknowledged: true };
  }

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

  jobHealth(now = this.clock()) {
    if (!Number.isFinite(now)) throw new Error('A job health timestamp is required.');
    const counts = this.db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all();
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
    const queued = this.db.prepare("SELECT MIN(run_at) AS nextRunAt, SUM(CASE WHEN run_at <= ? THEN 1 ELSE 0 END) AS overdue FROM jobs WHERE status = 'queued'").get(now);
    const expiredRunning = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running' AND lease_until < ?").get(now);
    return { queued: byStatus.queued || 0, running: byStatus.running || 0, completed: byStatus.completed || 0, failed: byStatus.failed || 0, overdue: Number(queued.overdue || 0), expiredRunning: Number(expiredRunning.count || 0), nextRunAt: queued.nextRunAt ?? null };
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

  removeObservation(adapterId, messageId) {
    const rows = this.db.prepare('SELECT observation_id AS observationId, observation_json AS observationJson FROM observations WHERE adapter_id = ? AND message_id = ?').all(adapterId, String(messageId));
    if (!rows.length) return false;
    const now = this.clock();
    const update = this.db.prepare('UPDATE observations SET observation_json = ?, observed_at = ? WHERE observation_id = ?');
    const remove = this.db.prepare('DELETE FROM observations WHERE observation_id = ?');
    for (const row of rows) {
      const referenced = this.db.prepare('SELECT 1 FROM task_evidence WHERE observation_id = ? LIMIT 1').get(row.observationId);
      if (referenced) {
        const observation = JSON.parse(row.observationJson);
        update.run(JSON.stringify({ ...observation, removed: true, removedAt: now }), now, row.observationId);
        const taskRows = this.db.prepare('SELECT DISTINCT task_id AS taskId FROM task_evidence WHERE observation_id = ?').all(row.observationId);
        for (const taskRow of taskRows) {
          const liveEvidence = this.db.prepare(`SELECT 1 FROM task_evidence te JOIN observations o ON o.observation_id = te.observation_id
            WHERE te.task_id = ? AND COALESCE(json_extract(o.observation_json, '$.removed'), 0) != 1 LIMIT 1`).get(taskRow.taskId);
          if (liveEvidence) continue;
          const task = this.db.prepare('SELECT task_json AS taskJson FROM tasks WHERE task_id = ?').get(taskRow.taskId);
          if (!task) continue;
          const taskJson = JSON.parse(task.taskJson);
          if (taskJson.sourceUnavailable !== true) {
            this.db.prepare('UPDATE tasks SET task_json = ?, updated_at = ? WHERE task_id = ?')
              .run(JSON.stringify({ ...taskJson, sourceUnavailable: true, sourceUnavailableAt: now }), now, taskRow.taskId);
            this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, \'source-removed\', ?, ?)')
              .run(taskRow.taskId, JSON.stringify({ observationId: row.observationId, adapterId, messageId: String(messageId) }), now);
          }
          this._invalidateTaskActions(taskRow.taskId, 'source-removed', now);
          this.enqueueJob({ kind: 'assistant.replan', payload: { taskId: taskRow.taskId, reason: 'source-removed' }, runAt: now, dedupeKey: `assistant.replan:${taskRow.taskId}:${now}` });
        }
      } else {
        remove.run(row.observationId);
      }
      this.audit('observation-removed', null, null, { observationId: row.observationId, adapterId, messageId: String(messageId), tombstone: Boolean(referenced) });
    }
    return true;
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
    const types = new Set(['person', 'project', 'goal', 'preference', 'fact', 'place']);
    const confidences = new Set(['inferred', 'low', 'medium', 'high']);
    if (!types.has(recordType) || !recordKey || value === undefined || !confidences.has(confidence) || typeof confirmed !== 'boolean') throw new Error('Invalid context record.');
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Context source must be an object.');
    const normalizedKey = String(recordKey);
    const now = this.clock();
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO context_records(record_id, record_type, record_key, value_json, source_json, confidence, confirmed, valid_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_type, record_key) DO UPDATE SET value_json = excluded.value_json, source_json = excluded.source_json,
        confidence = excluded.confidence, confirmed = excluded.confirmed, valid_until = excluded.valid_until, updated_at = excluded.updated_at`)
        .run(recordId, recordType, normalizedKey, JSON.stringify(value), JSON.stringify(source), confidence, confirmed ? 1 : 0, validUntil, now, now);
      this._replanContextTasks(recordType, normalizedKey, 'context-updated', now);
      this.audit('context-upserted', null, null, { recordType, recordKey: normalizedKey, confirmed });
      return this.getContext(recordType, normalizedKey);
    });
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
    const normalizedKey = String(recordKey);
    return this.transaction(() => {
      const result = this.db.prepare('DELETE FROM context_records WHERE record_type = ? AND record_key = ?').run(recordType, normalizedKey);
      if (Number(result.changes)) {
        this._replanContextTasks(recordType, normalizedKey, 'context-deleted', this.clock());
        this.audit('context-deleted', null, null, { recordType, recordKey: normalizedKey });
      }
      return Number(result.changes) === 1;
    });
  }

  _replanContextTasks(recordType, recordKey, reason, now = this.clock()) {
    const needle = String(recordKey).toLowerCase();
    const affected = this.listTasks({ includeDismissed: true }).filter((task) => {
      if (['done', 'dismissed'].includes(task.status)) return false;
      const trigger = task.contextTrigger || task.locationTrigger;
      if (recordType === 'place' && trigger?.placeKey && String(trigger.placeKey).toLowerCase() === needle) return true;
      const searchable = JSON.stringify({ summary: task.summary, description: task.description, counterparty: task.counterparty, project: task.project, goal: task.goal, contextTrigger: task.contextTrigger, locationTrigger: task.locationTrigger }).toLowerCase();
      return searchable.includes(needle);
    });
    for (const task of affected) {
      this._invalidateTaskActions(task.taskId, reason, now);
      this.enqueueJob({ kind: 'assistant.replan', payload: { taskId: task.taskId, reason }, runAt: now, dedupeKey: `assistant.replan:${task.taskId}:context:${recordType}:${needle}` });
    }
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
    if (existing) return { ...this.getConversationMessage(existing.messageId), duplicate: true };
    const now = this.clock();
    const result = this.db.prepare(`INSERT OR IGNORE INTO conversation_messages(message_id, conversation_id, external_id, direction, content, task_id, workflow_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(messageId, conversationId, externalId, direction, String(content), taskId, workflowId, now);
    if (Number(result.changes) === 1) this.db.prepare('UPDATE conversations SET updated_at = ? WHERE conversation_id = ?').run(now, conversationId);
    const saved = Number(result.changes) === 1
      ? this.getConversationMessage(messageId)
      : this.getConversationMessage(this.db.prepare('SELECT message_id AS messageId FROM conversation_messages WHERE conversation_id = ? AND external_id = ?').get(conversationId, externalId).messageId);
    return { ...saved, duplicate: Number(result.changes) !== 1 };
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
      const next = { ...prior, ...candidate, sourceUnavailable: false, taskId: reconciled.taskId, obligationKey: candidate.obligationKey };
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

  taskGraph({ includeDismissed = true, taskId = null, depth = null, limit = 500 } = {}) {
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 500));
    const allTasks = this.listTasks({ includeDismissed });
    const relationRows = this.db.prepare(`SELECT from_task_id AS fromTaskId, to_task_id AS toTaskId, relation_type AS relationType, details_json AS detailsJson
      FROM task_relations ORDER BY created_at`).all();
    let tasks;
    if (taskId) {
      const byId = new Map(allTasks.map((task) => [task.taskId, task]));
      if (!byId.has(taskId)) return { nodes: [], edges: [] };
      const maxDepth = depth === null || depth === undefined ? 2 : Math.min(10, Math.max(0, Number(depth) || 0));
      const selected = new Set([taskId]);
      const queue = [{ taskId, depth: 0 }];
      while (queue.length) {
        const current = queue.shift();
        if (current.depth >= maxDepth) continue;
        for (const relation of relationRows) {
          const next = relation.fromTaskId === current.taskId ? relation.toTaskId : relation.toTaskId === current.taskId ? relation.fromTaskId : null;
          if (next && byId.has(next) && !selected.has(next)) {
            selected.add(next);
            queue.push({ taskId: next, depth: current.depth + 1 });
          }
        }
      }
      tasks = [...selected].slice(0, safeLimit).map((id) => byId.get(id));
    } else {
      tasks = allTasks.slice(0, safeLimit);
    }
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const evidenceRows = this.db.prepare(`SELECT te.task_id AS taskId, te.observation_id AS observationId,
      te.evidence_text AS evidenceText, o.observation_json AS observationJson
      FROM task_evidence te JOIN observations o ON o.observation_id = te.observation_id`).all();
    const nodes = tasks.map((task) => ({ id: `task:${task.taskId}`, type: 'task', label: task.summary || 'Untitled task', status: task.status, owner: task.owner || null, dueDate: task.dueDate || null, dueAt: task.dueAt || null, timeZone: task.timeZone || null, sourceUnavailable: task.sourceUnavailable === true }));
    const edges = [];
    const contextRecords = this.listContext({ includeExpired: true });
    const contextByKey = new Map(contextRecords.map((record) => [`${record.recordType}:${record.recordKey}`.toLowerCase(), record]));
    const linkedContext = new Set();
    const contextReference = (recordType, recordKey) => {
      if (!recordKey) return null;
      const record = contextByKey.get(`${recordType}:${String(recordKey)}`.toLowerCase());
      if (!record) return null;
      const nodeId = `context:${record.recordType}:${encodeURIComponent(record.recordKey)}`;
      if (!linkedContext.has(nodeId)) {
        const value = record.value && typeof record.value === 'object' ? (record.value.label || record.value.name || record.value.title) : record.value;
        nodes.push({ id: nodeId, type: 'context', contextType: record.recordType, label: value ? `${record.recordKey}: ${value}` : record.recordKey, source: record.source?.channel || record.recordType, expired: record.validUntil !== null && Number(record.validUntil) <= this.clock() });
        linkedContext.add(nodeId);
      }
      return nodeId;
    };
    for (const task of tasks) {
      const references = [
        ['person', task.counterparty],
        ['project', task.project],
        ['goal', task.goal],
        ['place', task.contextTrigger?.placeKey || task.locationTrigger?.placeKey],
      ];
      for (const [recordType, recordKey] of references) {
        const nodeId = contextReference(recordType, recordKey);
        if (nodeId) edges.push({ from: `task:${task.taskId}`, to: nodeId, type: 'context', contextType: recordType });
      }
      for (const reference of Array.isArray(task.contextKeys) ? task.contextKeys : []) {
        if (!reference || typeof reference !== 'object') continue;
        const nodeId = contextReference(reference.recordType, reference.recordKey);
        if (nodeId) edges.push({ from: `task:${task.taskId}`, to: nodeId, type: 'context', contextType: reference.recordType });
      }
    }
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
    const tables = ['sessions', 'events', 'approval_requests', 'approval_options', 'decisions', 'audit_entries', 'execution_attempts', 'receipts', 'connector_cursors', 'observations', 'connector_health', 'tasks', 'task_evidence', 'task_history', 'task_corrections', 'task_relations', 'context_records', 'workflows', 'workflow_steps', 'conversations', 'conversation_messages', 'notification_ledger', 'notification_outbox', 'suppressions', 'notification_feedback', 'jobs', 'mobile_commands', 'telegram_callbacks', 'mobile_pairing_codes', 'mobile_devices', 'location_triggers', 'mobile_notification_receipts', 'mobile_push_tokens', 'mobile_push_deliveries'];
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

  _invalidateTaskActions(taskId, reason, now = this.clock()) {
    const approvals = this.db.prepare("SELECT request_id AS requestId, action_json AS actionJson, action_digest AS actionDigest FROM approval_requests WHERE status = 'pending'").all();
    for (const approval of approvals) {
      const action = JSON.parse(approval.actionJson);
      if (action.taskId !== taskId) continue;
      this.db.prepare("UPDATE approval_requests SET status = 'cancelled', resolved_at = ? WHERE request_id = ? AND status = 'pending'").run(now, approval.requestId);
      this.audit('approval-cancelled', approval.requestId, approval.actionDigest, { reason, taskId });
    }
    const workflows = this.db.prepare("SELECT workflow_id AS workflowId, payload_json AS payloadJson FROM workflows WHERE task_id = ? AND state = 'awaiting_approval'").all(taskId);
    for (const workflow of workflows) {
      const payload = JSON.parse(workflow.payloadJson);
      this.db.prepare("UPDATE workflows SET state = 'needs_attention', payload_json = ?, updated_at = ? WHERE workflow_id = ? AND state = 'awaiting_approval'")
        .run(JSON.stringify({ ...payload, invalidationReason: reason, invalidatedAt: now }), now, workflow.workflowId);
      this.audit('workflow-invalidated', null, null, { workflowId: workflow.workflowId, taskId, reason });
    }
  }

  correctTask(taskId, changes) {
    const row = this.db.prepare('SELECT task_json AS taskJson FROM tasks WHERE task_id = ?').get(taskId);
    if (!row || !changes || typeof changes !== 'object') throw new Error('Task correction is invalid.');
    return this.transaction(() => {
      const next = { ...JSON.parse(row.taskJson), ...changes };
      const now = this.clock();
      this.db.prepare('UPDATE tasks SET task_json = ?, updated_at = ? WHERE task_id = ?').run(JSON.stringify(next), now, taskId);
      const correction = this.db.prepare(`INSERT INTO task_corrections(task_id, field_name, value_json, corrected_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id, field_name) DO UPDATE SET value_json = excluded.value_json, corrected_at = excluded.corrected_at`);
      for (const [field, value] of Object.entries(changes)) correction.run(taskId, field, JSON.stringify(value), now);
      this.db.prepare('INSERT INTO task_history(task_id, kind, details_json, created_at) VALUES (?, \'corrected\', ?, ?)')
        .run(taskId, JSON.stringify(changes), now);
      this._invalidateTaskActions(taskId, 'task-corrected', now);
      this.enqueueJob({ kind: 'assistant.replan', payload: { taskId, reason: 'task-corrected' }, runAt: now, dedupeKey: `assistant.replan:${taskId}:${now}` });
      return { ...next, taskId, status: this.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId).status };
    });
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

  listPendingApprovals({ principal = null, surface = null, now = this.clock() } = {}) {
    const clauses = ["status = 'pending'"]; const params = [];
    if (principal) { clauses.push('principal = ?'); params.push(principal); }
    const rows = this.db.prepare(`SELECT request_id AS requestId, expires_at AS expiresAt FROM approval_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`).all(...params);
    return rows.map((row) => this.getApproval(row.requestId)).filter((request) => request && Number(request.expires_at || request.expiresAt) > now && (!surface || request.surfaces.includes(surface)));
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

  cancelApproval(requestId, reason = 'invalidated') {
    if (!requestId) throw new Error('Approval request is required.');
    const request = this.db.prepare('SELECT request_id AS requestId, action_digest AS actionDigest, status FROM approval_requests WHERE request_id = ?').get(requestId);
    if (!request) throw new Error('Approval request not found.');
    if (request.status !== 'pending') return { requestId, status: request.status, cancelled: false };
    const result = this.db.prepare("UPDATE approval_requests SET status = 'cancelled', resolved_at = ? WHERE request_id = ? AND status = 'pending'").run(this.clock(), requestId);
    if (Number(result.changes) === 1) this.audit('approval-cancelled', requestId, request.actionDigest, { reason });
    return { requestId, status: 'cancelled', cancelled: Number(result.changes) === 1 };
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
