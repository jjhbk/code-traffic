const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  formatHistoryPairs,
  parseClaudeHistory,
  parseClaudeQuestions,
  parseCodexHistory,
  parseCodexQuestions,
  questionsFromText,
} = require('../history');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-history-'));
const codexFile = path.join(directory, 'codex.jsonl');
const claudeFile = path.join(directory, 'claude.jsonl');

fs.writeFileSync(codexFile, [
  { timestamp: '2026-01-01', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Build it' }] } } },
  { timestamp: '2026-01-01', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'Built.' }] } } },
  { timestamp: '2026-01-01', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'resolved', arguments: JSON.stringify({ questions: [{ id: 'old', question: 'Old question?', options: [{ label: 'Old answer' }] }] }) } },
  { timestamp: '2026-01-01', type: 'response_item', payload: { type: 'function_call_output', call_id: 'resolved', output: 'answered' } },
  { timestamp: '2026-01-01', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'pending', arguments: JSON.stringify({ questions: [{ id: 'runtime', header: 'Runtime', question: 'Which runtime should be used?', options: [{ label: 'Hybrid', description: 'Use local and remote workers.' }, { label: 'Local', description: 'Stay on this machine.' }] }] }) } },
].map(JSON.stringify).join('\n'));

fs.writeFileSync(claudeFile, [
  { timestamp: '2026-01-01', type: 'user', uuid: 'u1', message: { content: 'Fix it' } },
  { timestamp: '2026-01-01', type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Fixed.' }] } },
  { timestamp: '2026-01-01', type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'old-question', name: 'AskUserQuestion', input: { questions: [{ header: 'Old', question: 'Resolved?', options: [{ label: 'Yes' }] }] } }] } },
  { timestamp: '2026-01-01', type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'old-question', content: 'Answered' }] } },
  { timestamp: '2026-01-01', type: 'assistant', uuid: 'a3', message: { content: [{ type: 'tool_use', id: 'pending-question', name: 'AskUserQuestion', input: { questions: [{ header: 'Deploy', question: 'Where should this deploy?', multiSelect: false, options: [{ label: 'Staging', description: 'Deploy to staging.' }, { label: 'Production', description: 'Deploy to production.' }] }] } }] } },
].map(JSON.stringify).join('\n'));

assert.deepStrictEqual(parseCodexHistory(codexFile)[0], { prompt: 'Build it', output: 'Built.', timestamp: '2026-01-01' });
assert.deepStrictEqual(parseClaudeHistory(claudeFile)[0], { prompt: 'Fix it', output: 'Fixed.', timestamp: '2026-01-01' });
assert.deepStrictEqual(parseClaudeQuestions(claudeFile), [{
  id: null,
  header: 'Deploy',
  question: 'Where should this deploy?',
  multiSelect: false,
  options: [
    { label: 'Staging', description: 'Deploy to staging.' },
    { label: 'Production', description: 'Deploy to production.' },
  ],
}]);
assert.match(formatHistoryPairs(parseCodexHistory(codexFile)), /Input:\nBuild it\n\nOutput:\nBuilt\./);
assert.deepStrictEqual(parseCodexQuestions(codexFile), [{
  id: 'runtime',
  header: 'Runtime',
  question: 'Which runtime should be used?',
  options: [
    { label: 'Hybrid', description: 'Use local and remote workers.' },
    { label: 'Local', description: 'Stay on this machine.' },
  ],
}]);
assert.deepStrictEqual(questionsFromText('How should this run?\n1. Fast\n2. Safely'), [{
  header: '',
  question: 'How should this run?',
  options: [{ label: 'Fast', description: '' }, { label: 'Safely', description: '' }],
}]);

fs.rmSync(directory, { recursive: true });
console.log('history tests passed');
