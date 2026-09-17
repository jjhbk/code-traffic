async function replanTask({ store, proactivity, taskId, reason = 'state-changed' } = {}) {
  if (!store || !proactivity || !taskId) return { skipped: true };
  const task = store.listTasks({ includeDismissed: true }).find((item) => item.taskId === taskId);
  if (!task) return { skipped: true, reason: 'task-not-found' };
  const decisions = proactivity.evaluateAsync
    ? await proactivity.evaluateAsync([task], { context: store.listContext() })
    : proactivity.evaluate([task]);
  const decision = decisions[0];
  if (!decision || decision.type === 'wait') return { taskId, decision: decision?.type || 'wait', notified: false };
  const cleanReason = String(reason || 'state-changed').replaceAll('-', ' ');
  const notification = store.enqueueNotification({
    notificationId: `assistant-replan:${taskId}:${task.updatedAt}:${decision.type}`,
    dateKey: `assistant-replan:${taskId}:${task.updatedAt}:${decision.type}`,
    notificationClass: 'assistant-replan',
    items: [{ taskId, summary: task.summary, reason: `The obligation changed (${cleanReason}); it now needs a fresh decision.`, decision: { type: decision.type, reason: decision.reason, evidence: decision.evidence || [] } }],
  });
  return { taskId, decision: decision.type, notified: Boolean(notification) };
}

module.exports = { replanTask };
