const { SqliteStore } = require('../store/sqlite-store');
const { AssistantRuntime } = require('./assistant');
const { MobilePushService } = require('../mobile/push');

const token = process.env.SIGNAL_BOX_BACKGROUND_TOKEN || '';
const databasePath = process.argv[2];
const parentPort = process.parentPort || null;
const send = (message) => parentPort ? parentPort.postMessage(message) : process.send(message);
const listen = (handler) => parentPort ? parentPort.on('message', handler) : process.on('message', handler);
if (!databasePath || !token || (typeof process.send !== 'function' && !parentPort)) throw new Error('Background host requires a database path, token, and IPC parent.');

const store = new SqliteStore({ filename: databasePath });
const mobilePushService = new MobilePushService({ store });
const parentCalls = new Map();
let parentSequence = 0;
function callParent(kind, payload) {
  const id = `background-job-${++parentSequence}`;
  return new Promise((resolve, reject) => {
    parentCalls.set(id, { resolve, reject });
    send({ type: 'job', id, token, kind, payload });
  });
}
const runtime = new AssistantRuntime({ store, workerId: `background-${process.pid}`, kinds: ['workflow.resume', 'browser.availability.check', 'meeting.prep', 'tasks.reconcile', 'assistant.sync.gmail', 'assistant.sync.calendar', 'assistant.sync.drive', 'assistant.digest', 'assistant.mobile-push'], paused: process.env.SIGNAL_BOX_BACKGROUND_PAUSED === '1' });
runtime.register('workflow.resume', async (payload) => {
  delegate('workflow.resume', payload);
});
runtime.register('browser.availability.check', async (payload) => {
  delegate('browser.availability.check', payload);
});
runtime.register('meeting.prep', async (payload) => {
  delegate('meeting.prep', payload);
});
runtime.register('tasks.reconcile', async (payload) => {
  delegate('tasks.reconcile', payload);
});
for (const [kind, intervalMs] of [['assistant.sync.gmail', 5 * 60 * 1000], ['assistant.sync.calendar', 5 * 60 * 1000], ['assistant.sync.drive', 10 * 60 * 1000], ['assistant.digest', 30 * 1000]]) {
  runtime.register(kind, async (payload) => {
    delegate(kind, payload, { nextKind: kind, intervalMs });
  });
}
runtime.register('assistant.mobile-push', runIndependent('assistant.mobile-push', () => mobilePushService.deliverPending(), 30 * 1000));
runtime.start();
for (const [kind, intervalMs] of [['assistant.sync.gmail', 5 * 60 * 1000], ['assistant.sync.calendar', 5 * 60 * 1000], ['assistant.sync.drive', 10 * 60 * 1000], ['assistant.digest', 30 * 1000], ['assistant.mobile-push', 30 * 1000]]) {
  runtime.schedule(kind, {}, Date.now(), `${kind}:${Math.floor(Date.now() / intervalMs)}`);
}

function reply(id, result, error = null) {
  send({ type: 'response', id, result, error: error ? error.message : null });
}

function scheduleLater(kind, payload, runAt, dedupeKey, delayMs = 0) {
  const timer = setTimeout(() => {
    try { runtime.schedule(kind, payload, runAt, dedupeKey); }
    catch (error) {
      console.error(`[background] schedule ${kind} delayed: ${error.message}`);
      scheduleLater(kind, payload, runAt, dedupeKey, 250);
    }
  }, delayMs);
  timer.unref?.();
}

function delegate(kind, payload, { nextKind = null, nextPayload = {}, intervalMs = null } = {}) {
  // Persist the next cadence before handing the current job to the Electron
  // process. The worker may exit while the parent call is in flight; the
  // cadence must not depend on that IPC round trip completing.
  if (nextKind && Number.isFinite(intervalMs)) {
    const nextRunAt = Date.now() + intervalMs;
    const nextKey = `${nextKind}:${Math.floor(nextRunAt / intervalMs)}`;
    try { runtime.schedule(nextKind, nextPayload, nextRunAt, nextKey); }
    catch (error) {
      console.error(`[background] schedule ${nextKind} failed: ${error.message}`);
      scheduleLater(nextKind, nextPayload, nextRunAt, nextKey, 250);
    }
  }
  // Let JobRunner complete the claimed scheduler row before the parent opens a
  // write transaction on the shared database. The parent remains the only
  // owner of provider/workflow mutations; failed delegates are re-enqueued.
  setImmediate(async () => {
    try { await callParent(kind, payload); }
    catch (error) {
      console.error(`[background] ${kind} delegation failed: ${error.message}`);
      scheduleLater(kind, payload, Date.now() + 1000, `retry:${kind}:${payload.workflowId || Date.now()}`);
    }
  });
}

function runIndependent(kind, handler, intervalMs) {
  return async (payload) => {
    const nextRunAt = Date.now() + intervalMs;
    const nextKey = `${kind}:${Math.floor(nextRunAt / intervalMs)}`;
    try { runtime.schedule(kind, {}, nextRunAt, nextKey); }
    catch (error) {
      console.error(`[background] schedule ${kind} failed: ${error.message}`);
      scheduleLater(kind, {}, nextRunAt, nextKey, 250);
    }
    return handler(payload);
  };
}

listen((message) => {
  if (!message || message.token !== token || !message.id) return;
  try {
    if (message.type === 'job-response') {
      const pending = parentCalls.get(message.id);
      if (!pending) return;
      parentCalls.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      return;
    }
    if (message.method === 'health') reply(message.id, runtime.health());
    else if (message.method === 'pause') reply(message.id, runtime.setPaused(message.paused));
    else if (message.method === 'shutdown') {
      runtime.stop(); store.close(); reply(message.id, { stopped: true });
      setImmediate(() => process.exit(0));
    } else reply(message.id, null, new Error('Unknown background host method.'));
  } catch (error) { reply(message.id, null, error); }
});

if (parentPort) parentPort.on('close', () => { runtime.stop(); store.close(); process.exit(0); });
else process.on('disconnect', () => { runtime.stop(); store.close(); process.exit(0); });
send({ type: 'ready', health: runtime.health() });
