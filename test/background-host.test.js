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
  store.enqueueJob({ kind: 'workflow.resume', payload: { workflowId: workflow.workflowId }, runAt: Date.now(), dedupeKey: 'background-fixture' });
  store.enqueueJob({ kind: 'assistant.digest', payload: {}, runAt: Date.now(), dedupeKey: 'background-digest' });
  store.close();

  const liveStore = new SqliteStore({ filename: databasePath });
  let jobs = 0;
  const host = new BackgroundHost({ databasePath, onJob: async (kind, payload) => { if (kind === 'workflow.resume') return new WorkflowService({ store: liveStore }).resume(payload.workflowId); if (kind === 'assistant.digest') jobs += 1; } });
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
    probe.close();
    if (current.state === 'needs_attention' && jobs === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(current.state, 'needs_attention');
  assert.equal(jobs, 1);
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
