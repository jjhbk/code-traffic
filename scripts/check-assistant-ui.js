// Run with Electron. Tests the real renderer against synthetic data, without
// starting connectors, session processes, or the user's assistant database.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.whenReady().then(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-box-ui-'));
  const win = new BrowserWindow({ width: 1360, height: 960, show: true, webPreferences: { preload: path.join(__dirname, 'ui-preview-preload.js'), contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, detail) => { if (detail.level === 'error') errors.push(detail.message); });
  await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  const run = (script) => win.webContents.executeJavaScript(script);
  await run("new Promise(resolve => setTimeout(resolve, 250))");
  assert.equal(await run("document.getElementById('assistant-view').hidden"), false);
  assert.equal(await run("document.getElementById('board').hidden"), true);
  assert.equal(await run("document.getElementById('assistant-decisions').textContent.includes('Review the launch brief')"), true);
  assert.equal(await run("getComputedStyle(document.body).cursor"), 'none');
  assert.equal(await run("document.documentElement.classList.contains('software-cursor-enabled')"), true);
  assert.equal(await run("getComputedStyle(document.getElementById('software-cursor')).pointerEvents"), 'none');
  assert.notEqual(await run("getComputedStyle(document.getElementById('assistant-input')).caretColor"), 'rgba(0, 0, 0, 0)', 'Assistant input caret must remain visible');
  assert.equal(await run("new Set([...document.querySelectorAll('[id]')].map(el => el.id)).size === document.querySelectorAll('[id]').length"), true, 'Unique control IDs');
  fs.writeFileSync(path.join(output, 'desktop.png'), (await win.webContents.capturePage()).toPNG());
  await run("document.querySelector('[data-prompt]').click(); document.getElementById('assistant-form').requestSubmit(); new Promise(resolve => setTimeout(resolve, 100))");
  assert.equal(await run("document.querySelectorAll('#assistant-history article').length"), 2);
  await run("document.getElementById('assistant-pause').click(); new Promise(resolve => setTimeout(resolve, 100))");
  assert.equal(await run("document.getElementById('assistant-health').textContent"), 'Assistant paused');
  await run("document.getElementById('sessions-toggle').click()");
  assert.equal(await run("document.getElementById('board').hidden"), false);
  assert.equal(await run("document.getElementById('assistant-view').hidden"), true);
  for (const [button, view] of [['tasks-toggle', 'tasks-view'], ['graph-toggle', 'graph-view'], ['activity-toggle', 'activity-view'], ['mail-toggle', 'mail-view'], ['calendar-toggle', 'calendar-view'], ['drive-toggle', 'drive-view']]) {
    await run(`document.getElementById('${button}').click(); new Promise(resolve => setTimeout(resolve, 75))`);
    assert.equal(await run(`document.getElementById('${view}').hidden`), false);
    assert.equal(await run("[...document.querySelectorAll('.tasks-view')].filter(el => !el.hidden).length"), 1);
    assert.equal(await run("document.getElementById('error').hidden"), true);
    if (view === 'tasks-view') {
      await run("document.getElementById('workspace-search').value = 'missing fixture'; document.getElementById('workspace-search').dispatchEvent(new Event('input'))");
      assert.equal(await run("document.getElementById('search-empty').hidden"), false);
      await run("document.getElementById('workspace-search').value = 'launch'; document.getElementById('workspace-search').dispatchEvent(new Event('input'))");
      assert.equal(await run("document.querySelector('#tasks-view .task-card').hidden"), false);
    }
    fs.writeFileSync(path.join(output, `${view}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await run("document.querySelector('.sidebar-settings').open = true; document.getElementById('model-settings').click(); new Promise(resolve => setTimeout(resolve, 100))");
  assert.equal(await run("document.getElementById('model-modal').hidden"), false);
  assert.equal(await run("document.getElementById('model-modal').contains(document.activeElement)"), true);
  fs.writeFileSync(path.join(output, 'settings.png'), (await win.webContents.capturePage()).toPNG());
  await run("document.getElementById('close-model').click()");
  await run("new Promise(resolve => setTimeout(resolve, 50))");
  assert.equal(await run("document.getElementById('model-modal').hidden"), true);
  await run("document.querySelector('.sidebar-settings').open = false");
  await run("document.getElementById('assistant-toggle').click(); new Promise(resolve => setTimeout(resolve, 100))");
  for (const width of [760, 620, 390]) {
    win.setSize(width, 900);
    await run('new Promise(resolve => setTimeout(resolve, 100))');
    const overflow = await run('document.documentElement.scrollWidth > innerWidth || document.querySelector(".shell").scrollWidth > document.querySelector(".shell").clientWidth');
    assert.equal(overflow, false, `Horizontal overflow at ${width}px`);
    fs.writeFileSync(path.join(output, `width-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(errors, []);
  console.log(`Assistant UI smoke check passed. Screenshots: ${output}`);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
