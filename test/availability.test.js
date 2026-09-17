const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { WorkflowService } = require('../host/workflows/service');
const { AvailabilityWorkflow } = require('../host/workflows/availability');

(async () => {
  let now = 100_000;
  const store = new SqliteStore({ clock: () => now });
  const workflows = new WorkflowService({ store });
  const watcher = new AvailabilityWorkflow({ store, workflows, clock: () => now });
  const started = watcher.start({ checkRecipeId: 'availability.read.v1', reservationRecipeId: 'availability.reserve.v1', checkGrantId: 'grant-check', reservationGrantId: 'grant-1', intervalMs: 1_000, maxChecks: 2 });
  assert.equal(started.state, 'waiting_event');
  assert.equal(store.getJob(started.workflowId), null);
  const firstJob = store.claimJobs({ now, workerId: 'watcher' })[0];
  assert.equal(firstJob.kind, 'browser.availability.check');
  const waiting = await watcher.check(started.workflowId, { available: false, evidence: 'No slots.' });
  assert.equal(waiting.state, 'waiting_event');
  assert.equal(waiting.payload.checks, 1);
  now += 1_000;
  const secondJob = store.claimJobs({ now, workerId: 'watcher-2' })[0];
  assert.equal(secondJob.kind, 'browser.availability.check');
  const completed = await watcher.check(started.workflowId, { available: true, evidence: 'Slot available.', executeReservation: async () => ({ confirmationId: 'fixture-1' }) });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.payload.reservation.confirmationId, 'fixture-1');
  assert.equal(store.listWorkflows({ activeOnly: true }).length, 0);
  store.close();
  console.log('availability workflow tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
