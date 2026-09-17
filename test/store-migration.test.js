const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SqliteStore } = require('../host/store/sqlite-store');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-migration-'));
const filename = path.join(directory, 'signal-box.db');
const legacy = new DatabaseSync(filename);
legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations(version, applied_at) VALUES (0, 100);');
legacy.close();

const store = new SqliteStore({ filename, clock: () => 200 });
assert.ok(store.migrationBackupPath, 'pending migrations create a backup path');
assert.equal(fs.existsSync(store.migrationBackupPath), true);
assert.equal(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version > 0, true);
store.ingestEvent({ eventId: 'post-migration-event', adapterId: 'fixture', type: 'observation', payload: { ready: true } });
assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE event_id = ?').get('post-migration-event').count, 1);
store.close();
fs.rmSync(directory, { recursive: true, force: true });
console.log('store migration tests passed');
