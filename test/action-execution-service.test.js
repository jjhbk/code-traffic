const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { ApprovalService } = require('../host/approvals/service');
const { ActionRegistry } = require('../host/actions/registry');
const { ActionExecutionService } = require('../host/actions/execution-service');

(async () => {
  const store = new SqliteStore();
  const registry = new ActionRegistry();
  const approvals = new ApprovalService({ store, registry, clock: () => 1000 });
  const sent = [];
  const execution = new ActionExecutionService({
    store,
    approvals,
    registry,
    providers: {
      gmail: async () => ({
        sendReply: async (action) => { sent.push(action); return { id: 'msg-1', threadId: action.threadId }; },
        reconcileReply: async () => ({ found: false }),
      }),
    },
    clock: () => 1000,
  });
  const request = approvals.request({ capability: 'gmail.send', destination: 'alex@example.com', threadId: 'thread-1', content: { subject: 'Re: Handoff', body: 'Checking in.' } }, { principal: 'signal-box-user', surfaces: ['mobile'], expiresAt: Date.now() + 10_000 });
  const result = await execution.executeApproved(request.request_id, { principal: 'signal-box-user', surface: 'mobile' });
  assert.equal(result.status, 'confirmed');
  assert.equal(sent.length, 1);
  assert.equal(store.getExecutionAttempts(request.request_id)[0].status, 'confirmed');
  assert.equal(store.getReceipt(result.receiptRef.receiptId).receipt.messageId, 'msg-1');
  await assert.rejects(() => execution.executeApproved(request.request_id, { principal: 'signal-box-user', surface: 'mobile' }), /already resolved|already been consumed/);

  const callbackStore = new SqliteStore();
  const callbackApprovals = new ApprovalService({ store: callbackStore });
  const callbackRequest = callbackApprovals.request({ capability: 'gmail.send', destination: 'alex@example.com', threadId: 'thread-callback', content: { subject: 'Re: Callback', body: 'Sent.' } }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 10_000 });
  const callbackErrors = [];
  const callbackExecution = new ActionExecutionService({
    store: callbackStore,
    approvals: callbackApprovals,
    providers: { gmail: async () => ({ sendReply: async () => ({ id: 'msg-callback', threadId: 'thread-callback' }) }) },
    onConfirmed: () => { throw new Error('workflow bookkeeping failed'); },
    onPostCommitError: ({ error }) => { callbackErrors.push(error.message); },
  });
  const callbackResult = await callbackExecution.executeApproved(callbackRequest.request_id, { principal: 'signal-box-user', surface: 'desktop' });
  assert.equal(callbackResult.status, 'confirmed');
  assert.deepEqual(callbackErrors, ['workflow bookkeeping failed']);
  assert.equal(callbackStore.getExecutionAttempts(callbackRequest.request_id)[0].status, 'confirmed');

  const unknownApprovals = new ApprovalService({ store: new SqliteStore(), registry, clock: () => 1000 });
  const unknownStore = unknownApprovals.store;
  const unknownExecution = new ActionExecutionService({ store: unknownStore, approvals: unknownApprovals, registry, providers: { gmail: async () => ({ sendReply: async () => { throw new Error('network timeout'); } }) } });
  const unknownRequest = unknownApprovals.request({ capability: 'gmail.send', destination: 'alex@example.com', threadId: 'thread-2', content: { subject: 'Re: Review', body: 'Checking.' } }, { principal: 'signal-box-user', surfaces: ['desktop'], expiresAt: Date.now() + 10_000 });
  await assert.rejects(() => unknownExecution.executeApproved(unknownRequest.request_id, { principal: 'signal-box-user', surface: 'desktop' }), (error) => error.code === 'EXECUTION_UNKNOWN');
  assert.equal(unknownStore.getExecutionAttempts(unknownRequest.request_id)[0].status, 'unknown');
  store.close(); callbackStore.close(); unknownStore.close();
  console.log('action execution service tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
