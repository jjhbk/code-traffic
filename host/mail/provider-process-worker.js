const { GoogleProviderHost } = require('./provider-host');

const token = process.env.SIGNAL_BOX_PROVIDER_TOKEN || '';
const parentPort = process.parentPort || null;
const send = (message) => parentPort ? parentPort.postMessage(message) : process.send(message);
const listen = (handler) => parentPort ? parentPort.on('message', handler) : process.on('message', handler);
if (!token || (typeof process.send !== 'function' && !parentPort)) throw new Error('Google provider process requires authenticated IPC.');

let values = {};
const credentials = { load: (name) => values[name] || null };
const host = new GoogleProviderHost({ credentialStore: credentials });

function reply(id, result, error = null) { send({ type: 'response', id, result, error: error ? error.message : null }); }

listen(async (message) => {
  if (!message || message.token !== token || !message.id) return;
  try {
    if (message.method === 'set-credentials') {
      values = message.credentials && typeof message.credentials === 'object' ? { ...message.credentials } : {};
      host.clear();
      reply(message.id, { updated: true });
    } else if (message.method === 'health') reply(message.id, { running: true, account: host.account() });
    else if (message.method === 'shutdown') { reply(message.id, { stopped: true }); setImmediate(() => process.exit(0)); }
    else if (message.kind === 'connector.gmail.fetch') reply(message.id, await host.provider('gmail').sync(message.payload || {}));
    else if (message.kind === 'connector.calendar.fetch') reply(message.id, await host.provider('calendar').sync(message.payload || {}));
    else if (message.kind === 'connector.drive.fetch') reply(message.id, await host.provider('drive').sync(message.payload || {}));
    else reply(message.id, null, new Error('Unsupported Google provider request.'));
  } catch (error) { reply(message.id, null, error); }
});

send({ type: 'ready' });
