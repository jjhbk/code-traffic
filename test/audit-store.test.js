const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');

const store = new SqliteStore();
store.ingestEvent({ eventId: 'event-1', adapterId: 'fixture', type: 'working', payload: { cwd: '/tmp/project' } });
store.saveObservation({ observationId: 'observation-1', messageId: 'message-1', threadId: 'thread-1', subject: 'redacted', body: 'redacted' }, 'gmail:user@example.com');
store.setConnectorHealth('gmail:user@example.com', 'healthy');
const request = store.createApproval({ action: { capability: 'browser.commit', recipeId: 'fixture' }, options: [{ optionId: 'allow', label: 'Allow' }], principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 10000 });
const requestId = request.request_id || request.requestId;
store.decide({ requestId, optionId: 'allow', principal: 'signal-box-user', surface: 'desktop' });
const attempt = store.recordExecutionAttempt({ requestId, status: 'prepared', details: {} });
store.recordReceipt({ attemptId: attempt.attemptId, receipt: { status: 'confirmed' } });

const audit = store.exportData().data.audit_entries.map((entry) => entry.kind);
for (const kind of ['event-ingested', 'observation-saved', 'connector-health', 'approval-requested', 'approval-decided', 'execution-prepared', 'execution-receipt']) {
  assert.ok(audit.includes(kind), `missing audit entry: ${kind}`);
}
assert.ok(store.recentAudit(3).length <= 3);
assert.equal(typeof store.recentAudit(1)[0].createdAt, 'number');
store.close();
console.log('audit store tests passed');
