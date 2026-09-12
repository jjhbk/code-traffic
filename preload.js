const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signalBox', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  listArchivedSessions: () => ipcRenderer.invoke('sessions:archived-list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
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
