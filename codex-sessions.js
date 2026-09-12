const fs = require('fs');
const os = require('os');
const path = require('path');

function sessionsDirectory() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

function sessionFiles(directory = sessionsDirectory()) {
  const files = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { files.push({ path: target, modified: fs.statSync(target).mtimeMs }); } catch (_) { /* Session may disappear during cleanup. */ }
      }
    }
  }
  return files.sort((a, b) => b.modified - a.modified);
}

function sessionMetadata(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString('utf8', 0, bytes).split('\n', 1)[0];
    const record = JSON.parse(firstLine);
    if (record?.type !== 'session_meta' || !record.payload) return null;
    return {
      id: record.payload.session_id || record.payload.id || null,
      cwd: record.payload.cwd || '',
    };
  } catch (_) {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { /* Best-effort read cleanup. */ }
    }
  }
}

const resolvedFiles = new Map();

function matchesDirectory(actual, requested) {
  if (!requested || actual === requested) return true;
  try { return fs.realpathSync(actual) === fs.realpathSync(requested); }
  catch (_) { return false; }
}

function findCodexSession(candidate, cwd, directory = sessionsDirectory()) {
  if (!candidate || candidate.startsWith('codex:')) return null;
  const cacheKey = `${directory}\0${candidate}`;
  const cached = resolvedFiles.get(cacheKey);
  if (cached && fs.existsSync(cached.path)) {
    return matchesDirectory(cached.cwd, cwd) ? { ...cached } : null;
  }
  resolvedFiles.delete(cacheKey);
  for (const file of sessionFiles(directory)) {
    const metadata = sessionMetadata(file.path);
    if (!metadata?.id) continue;
    const session = { ...metadata, path: file.path };
    if (metadata.id === candidate && matchesDirectory(metadata.cwd, cwd)) {
      if (resolvedFiles.size >= 256) resolvedFiles.delete(resolvedFiles.keys().next().value);
      resolvedFiles.set(cacheKey, session);
      return { ...session };
    }
  }
  return null;
}

function resolveCodexSessionId(candidate, cwd, directory = sessionsDirectory()) {
  return findCodexSession(candidate, cwd, directory)?.id || null;
}

module.exports = { findCodexSession, resolveCodexSessionId, sessionMetadata };
