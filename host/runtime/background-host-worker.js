const { SqliteStore } = require('../store/sqlite-store');
const { AssistantRuntime } = require('./assistant');
const { MobilePushService } = require('../mobile/push');
const { ProactivityService } = require('../proactivity/service');
const { replanTask } = require('../proactivity/replan');
const { TaskService } = require('../tasks/service');
const { WorkflowService } = require('../workflows/service');
const { MeetingPrepWorkflow } = require('../workflows/meeting-prep');
const { FollowUpWorkflow } = require('../workflows/follow-up');
const { ApprovalService } = require('../approvals/service');
const { RemoteProvider } = require('../mail/remote-provider');
const { MailSync } = require('../mail/sync');
const { DigestScheduler } = require('../scheduling/digest');

const token = process.env.SIGNAL_BOX_BACKGROUND_TOKEN || '';
const databasePath = process.argv[2];
const parentPort = process.parentPort || null;
const send = (message) => parentPort ? parentPort.postMessage(message) : process.send(message);
const listen = (handler) => parentPort ? parentPort.on('message', handler) : process.on('message', handler);
if (!databasePath || !token || (typeof process.send !== 'function' && !parentPort)) throw new Error('Background host requires a database path, token, and IPC parent.');

const store = new SqliteStore({ filename: databasePath });
const mobilePushService = new MobilePushService({ store });
const proactivity = new ProactivityService({ store });
const taskService = new TaskService({ store });
const workflows = new WorkflowService({ store });
const meetingPrep = new MeetingPrepWorkflow({ store, workflows });
let digestSettings = {};
try { digestSettings = JSON.parse(process.env.SIGNAL_BOX_DIGEST_SETTINGS || '{}'); } catch (_) { digestSettings = {}; }
let connectorAccounts = {};
try { connectorAccounts = JSON.parse(process.env.SIGNAL_BOX_CONNECTOR_ACCOUNTS || '{}'); } catch (_) { connectorAccounts = {}; }
const approvals = new ApprovalService({ store });
const followUp = new FollowUpWorkflow({ store, approvals, workflows });
const digestScheduler = new DigestScheduler({ store, timeZone: digestSettings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone, dailyCap: Number(digestSettings.dailyCap) || 5, digestAt: digestSettings.digestAt || '08:30', cadenceMinutes: Number(digestSettings.cadenceMinutes) || 60, quietStart: digestSettings.quietStart || null, quietEnd: digestSettings.quietEnd || null });
const parentCalls = new Map();
let parentSequence = 0;
function callParent(kind, payload) {
  const id = `background-job-${++parentSequence}`;
  return new Promise((resolve, reject) => {
    parentCalls.set(id, { resolve, reject });
    send({ type: 'job', id, token, kind, payload });
  });
}
const runtime = new AssistantRuntime({ store, workerId: `background-${process.pid}`, kinds: ['workflow.resume', 'browser.availability.check', 'meeting.prep', 'tasks.reconcile', 'assistant.replan', 'assistant.proactive-actions', 'assistant.reconcile-provider-run', 'assistant.sync.gmail', 'assistant.sync.calendar', 'assistant.sync.drive', 'assistant.digest.plan', 'assistant.mobile-push'], paused: process.env.SIGNAL_BOX_BACKGROUND_PAUSED === '1' });
runtime.register('workflow.resume', async (payload) => workflows.resume(payload.workflowId));
runtime.register('browser.availability.check', async (payload) => {
  delegate('browser.availability.check', payload);
});
runtime.register('meeting.prep', async (payload) => meetingPrep.prepare(payload.workflowId, { observations: store.observations() }));
runtime.register('tasks.reconcile', async (payload) => taskService.processAllAsync(payload.adapterId));
runtime.register('assistant.proactive-actions', async () => {
  const tasks = store.listTasks();
  const decisions = proactivity.evaluate(tasks).map((decision) => {
    const task = tasks.find((item) => item.taskId === decision.taskId);
    return { ...decision, taskVersion: task?.updatedAt || null };
  });
  proactivity.enqueueAttentionNotifications(tasks, decisions);
  delegate('assistant.proactive-actions', { decisions }, { nextKind: 'assistant.proactive-actions', intervalMs: 30 * 1000 });
  return { tasks: tasks.length, decisions: decisions.length, decisionsDelegated: true };
});
for (const [kind, providerKey, intervalMs] of [['assistant.sync.gmail', 'gmail', 5 * 60 * 1000], ['assistant.sync.calendar', 'calendar', 5 * 60 * 1000], ['assistant.sync.drive', 'drive', 10 * 60 * 1000]]) {
  runtime.register(kind, async (payload) => {
    return runConnectorSync(providerKey, payload, { nextKind: kind, intervalMs });
  });
}
runtime.register('assistant.replan', async (payload) => replanTask({ store, proactivity, taskId: payload.taskId, reason: payload.reason }));
runtime.register('assistant.reconcile-provider-run', async (payload) => {
  return delegate('assistant.reconcile-provider-run', payload);
});
runtime.register('assistant.digest.plan', runIndependent('assistant.digest.plan', () => planBackgroundDigest(), 30 * 1000));
runtime.register('assistant.mobile-push', runIndependent('assistant.mobile-push', () => mobilePushService.deliverPending(), 30 * 1000));
runtime.start();
for (const [kind, intervalMs] of [['assistant.proactive-actions', 30 * 1000], ['assistant.sync.gmail', 5 * 60 * 1000], ['assistant.sync.calendar', 5 * 60 * 1000], ['assistant.sync.drive', 10 * 60 * 1000], ['assistant.digest.plan', 30 * 1000], ['assistant.mobile-push', 30 * 1000]]) {
  runtime.schedule(kind, {}, Date.now(), `${kind}:${Math.floor(Date.now() / intervalMs)}`);
}

function reply(id, result, error = null) {
  send({ type: 'response', id, result, error: error ? error.message : null });
}

function planBackgroundDigest() {
  const tasks = store.listTasks();
  const decisions = proactivity.evaluate(tasks);
  proactivity.enqueueAttentionNotifications(tasks, decisions);
  const types = new Map(decisions.map((decision) => [decision.taskId, decision.type]));
  const actionable = tasks.filter((task) => types.get(task.taskId) !== 'wait');
  return digestScheduler.prepareScheduled(actionable, null);
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

async function runConnectorSync(providerKey, payload = {}, { nextKind, intervalMs }) {
  const account = connectorAccounts[providerKey];
  const adapterId = account ? `${providerKey}:${account}` : null;
  scheduleNext(nextKind, {}, intervalMs);
  if (!account) return { paired: false, provider: providerKey, reason: `${providerKey} is not connected.` };
  const provider = new RemoteProvider({ kind: `connector.${providerKey}.fetch`, request: callParent });
  const sync = new MailSync({ store, provider });
  try {
    const result = await sync.run({ adapterId, accountAddress: account, boundedWindow: providerKey === 'drive' ? 100 : undefined });
    const tasks = await taskService.processObservationsAsync(result.observations || []);
    let followUps = null;
    let meetingPrepResult = null;
    if (providerKey === 'gmail') followUps = followUp.reconcileReplies(store.observations(adapterId));
    if (providerKey === 'calendar') meetingPrepResult = meetingPrep.scheduleUpcoming(store.observations(adapterId), { sourceObservations: store.observations() });
    const syncResult = { ...result, taskCandidates: tasks.length, followUps: followUps?.length || 0, meetingPrep: meetingPrepResult };
    store.setConnectorHealth(adapterId, 'healthy', syncResult);
    return syncResult;
  } catch (error) {
    store.setConnectorHealth(adapterId, 'error', { message: error.message, code: error.code || null });
    throw error;
  }
}

function scheduleNext(kind, payload, intervalMs) {
  if (!kind || !Number.isFinite(intervalMs)) return;
  const nextRunAt = Date.now() + intervalMs;
  const nextKey = `${kind}:${Math.floor(nextRunAt / intervalMs)}`;
  try { runtime.schedule(kind, payload, nextRunAt, nextKey); }
  catch (error) {
    console.error(`[background] schedule ${kind} failed: ${error.message}`);
    scheduleLater(kind, payload, nextRunAt, nextKey, 250);
  }
}

function delegate(kind, payload, { nextKind = null, nextPayload = {}, intervalMs = null } = {}) {
  // Persist the next cadence before handing the current job to the Electron
  // process. The worker may exit while the parent call is in flight; the
  // cadence must not depend on that IPC round trip completing.
  scheduleNext(nextKind, nextPayload, intervalMs);
  // Let JobRunner complete the claimed scheduler row before the parent opens a
  // provider call. Failed delegates are re-enqueued.
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
    if (message.method === 'set-connector-accounts') {
      connectorAccounts = message.accounts && typeof message.accounts === 'object' ? message.accounts : {};
      reply(message.id, { updated: true });
    } else if (message.method === 'health') reply(message.id, runtime.health());
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
