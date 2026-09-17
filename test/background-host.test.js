const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { SqliteStore } = require('../host/store/sqlite-store');
const { BackgroundHost } = require('../host/runtime/background-host');
const { WorkflowService } = require('../host/workflows/service');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-background-'));
  const databasePath = path.join(directory, 'assistant.db');
  const store = new SqliteStore({ filename: databasePath });
  const workflow = store.createWorkflow({ workflowType: 'background-fixture', state: 'waiting_event', payload: {} });
  store.saveTaskCandidate({ candidateId: 'background-replan-task', observationId: 'background-replan-observation', summary: 'Send the update', dueDate: 'today', evidence: { start: 0, end: 6, text: 'update' }, extractorVersion: 'test' });
  store.saveObservation({ observationId: 'background-reconcile-observation', messageId: 'background-reconcile-message', threadId: 'background-reconcile-thread', subject: 'Background task', body: "I'll send the background update by Friday.", direction: 'outgoing' }, 'background-fixture');
  store.enqueueJob({ kind: 'workflow.resume', payload: { workflowId: workflow.workflowId }, runAt: Date.now(), dedupeKey: 'background-fixture' });
  store.enqueueJob({ kind: 'assistant.replan', payload: { taskId: 'background-replan-task', reason: 'source-removed' }, runAt: Date.now(), dedupeKey: 'background-replan-fixture' });
  store.enqueueJob({ kind: 'tasks.reconcile', payload: { adapterId: 'background-fixture' }, runAt: Date.now(), dedupeKey: 'background-reconcile-fixture' });
  store.enqueueJob({ kind: 'assistant.digest', payload: {}, runAt: Date.now(), dedupeKey: 'background-digest' });
  store.close();

  const liveStore = new SqliteStore({ filename: databasePath });
  let jobs = 0;
  let cadenceObserved = false;
  const host = new BackgroundHost({ databasePath, onJob: async (kind, payload) => {
    if (kind === 'workflow.resume') return new WorkflowService({ store: liveStore }).resume(payload.workflowId);
    if (kind === 'assistant.digest') {
      jobs += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      cadenceObserved = liveStore.exportData().data.jobs.some((job) => job.kind === 'assistant.digest'
        && job.status === 'queued' && String(job.dedupe_key || '').startsWith('assistant.digest:'));
    }
  } });
  const initial = await host.start();
  assert.equal(initial.running, true);
  assert.equal((await host.health()).paused, false);
  assert.equal((await host.pause(true)).paused, true);
  assert.equal((await host.pause(false)).paused, false);
  const deadline = Date.now() + 3000;
  let current;
  while (Date.now() < deadline) {
    const probe = new SqliteStore({ filename: databasePath });
    current = probe.getWorkflow(workflow.workflowId);
    const notifications = probe.listPendingNotifications({ notificationClass: 'assistant-replan' });
    probe.close();
    if (current.state === 'needs_attention' && jobs === 1 && cadenceObserved && notifications.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(current.state, 'needs_attention');
  assert.equal(jobs, 1);
  assert.equal(cadenceObserved, true);
  const replanProbe = new SqliteStore({ filename: databasePath });
  assert.equal(replanProbe.listPendingNotifications({ notificationClass: 'assistant-replan' }).length, 1);
  replanProbe.close();
  const reconciled = new SqliteStore({ filename: databasePath });
  assert.equal(reconciled.getWorkflow(workflow.workflowId).state, 'needs_attention');
  assert.equal(reconciled.listTasks().some((task) => task.summary === 'Background task'), true, 'background host reconciles tasks without Electron');
  reconciled.close();
  assert.deepEqual(await host.stop(), { stopped: true });
  liveStore.close();
  const failedChild = new EventEmitter();
  failedChild.connected = false;
  const failedHost = new BackgroundHost({ databasePath, forkImpl: () => failedChild });
  const startup = failedHost.start();
  failedChild.emit('error', new Error('spawn failed'));
  await assert.rejects(startup, /spawn failed/);
  fs.rmSync(directory, { recursive: true, force: true });
  console.log('background host tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
