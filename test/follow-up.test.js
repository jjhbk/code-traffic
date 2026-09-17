const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { WorkflowService } = require('../host/workflows/service');
const { FollowUpWorkflow } = require('../host/workflows/follow-up');

const store = new SqliteStore();
const approvals = new ApprovalService({ store });
const workflows = new WorkflowService({ store });
const followUp = new FollowUpWorkflow({ store, approvals, workflows });
store.saveTaskCandidate({ candidateId: 'task-1', observationId: 'obs-1', summary: 'Handoff', counterparty: 'alex@example.com', threadId: 'thread-1', evidence: { start: 0, end: 1, text: 'Handoff' }, extractorVersion: 'test' });
const result = followUp.prepare({ taskId: 'task-1', status: 'active', summary: 'Handoff', counterparty: 'alex@example.com', threadId: 'thread-1', updatedAt: 42 }, { body: 'Checking on the handoff.' });
assert.equal(result.workflow.state, 'awaiting_approval');
assert.equal(result.approval.action.capability, 'gmail.send');
assert.equal(result.approval.action.workflowId, result.workflow.workflowId);
assert.equal(result.workflow.payload.requestId, result.approval.request_id || result.approval.requestId);
store.updateWorkflow(result.workflow.workflowId, { state: 'waiting_event', payload: { ...result.workflow.payload, threadId: 'thread-1', sentAt: Date.parse('2026-09-17T10:00:00Z') } });
const verifying = followUp.observeReplies([
  { observationId: 'old-reply', threadId: 'thread-1', direction: 'incoming', timestamp: '2026-09-17T09:59:00Z', body: 'An older message.' },
  { observationId: 'reply-1', threadId: 'thread-1', direction: 'incoming', timestamp: '2026-09-17T10:01:00Z', body: 'The handoff is ready.' },
]);
assert.equal(verifying[0].state, 'verifying');
assert.equal(verifying[0].payload.responseObservationId, 'reply-1');
assert.equal(followUp.observeReplies([{ observationId: 'old-only', threadId: 'thread-1', direction: 'incoming', timestamp: '2026-09-17T09:59:30Z', body: 'Still old.' }]).length, 0);
const completed = followUp.reconcileReply(result.workflow.workflowId, { resolved: true, reason: 'reply-confirmed' });
assert.equal(completed.state, 'completed');
assert.equal(store.listTasks({ includeDismissed: true }).find((task) => task.taskId === 'task-1').status, 'done');
store.saveTaskCandidate({ candidateId: 'task-2', observationId: 'obs-2', summary: 'Review', counterparty: 'alex@example.com', threadId: 'thread-2', evidence: { start: 0, end: 1, text: 'Review' }, extractorVersion: 'test' });
const uncertainWorkflow = followUp.prepare({ taskId: 'task-2', status: 'active', summary: 'Review', counterparty: 'alex@example.com', threadId: 'thread-2' }, { body: 'Checking on the review.' });
store.updateWorkflow(uncertainWorkflow.workflow.workflowId, { state: 'waiting_event', payload: { ...uncertainWorkflow.workflow.payload, sentAt: 1000 } });
followUp.observeReplies([{ observationId: 'reply-2', threadId: 'thread-2', direction: 'incoming', timestamp: 1100, body: 'I will look tomorrow.' }]);
assert.equal(followUp.reconcileReply(uncertainWorkflow.workflow.workflowId, { resolved: false, reason: 'reply-needs-user-confirmation' }).state, 'needs_attention');
assert.throws(() => followUp.prepare({ taskId: 'task-2', status: 'done', counterparty: 'alex@example.com', threadId: 'thread-2' }, { body: 'No' }), /active tasks/);
followUp.cancel(result.workflow.workflowId);
assert.equal(store.getWorkflow(result.workflow.workflowId).state, 'cancelled');
store.close();
console.log('follow-up workflow tests passed');
