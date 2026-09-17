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
    for (const workflow of waiting) {
      const sentAt = Number(workflow.payload.sentAt || 0);
      const reply = observations.find((observation) => {
        if (observation.threadId !== workflow.payload.threadId || observation.direction !== 'incoming') return false;
        if (!sentAt) return true;
        const observedAt = Number(observation.timestamp || observation.internalDate || observation.createdAt || 0);
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
}

module.exports = { FollowUpWorkflow };
