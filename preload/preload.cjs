const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aggregator', {
  getBrowserInfo: () => ipcRenderer.invoke('aggregator:getBrowserInfo'),
  launchBrowser: () => ipcRenderer.invoke('aggregator:launchBrowser'),
  checkSessions: () => ipcRenderer.invoke('aggregator:checkSessions'),
  focusModel: (model) => ipcRenderer.invoke('aggregator:focusModel', model),
  sendAll: (prompt) => ipcRenderer.invoke('aggregator:sendAll', prompt),
  sendOne: (model, prompt) => ipcRenderer.invoke('aggregator:sendOne', model, prompt),
  synthesize: (request) => ipcRenderer.invoke('aggregator:synthesize', request),
  copyText: (text) => ipcRenderer.invoke('aggregator:copyText', text),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getZenConnection: () => ipcRenderer.invoke('aggregator:getZenConnection'),
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('aggregator:event', handler)
    return () => ipcRenderer.removeListener('aggregator:event', handler)
  },
})
