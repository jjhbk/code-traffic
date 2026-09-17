const { SqliteStore } = require('../store/sqlite-store');
const { AssistantRuntime } = require('./assistant');
const { WorkflowService } = require('../workflows/service');

const token = process.env.SIGNAL_BOX_BACKGROUND_TOKEN || '';
const databasePath = process.argv[2];
if (!databasePath || !token || typeof process.send !== 'function') throw new Error('Background host requires a database path, token, and IPC parent.');

const store = new SqliteStore({ filename: databasePath });
const runtime = new AssistantRuntime({ store, workerId: `background-${process.pid}`, kinds: ['workflow.resume'] });
runtime.register('workflow.resume', async ({ workflowId }) => {
  if (workflowId) new WorkflowService({ store }).resume(workflowId);
});
runtime.start();

function reply(id, result, error = null) {
  if (process.connected) process.send({ type: 'response', id, result, error: error ? error.message : null });
}

process.on('message', (message) => {
  if (!message || message.token !== token || !message.id) return;
  try {
    if (message.method === 'health') reply(message.id, runtime.health());
    else if (message.method === 'pause') reply(message.id, runtime.setPaused(message.paused));
    else if (message.method === 'shutdown') {
      runtime.stop(); store.close(); reply(message.id, { stopped: true });
      setImmediate(() => process.exit(0));
    } else reply(message.id, null, new Error('Unknown background host method.'));
  } catch (error) { reply(message.id, null, error); }
});

process.on('disconnect', () => { runtime.stop(); store.close(); process.exit(0); });
process.send({ type: 'ready', health: runtime.health() });
