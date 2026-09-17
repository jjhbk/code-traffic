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
store.updateWorkflow(result.workflow.workflowId, { state: 'waiting_event', payload: { ...result.workflow.payload, threadId: 'thread-1', sentAt: 1000 } });
const verifying = followUp.observeReplies([
  { observationId: 'old-reply', threadId: 'thread-1', direction: 'incoming', timestamp: 900, body: 'An older message.' },
  { observationId: 'reply-1', threadId: 'thread-1', direction: 'incoming', timestamp: 1100, body: 'The handoff is ready.' },
]);
assert.equal(verifying[0].state, 'verifying');
assert.equal(verifying[0].payload.responseObservationId, 'reply-1');
assert.equal(followUp.observeReplies([{ observationId: 'old-only', threadId: 'thread-1', direction: 'incoming', timestamp: 950, body: 'Still old.' }]).length, 0);
assert.throws(() => followUp.prepare({ taskId: 'task-2', status: 'done', counterparty: 'alex@example.com', threadId: 'thread-2' }, { body: 'No' }), /active tasks/);
followUp.cancel(result.workflow.workflowId);
assert.equal(store.getWorkflow(result.workflow.workflowId).state, 'cancelled');
store.close();
console.log('follow-up workflow tests passed');
