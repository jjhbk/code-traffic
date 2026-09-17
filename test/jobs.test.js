const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { JobRunner } = require('../host/workflows/job-runner');

let now = 1000;
const store = new SqliteStore({ clock: () => now });
const first = store.enqueueJob({ kind: 'test', payload: { value: 1 }, dedupeKey: 'same' });
const duplicate = store.enqueueJob({ kind: 'test', payload: { value: 2 }, dedupeKey: 'same' });
assert.equal(duplicate.deduplicated, true);
assert.equal(store.claimJobs({ workerId: 'worker', now }).length, 1);
const claimed = store.getJob(first.jobId);
assert.equal(claimed.attempts, 1);
assert.equal(store.renewJob(first.jobId, claimed.leaseToken, 120_000, now), true);
assert.equal(store.getJob(first.jobId).leaseUntil, now + 120_000);
assert.throws(() => store.completeJob(first.jobId, 'wrong', { status: 'completed' }), /lease/);

(async () => {
  const runner = new JobRunner({ store, workerId: 'runner', clock: () => now });
  runner.register('test', async (payload) => { assert.equal(payload.value, 1); });
  // Reclaim the lease after its deadline to exercise restart recovery.
  now += 121_000;
  const results = await runner.runOnce();
  assert.equal(results[0].status, 'completed');
  assert.equal(store.getJob(first.jobId).status, 'completed');
  const retry = store.enqueueJob({ kind: 'missing', payload: {}, maxAttempts: 1 });
  const failed = await runner.runOnce();
  assert.equal(failed[0].jobId, retry.jobId);
  assert.equal(store.getJob(retry.jobId).status, 'failed');
  assert.ok(store.exportData().data.jobs.length >= 2);
  store.close();
  console.log('job tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
