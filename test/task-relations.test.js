const assert = require('node:assert/strict');
const { SqliteStore } = require('../host/store/sqlite-store');

const store = new SqliteStore();
const add = (id, summary) => store.saveTaskCandidate({ candidateId: id, observationId: `obs-${id}`, summary, evidence: { start: 0, end: 1, text: summary }, extractorVersion: 'test' });
add('task-a', 'Prepare proposal');
add('task-b', 'Get pricing');
store.addTaskRelation('task-a', 'task-b', 'depends_on', { reason: 'pricing is required' });
assert.deepEqual(store.taskRelations('task-a')[0].details, { reason: 'pricing is required' });
assert.throws(() => store.addTaskRelation('task-b', 'task-a', 'depends_on'), /cycle/);
const graph = store.taskGraph();
assert.ok(graph.edges.some((edge) => edge.type === 'depends_on' && edge.from === 'task:task-a' && edge.to === 'task:task-b'));
assert.throws(() => store.addTaskRelation('task-a', 'missing', 'depends_on'), /Both related tasks/);
assert.ok(store.exportData().data.task_relations.length === 1);
store.close();
console.log('task relation tests passed');
