const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');
const { TaskService } = require('../host/tasks/service');

const store = new SqliteStore();
const source = { observationId: 'structured-1', messageId: 'structured-1', threadId: 'structured-thread', subject: 'Launch', body: 'I will send the contract by Friday.', direction: 'outgoing', provider: 'gmail', to: ['client@example.com'] };
store.saveObservation(source, 'gmail:me@example.com');
const service = new TaskService({
  store,
  modelRouter: {
    async extractObligations() {
      return { version: 'structured-test', obligations: [{ summary: 'Send the contract', owner: 'self', blocker: 'counterparty', counterparty: 'client@example.com', dueDate: 'friday', dueDateBasis: 'message-text', confidence: 'high', evidenceText: 'I will send the contract by Friday.', evidenceStart: 7, evidenceEnd: 42 }] };
    },
  },
});
(async () => {
  const tasks = await service.processAllAsync('gmail:me@example.com');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].extractorVersion, 'structured-test');
  assert.equal(tasks[0].confidence, 'high');
  store.close();
  console.log('structured extraction tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
