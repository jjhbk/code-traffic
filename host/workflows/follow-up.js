const { createReplyProposal } = require('../actions/mail-reply');

class FollowUpWorkflow {
  constructor({ store, approvals, workflows, clock = () => Date.now() } = {}) {
    if (!store || !approvals || !workflows) throw new Error('Follow-up workflow requires store, approvals, and workflow services.');
    this.store = store;
    this.approvals = approvals;
    this.workflows = workflows;
    this.clock = clock;
  }

  prepare(task, { subject = null, body, principal = 'signal-box-user', surfaces = ['desktop', 'telegram'], expiresAt = this.clock() + 10 * 60 * 1000 } = {}) {
    if (!task?.taskId || task.status !== 'active') throw new Error('Only active tasks can receive a follow-up.');
    const action = createReplyProposal({
      to: task.counterparty,
      subject: subject || (String(task.summary || '').startsWith('Re:') ? task.summary : `Re: ${task.summary || 'Follow up'}`),
      body,
      threadId: task.threadId,
    });
    const workflow = this.workflows.start({
      workflowType: 'gmail-follow-up',
      taskId: task.taskId,
      state: 'awaiting_approval',
      payload: { threadId: task.threadId, taskVersion: task.updatedAt || null, draft: action.content },
    });
    const approval = this.approvals.request({ ...action, taskId: task.taskId, taskVersion: task.updatedAt || null, workflowId: workflow.workflowId }, { principal, surfaces, expiresAt });
    const updated = this.store.updateWorkflow(workflow.workflowId, { state: 'awaiting_approval', payload: { ...workflow.payload, requestId: approval.request_id || approval.requestId, actionDigest: approval.action_digest || approval.actionDigest } });
    return { workflow: updated, approval };
  }

  cancel(workflowId, reason = 'user-cancelled') {
    return this.workflows.transition(workflowId, 'cancelled', { reason });
  }

  observeReplies(observations = []) {
    const waiting = this.store.listWorkflows({ activeOnly: true }).filter((workflow) => workflow.workflowType === 'gmail-follow-up' && workflow.state === 'waiting_event');
    const changed = [];
    const awaitingApproval = this.store.listWorkflows({ activeOnly: true }).filter((workflow) => workflow.workflowType === 'gmail-follow-up' && workflow.state === 'awaiting_approval');
    for (const workflow of awaitingApproval) {
      const reply = observations.find((observation) => observation.threadId === workflow.payload.threadId
        && observation.direction === 'incoming'
        && observationTime(observation.timestamp || observation.internalDate || observation.createdAt) > Number(workflow.createdAt || 0));
      if (!reply) continue;
      if (workflow.payload.requestId) this.approvals.cancel(workflow.payload.requestId, 'newer-thread-evidence');
      changed.push(this.store.updateWorkflow(workflow.workflowId, {
        state: 'needs_attention',
        payload: { ...workflow.payload, invalidatedByObservationId: reply.observationId, invalidationReason: 'newer-thread-evidence' },
        details: { responseObservationId: reply.observationId, reason: 'approval-invalidated' },
      }));
    }
    for (const workflow of waiting) {
      const sentAt = Number(workflow.payload.sentAt || 0);
      const reply = observations.find((observation) => {
        if (observation.threadId !== workflow.payload.threadId || observation.direction !== 'incoming') return false;
        if (!sentAt) return true;
        const observedAt = observationTime(observation.timestamp || observation.internalDate || observation.createdAt);
        return observedAt > sentAt;
      });
      if (!reply) continue;
      changed.push(this.store.updateWorkflow(workflow.workflowId, {
        state: 'verifying',
        payload: { ...workflow.payload, responseObservationId: reply.observationId, responseEvidence: reply.body || reply.subject || null },
        details: { responseObservationId: reply.observationId },
      }));
    }
    return changed;
  }

  reconcileReply(workflowId, { resolved, reason, evidence = null } = {}) {
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow || workflow.workflowType !== 'gmail-follow-up' || workflow.state !== 'verifying') throw new Error('A follow-up must be verifying before its reply can be reconciled.');
    const responseEvidence = evidence || workflow.payload.responseEvidence || null;
    const payload = { ...workflow.payload, resolution: resolved ? 'resolved' : 'uncertain', resolutionReason: reason || null };
    if (resolved) {
      if (workflow.taskId) this.store.setTaskStatus(workflow.taskId, 'done', { workflowId, responseObservationId: workflow.payload.responseObservationId, evidence: responseEvidence, reason: reason || 'reply-confirmed' });
      return this.store.updateWorkflow(workflowId, { state: 'completed', payload, details: { responseObservationId: workflow.payload.responseObservationId, reason: reason || 'reply-confirmed' } });
    }
    return this.store.updateWorkflow(workflowId, { state: 'needs_attention', payload, details: { responseObservationId: workflow.payload.responseObservationId, reason: reason || 'reply-needs-review' } });
  }

  reconcileReplies(observations = []) {
    const changed = this.observeReplies(observations);
    return changed.map((workflow) => this.reconcileReply(workflow.workflowId, classifyReply(workflow.payload.responseEvidence)));
  }
}

function observationTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function classifyReply(body) {
  const text = String(body || '').trim();
  const resolved = /\b(done|complete(?:d)?|finished|ready|sent|attached|taken care of|handled|resolved)\b/i.test(text);
  return { resolved, reason: resolved ? 'resolution-signal' : 'reply-needs-user-confirmation', evidence: text || null };
}

module.exports = { FollowUpWorkflow };
