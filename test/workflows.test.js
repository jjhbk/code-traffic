const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { WorkflowService } = require('../host/workflows/service');

const store = new SqliteStore();
const workflow = new WorkflowService({ store });
const started = workflow.start({ workflowType: 'follow-up', payload: { draft: 'Hello' } });
workflow.setStep(started.workflowId, { stepId: 'draft', stepIndex: 0, state: 'completed', details: { reviewed: false } });
assert.equal(workflow.transition(started.workflowId, 'awaiting_approval').state, 'awaiting_approval');
const job = workflow.scheduleResume(started.workflowId, Date.now() + 1000);
assert.equal(job.kind, 'workflow.resume');
assert.equal(store.getWorkflow(started.workflowId).steps[0].details.reviewed, false);
workflow.transition(started.workflowId, 'completed');
assert.throws(() => workflow.transition(started.workflowId, 'ready'), /Completed workflows/);
const waiting = workflow.start({ workflowType: 'follow-up', payload: {}, state: 'waiting_event' });
assert.equal(workflow.resume(waiting.workflowId).state, 'needs_attention');
assert.ok(store.exportData().data.workflows.length === 2);
store.close();
console.log('workflow tests passed');
