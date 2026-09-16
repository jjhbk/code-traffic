const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createReplyProposal({ to, subject, body, threadId, inReplyTo = null, references = null } = {}) {
  const recipientInput = String(to || '').trim();
  const recipient = recipientInput.match(/<([^>]+)>/)?.[1]?.trim() || recipientInput;
  const cleanSubject = String(subject || '').replace(/[\r\n]/g, ' ').trim();
  const cleanBody = String(body || '').trim();
  if (!EMAIL.test(recipient)) throw new Error('Enter a valid recipient email address.');
  if (!cleanSubject) throw new Error('A reply subject is required.');
  if (!cleanBody) throw new Error('A reply body is required.');
  if (!threadId) throw new Error('This task is missing its Gmail thread.');
  return {
    capability: 'gmail.send',
    autonomous: false,
    destination: recipient,
    content: { subject: cleanSubject, body: cleanBody },
    threadId: String(threadId),
    inReplyTo: inReplyTo ? String(inReplyTo) : null,
    references: references ? String(references) : null,
    consequences: 'Send one email reply from the connected Gmail account.',
    options: [{ optionId: 'send', label: 'Send this reply' }, { optionId: 'deny', label: 'Cancel' }],
  };
}

module.exports = { createReplyProposal };
