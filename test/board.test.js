const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Board } = require('../board');

function post(port, query, body = '') {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: `/hook?${query}`, method: 'POST' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

function waitFor(board, predicate) {
  return new Promise((resolve) => {
    const check = () => {
      if (predicate()) {
        board.removeListener('change', check);
        resolve();
      }
    };
    board.on('change', check);
    check();
  });
}

(async () => {
  let pendingQuestions = [];
  const port = 4750 + Math.floor(Math.random() * 100);
  const board = new Board({
    historyProvider: (session) => ({ session: { key: session.key }, pairs: [{ prompt: 'hello', output: 'hi' }], count: 1, pendingQuestions }),
  });
  await board.listen(port);

  await post(port, 'state=done', JSON.stringify({ session_id: 's1', cwd: '/tmp/project' }));
  await waitFor(board, () => board.list().some((s) => s.key === 's1'));
  assert.strictEqual(board.list()[0].key, 's1');
  assert.strictEqual(board.list()[0].state, 'done');
  assert.strictEqual(board.list()[0].project, 'project');

  await post(port, 'state=working&tile=tile-1', JSON.stringify({ session_id: 's1', cwd: '/tmp/other' }));
  await waitFor(board, () => board.list().some((s) => s.key === 'tile-1'));
  assert.strictEqual(board.list().find((s) => s.key === 'tile-1').sessionId, 's1');

  const sessionIndex = await get(port, '/api/sessions');
  assert.strictEqual(sessionIndex.status, 200);
  assert.match(sessionIndex.body.sessions.find((s) => s.key === 'tile-1').historyUrl, /tile-1\/history$/);
  const history = await get(port, '/api/sessions/tile-1/history');
  assert.strictEqual(history.status, 200);
  assert.deepStrictEqual(history.body.pairs[0], { prompt: 'hello', output: 'hi' });

  const before = board.list().find((s) => s.key === 'tile-1').since;
  await post(port, 'state=working&tile=tile-1', '{bad json');
  assert.strictEqual(board.list().find((s) => s.key === 'tile-1').since, before);

  await post(port, 'state=closed', JSON.stringify({ session_id: 's1' }));
  await waitFor(board, () => !board.list().some((s) => s.key === 's1'));
  assert.ok(!board.list().some((s) => s.key === 's1'));

  board.register('owned', '/tmp/owned');
  await post(port, 'state=working&tile=owned', JSON.stringify({ session_id: 's2', cwd: '/tmp/owned' }));
  await waitFor(board, () => board.list().find((s) => s.key === 'owned').state === 'working');
  pendingQuestions = [{ question: 'Choose an option.' }];
  await post(port, 'state=approval&tile=owned', JSON.stringify({ session_id: 's2', cwd: '/tmp/owned' }));
  await waitFor(board, () => board.list().find((s) => s.key === 'owned').state === 'approval');
  const repeatedApproval = new Promise((resolve) => board.once('change', resolve));
  await post(port, 'state=approval&tile=owned', JSON.stringify({ session_id: 's2', cwd: '/tmp/owned' }));
  assert.deepStrictEqual(await repeatedApproval, { key: 'owned', state: 'approval', repeated: true });
  await post(port, 'state=done&tile=owned', JSON.stringify({ session_id: 's2', cwd: '/tmp/owned' }));
  assert.strictEqual(board.list().find((s) => s.key === 'owned').state, 'approval');
  pendingQuestions = [];
  assert.strictEqual(board.completePendingDone('owned'), true);
  await waitFor(board, () => board.list().find((s) => s.key === 'owned').state === 'done');
  await post(port, 'state=working&tile=owned', JSON.stringify({ session_id: 's2', cwd: '/tmp/owned' }));
  await waitFor(board, () => board.list().find((s) => s.key === 'owned').state === 'working');
  await post(port, 'state=closed&tile=owned', JSON.stringify({ session_id: 's2' }));
  await waitFor(board, () => board.list().find((s) => s.key === 'owned').state === null);
  assert.strictEqual(board.list().find((s) => s.key === 'owned').state, null);

  assert.strictEqual(await post(port, 'state=working', ''), 200);
  await board.closeServer();

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-test-'));
  const storagePath = path.join(temporaryDirectory, 'sessions.json');
  const persistentBoard = new Board({ storagePath });
  persistentBoard.register('persisted', '/tmp/persisted', 'claude');
  persistentBoard.handleHook('working', 'persisted', { session_id: 'saved-id', cwd: '/tmp/persisted' });
  persistentBoard.handleHook('working', 'persisted', { session_id: 'updated-id', cwd: '/tmp/persisted' });
  assert.strictEqual(new Board({ storagePath }).list()[0].sessionId, 'updated-id');
  fs.rmSync(temporaryDirectory, { recursive: true });

  console.log('board tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
