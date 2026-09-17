const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signalBox', {
  environment: { wsl: Boolean(process.env.WSL_INTEROP) },
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  openBrowserExtensionFolder: () => ipcRenderer.invoke('browser:open-extension-folder'),
  openBrowserExtensionManager: () => ipcRenderer.invoke('browser:open-extension-manager'),
  getBrowserPairing: () => ipcRenderer.invoke('browser:get-pairing'),
  getBrowserStatus: () => ipcRenderer.invoke('browser:get-status'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  listArchivedSessions: () => ipcRenderer.invoke('sessions:archived-list'),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  getTaskGraph: () => ipcRenderer.invoke('tasks:graph'),
  getAssistantDecisions: () => ipcRenderer.invoke('assistant:decisions'),
  getAssistantConversation: () => ipcRenderer.invoke('assistant:conversation'),
  sendAssistantMessage: (payload) => ipcRenderer.invoke('assistant:send', payload),
  getAssistantStatus: () => ipcRenderer.invoke('assistant:status'),
  getAssistantWorkflows: () => ipcRenderer.invoke('assistant:workflows'),
  getAssistantContext: () => ipcRenderer.invoke('assistant:context'),
  getActivity: () => ipcRenderer.invoke('activity:list'),
  updateTask: (payload) => ipcRenderer.invoke('tasks:update', payload),
  snoozeTask: (payload) => ipcRenderer.invoke('tasks:snooze', payload),
  suppressCounterparty: (payload) => ipcRenderer.invoke('tasks:suppress-counterparty', payload),
  listSuppressions: () => ipcRenderer.invoke('tasks:list-suppressions'),
  removeSuppression: (payload) => ipcRenderer.invoke('tasks:remove-suppression', payload),
  correctTask: (payload) => ipcRenderer.invoke('tasks:correct', payload),
  getDigestSettings: () => ipcRenderer.invoke('digest:get-settings'),
  saveDigestSettings: (payload) => ipcRenderer.invoke('digest:save-settings', payload),
  exportData: () => ipcRenderer.invoke('data:export'),
  deleteMailData: () => ipcRenderer.invoke('data:delete-mail'),
  getModelStatus: () => ipcRenderer.invoke('model:get-status'),
  getModelSettings: () => ipcRenderer.invoke('model:get-settings'),
  saveModelSettings: (payload) => ipcRenderer.invoke('model:save-settings', payload),
  checkModel: () => ipcRenderer.invoke('model:check'),
  getModelDiagnostics: () => ipcRenderer.invoke('model:diagnostics'),
  probeLocalModel: () => ipcRenderer.invoke('model:probe'),
  getIntegrationStatus: () => ipcRenderer.invoke('integrations:status'),
  prepareUberBooking: (payload) => ipcRenderer.invoke('browser:prepare-uber', payload),
  decideBrowserAction: (payload) => ipcRenderer.invoke('browser:decide', payload),
  executeBrowserAction: (payload) => ipcRenderer.invoke('browser:execute', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  getMailStatus: () => ipcRenderer.invoke('mail:status'),
  pairMail: (payload) => ipcRenderer.invoke('mail:pair', payload),
  disconnectMail: () => ipcRenderer.invoke('mail:disconnect'),
  syncMail: () => ipcRenderer.invoke('mail:sync'),
  listMailMessages: () => ipcRenderer.invoke('mail:messages'),
  proposeReply: (payload) => ipcRenderer.invoke('mail:propose-reply', payload),
  sendApprovedReply: (payload) => ipcRenderer.invoke('mail:send-approved-reply', payload),
  reconcileReply: (payload) => ipcRenderer.invoke('mail:reconcile-reply', payload),
  syncCalendar: () => ipcRenderer.invoke('calendar:sync'),
  getCalendarStatus: () => ipcRenderer.invoke('calendar:status'),
  listCalendarEvents: () => ipcRenderer.invoke('calendar:events'),
  prepareCalendarUpdate: (payload) => ipcRenderer.invoke('calendar:prepare-update', payload),
  executeCalendarUpdate: (payload) => ipcRenderer.invoke('calendar:execute-update', payload),
  onCalendarStatusChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('calendar:status-changed', listener);
    return () => ipcRenderer.removeListener('calendar:status-changed', listener);
  },
  syncDrive: () => ipcRenderer.invoke('drive:sync'),
  getDriveStatus: () => ipcRenderer.invoke('drive:status'),
  listDriveFiles: () => ipcRenderer.invoke('drive:files'),
  onDriveStatusChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('drive:status-changed', listener);
    return () => ipcRenderer.removeListener('drive:status-changed', listener);
  },
  onMailStatusChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mail:status-changed', listener);
    return () => ipcRenderer.removeListener('mail:status-changed', listener);
  },
  onMailPairProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('mail:pair-progress', listener);
    return () => ipcRenderer.removeListener('mail:pair-progress', listener);
  },
  onSessionsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('sessions:changed', listener);
    return () => ipcRenderer.removeListener('sessions:changed', listener);
  },
  createSession: (payload) => ipcRenderer.invoke('session:create', payload),
  openSession: (payload) => ipcRenderer.invoke('session:open', payload),
  closeSession: (payload) => ipcRenderer.invoke('session:close', payload),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  onPtyData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },
  writePty: (payload) => ipcRenderer.send('pty:write', payload),
  markWorking: (payload) => ipcRenderer.send('session:working', payload),
  resizePty: (payload) => ipcRenderer.send('pty:resize', payload),
});
