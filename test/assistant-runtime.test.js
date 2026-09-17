const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { AssistantRuntime } = require('../host/runtime/assistant');

let now = 1000;
const store = new SqliteStore({ clock: () => now });
const runtime = new AssistantRuntime({ store, intervalMs: 60_000, clock: () => now });
let processed = 0;
runtime.register('unit', async (payload) => { processed += payload.amount; });
runtime.schedule('unit', { amount: 2 }, now, 'unit:first');
(async () => {
  assert.equal(runtime.health().paused, false);
  assert.equal(runtime.setPaused(true).paused, true);
  assert.deepEqual(await runtime.tick(), []);
  runtime.setPaused(false);
  await runtime.tick();
  assert.equal(processed, 2);
  assert.equal(runtime.health().busy, false);
  assert.equal(store.getJob(store.exportData().data.jobs[0].job_id).status, 'completed');
  runtime.stop();
  store.close();
  console.log('assistant runtime tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
