const { SqliteStore } = require('../store/sqlite-store');
const { AssistantRuntime } = require('./assistant');
const { WorkflowService } = require('../workflows/service');

const token = process.env.SIGNAL_BOX_BACKGROUND_TOKEN || '';
const databasePath = process.argv[2];
const parentPort = process.parentPort || null;
const send = (message) => parentPort ? parentPort.postMessage(message) : process.send(message);
const listen = (handler) => parentPort ? parentPort.on('message', handler) : process.on('message', handler);
if (!databasePath || !token || (typeof process.send !== 'function' && !parentPort)) throw new Error('Background host requires a database path, token, and IPC parent.');

const store = new SqliteStore({ filename: databasePath });
const parentCalls = new Map();
let parentSequence = 0;
function callParent(kind, payload) {
  const id = `background-job-${++parentSequence}`;
  return new Promise((resolve, reject) => {
    parentCalls.set(id, { resolve, reject });
    send({ type: 'job', id, token, kind, payload });
  });
}
const runtime = new AssistantRuntime({ store, workerId: `background-${process.pid}`, kinds: ['workflow.resume', 'assistant.sync.gmail', 'assistant.sync.calendar', 'assistant.sync.drive', 'assistant.digest'], paused: process.env.SIGNAL_BOX_BACKGROUND_PAUSED === '1' });
runtime.register('workflow.resume', async ({ workflowId }) => {
  if (workflowId) new WorkflowService({ store }).resume(workflowId);
});
for (const [kind, intervalMs] of [['assistant.sync.gmail', 5 * 60 * 1000], ['assistant.sync.calendar', 5 * 60 * 1000], ['assistant.sync.drive', 10 * 60 * 1000], ['assistant.digest', 30 * 1000]]) {
  runtime.register(kind, async (payload) => {
    await callParent(kind, payload);
    runtime.schedule(kind, {}, Date.now() + intervalMs, `${kind}:${Math.floor((Date.now() + intervalMs) / intervalMs)}`);
  });
}
runtime.start();
for (const [kind, intervalMs] of [['assistant.sync.gmail', 5 * 60 * 1000], ['assistant.sync.calendar', 5 * 60 * 1000], ['assistant.sync.drive', 10 * 60 * 1000], ['assistant.digest', 30 * 1000]]) {
  runtime.schedule(kind, {}, Date.now(), `${kind}:${Math.floor(Date.now() / intervalMs)}`);
}

function reply(id, result, error = null) {
  send({ type: 'response', id, result, error: error ? error.message : null });
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
