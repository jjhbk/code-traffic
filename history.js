const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCodexSession } = require('./codex-sessions');

function textFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (typeof part === 'string') return [part];
    const type = String(part?.type || '').toLowerCase();
    if (type === 'text' || type === 'input_text' || type === 'output_text') return [part.text || ''];
    return [];
  }).join('\n').trim();
}

function pairMessages(messages) {
  const pairs = [];
  let current = null;
  for (const message of messages) {
    if (!message.text) continue;
    if (message.role === 'user') {
      if (current) pairs.push(current);
      current = { prompt: message.text, output: '', timestamp: message.timestamp || null };
    } else if (message.role === 'assistant' && current) {
      current.output = [current.output, message.text].filter(Boolean).join('\n');
    }
  }
  if (current) pairs.push(current);
  return pairs;
}

function parseCodexHistory(file) {
  const messages = [];
  for (const line of readLines(file)) {
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    const payload = record.payload || {};
    if (record.type !== 'event_msg') continue;
    if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') {
      messages.push({ role: 'user', text: textFromContent(payload.item.content), timestamp: record.timestamp });
    } else if (payload.type === 'item_completed' && payload.item?.type === 'AgentMessage' && payload.item.phase === 'final_answer') {
      messages.push({ role: 'assistant', text: textFromContent(payload.item.content), timestamp: record.timestamp });
    } else if (payload.type === 'user_message') {
      messages.push({ role: 'user', text: String(payload.message || '').trim(), timestamp: record.timestamp });
    } else if (payload.type === 'agent_message') {
      messages.push({ role: 'assistant', text: String(payload.message || '').trim(), timestamp: record.timestamp });
    }
  }
  return pairMessages(messages);
}

function parseCodexQuestions(file) {
  const pending = new Map();
  for (const line of readLines(file)) {
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    const payload = record.payload || {};
    if (record.type === 'response_item' && payload.type === 'function_call' && payload.name === 'request_user_input') {
      try {
        const input = JSON.parse(payload.arguments || '{}');
        const questions = Array.isArray(input.questions) ? input.questions : [];
        pending.set(payload.call_id, questions.map((question) => ({
          id: question.id || null,
          header: question.header || '',
          question: question.question || '',
          options: Array.isArray(question.options) ? question.options.map((option) => ({
            label: option.label || '',
            description: option.description || '',
          })).filter((option) => option.label) : [],
        })).filter((question) => question.question));
      } catch (_) { /* Ignore malformed tool arguments. */ }
    } else if (record.type === 'response_item' && payload.type === 'function_call_output') {
      pending.delete(payload.call_id);
    }
  }
  return [...pending.values()].at(-1) || [];
}

function questionsFromText(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const options = lines.flatMap((line) => {
    const match = line.match(/^(?:[-*] |\d+[.)]\s+|[A-Z][.)]\s+)(.+)$/);
    return match ? [{ label: match[1].trim(), description: '' }] : [];
  });
  const questionLine = [...lines].reverse().find((line) => line.includes('?'));
  if (!questionLine && !options.length) return [];
  return [{ header: '', question: questionLine || lines[0], options }];
}

function claudeSessionFile(sessionId, cwd) {
  if (!sessionId) return null;
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const project = cwd.replace(/[\\/]/g, '-');
  const candidate = path.join(claudeHome, 'projects', project, `${sessionId}.jsonl`);
  return fs.existsSync(candidate) ? candidate : null;
}

function parseClaudeHistory(file) {
  const messages = [];
  const seen = new Set();
  for (const line of readLines(file)) {
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    if (!['user', 'assistant'].includes(record.type) || seen.has(record.uuid)) continue;
    if (record.uuid) seen.add(record.uuid);
    const text = textFromContent(record.message?.content);
    if (text) messages.push({ role: record.type, text, timestamp: record.timestamp });
  }
  return pairMessages(messages);
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; }
}

function sessionHistory(session) {
  if (!session) return { session: null, pairs: [] };
  let source = null;
  let sessionId = session.sessionId || null;
  let pairs = [];
  let pendingQuestions = [];
  if (session.agent === 'codex') {
    const found = findCodexSession(sessionId, session.cwd);
    if (found) {
      source = found.path;
      sessionId = found.id;
      pairs = parseCodexHistory(found.path);
      pendingQuestions = parseCodexQuestions(found.path);
    }
  } else {
    source = claudeSessionFile(sessionId, session.cwd);
    if (source) pairs = parseClaudeHistory(source);
  }
  if (session.state === 'approval' && !pendingQuestions.length) {
    pendingQuestions = questionsFromText(pairs.at(-1)?.output);
  }
  return {
    session: {
      key: session.key,
      sessionId,
      agent: session.agent || 'claude',
      project: session.project,
      path: session.path,
      state: session.state,
    },
    pairs,
    pendingQuestions,
    count: pairs.length,
    sourceAvailable: Boolean(source),
  };
}

function formatHistoryPairs(pairs, count = 3) {
  const selected = pairs.slice(-Math.max(1, count));
  if (!selected.length) return 'No prompt/response history is available yet.';
  return selected.map((pair, index) => {
    const number = pairs.length - selected.length + index + 1;
    return `#${number}\nInput:\n${pair.prompt}\n\nOutput:\n${pair.output || '(waiting for response)'}`;
  }).join('\n\n───\n\n');
}

module.exports = {
  claudeSessionFile,
  formatHistoryPairs,
  pairMessages,
  parseClaudeHistory,
  parseCodexHistory,
  parseCodexQuestions,
  questionsFromText,
  sessionHistory,
  textFromContent,
};
