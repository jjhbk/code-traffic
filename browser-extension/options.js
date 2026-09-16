const token = document.getElementById('token');
const session = document.getElementById('session');
const host = document.getElementById('host');
const status = document.getElementById('status');
chrome.storage.local.get(['signalBoxToken', 'signalBoxSession', 'signalBoxHost']).then((value) => { token.value = value.signalBoxToken || ''; session.value = value.signalBoxSession || ''; host.value = value.signalBoxHost || host.value; });
document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ signalBoxToken: token.value.trim(), signalBoxSession: session.value.trim(), signalBoxHost: host.value.trim() });
  status.textContent = ' Saved';
});
