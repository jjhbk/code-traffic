const assert = require('assert');
const http = require('http');
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
  const port = 4750 + Math.floor(Math.random() * 100);
  const board = new Board();
  await board.listen(port);

  await post(port, 'state=done', JSON.stringify({ session_id: 's1', cwd: '/tmp/project' }));
  await waitFor(board, () => board.list().some((s) => s.key === 's1'));
  assert.strictEqual(board.list()[0].key, 's1');
  assert.strictEqual(board.list()[0].state, 'done');
  assert.strictEqual(board.list()[0].project, 'project');

  await post(port, 'state=working&tile=tile-1', JSON.stringify({ session_id: 's1', cwd: '/tmp/other' }));
  await waitFor(board, () => board.list().some((s) => s.key === 'tile-1'));
  assert.strictEqual(board.list().find((s) => s.key === 'tile-1').sessionId, 's1');

  const before = board.list().find((s) => s.key === 'tile-1').since;
  await post(port, 'state=working&tile=tile-1', '{bad json');
  assert.strictEqual(board.list().find((s) => s.key === 'tile-1').since, before);

  await post(port, 'state=closed', JSON.stringify({ session_id: 's1' }));
  await waitFor(board, () => board.list().find((s) => s.key === 's1')?.state === null);
  assert.strictEqual(board.list().find((s) => s.key === 's1')?.state, null);
  assert.ok(!board.list().some((s) => s.key === 's1'));

  board.register('owned', '/tmp/owned');
  await post(port, 'state=working&tile=owned', JSON.stringify({ session_id: 's2', cwd: '/tmp/owned' }));
  await waitFor(board, () => board.list().find((s) => s.key === 'owned').state === 'working');
  await post(port, 'state=closed&tile=owned', JSON.stringify({ session_id: 's2' }));
  await waitFor(board, () => board.list().find((s) => s.key === 'owned').state === null);
  assert.strictEqual(board.list().find((s) => s.key === 'owned').state, null);

  assert.strictEqual(await post(port, 'state=working', ''), 200);
  await board.closeServer();
  console.log('board tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
