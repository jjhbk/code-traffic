const ALLOWED_ORIGINS = new Set(['https://m.uber.com']);
const DEFAULT_HOST_URL = 'http://127.0.0.1:4747';

function hostUrl(value) {
  try {
    const url = new URL(value || DEFAULT_HOST_URL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid loopback host');
    return url.origin;
  } catch (_) { return DEFAULT_HOST_URL; }
}

function allowedUrl(value) {
  try { return ALLOWED_ORIGINS.has(new URL(value).origin); } catch (_) { return false; }
}

async function performStep(tab, step) {
  if (step.kind === 'navigate') {
    if (!allowedUrl(step.url)) throw new Error('Navigation target is not allowlisted.');
    await chrome.tabs.update(tab.id, { url: step.url });
    return { navigated: step.url };
  }
  const result = await chrome.tabs.sendMessage(tab.id, { channel: 'signal-box', step });
  if (!result?.ok) throw new Error(result?.error || 'The browser content script rejected the step.');
  return result.result;
}

function stepMatchesTab(tab, request) {
  const currentOrigin = tab?.url ? new URL(tab.url).origin : '';
  if (request.step.kind === 'navigate') return true;
  return currentOrigin === request.origin && ALLOWED_ORIGINS.has(currentOrigin);
}

async function pollHost(tab, sessionId) {
  const origin = tab?.url ? new URL(tab.url).origin : '';
  const config = await chrome.storage.local.get(['signalBoxToken', 'signalBoxHost']);
  if (!config.signalBoxToken || !sessionId) return;
  const base = hostUrl(config.signalBoxHost);
  const response = await fetch(`${base}/browser/next?sessionId=${encodeURIComponent(sessionId)}`, { headers: { 'X-Signal-Box-Token': config.signalBoxToken } });
  if (!response.ok) return;
  const body = await response.json();
  if (!body.request) return;
  if (body.request.origin !== ALLOWED_ORIGINS.values().next().value || !stepMatchesTab(tab, body.request)) {
    await fetch(`${base}/browser/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signal-Box-Token': config.signalBoxToken }, body: JSON.stringify({ requestId: body.request.requestId, sessionId, origin, error: 'The browser tab is no longer on the recipe origin.' }) });
    return;
  }
  performStep(tab, body.request.step).then(async (result) => {
    await fetch(`${base}/browser/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signal-Box-Token': config.signalBoxToken }, body: JSON.stringify({ requestId: body.request.requestId, sessionId, origin, result }) });
  }).catch(async (error) => {
    await fetch(`${base}/browser/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signal-Box-Token': config.signalBoxToken }, body: JSON.stringify({ requestId: body.request.requestId, sessionId, origin, error: error.message }) });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const origin = sender.tab?.url ? new URL(sender.tab.url).origin : '';
  if (!ALLOWED_ORIGINS.has(origin) || !['signal-box', 'signal-box-poll'].includes(message?.channel)) {
    sendResponse({ ok: false, error: 'Origin or channel is not allowed.' });
    return false;
  }
  if (message.channel === 'signal-box-poll') { pollHost(sender.tab, message.sessionId).catch(() => {}); sendResponse({ ok: true }); return false; }
  chrome.tabs.sendMessage(sender.tab.id, message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
