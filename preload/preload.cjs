const { contextBridge, ipcRenderer } = require('electron')

const MODEL_IDS = new Set(['chatgpt', 'qwen', 'deepseek'])
const SESSION_STATUSES = new Set([
  'unknown', 'checking', 'logged-in', 'guest', 'login-required',
  'manual-action', 'blocked', 'error',
])
const TASK_STATUSES = new Set(['idle', 'queued', 'opening', 'sending', 'waiting', 'cancelling', 'done', 'error', 'cancelled'])
const ERROR_CODES = new Set(['cancelled', 'login', 'manual', 'blocked', 'timeout', 'busy', 'browser', 'site', 'unknown'])
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isTaskId(value) {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAggregatorEvent(value) {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  if (value.type === 'browser') {
    const browser = value.browser
    return isRecord(browser) &&
      ['stopped', 'starting', 'running', 'error'].includes(browser.status) &&
      (browser.browserName === undefined || typeof browser.browserName === 'string') &&
      (browser.message === undefined || typeof browser.message === 'string')
  }

  if (value.type === 'session') {
    const session = value.session
    return isRecord(session) && MODEL_IDS.has(session.model) &&
      SESSION_STATUSES.has(session.status) && typeof session.message === 'string' &&
      (session.url === undefined || typeof session.url === 'string')
  }

  if (value.type === 'model') {
    const result = value.result
    return isRecord(result) && MODEL_IDS.has(result.model) &&
      TASK_STATUSES.has(result.status) && Number.isFinite(result.updatedAt) &&
      (result.taskId === undefined || isTaskId(result.taskId)) &&
      (result.batchId === undefined || isTaskId(result.batchId)) &&
      (result.text === undefined || typeof result.text === 'string') &&
      (result.error === undefined || typeof result.error === 'string') &&
      (result.errorCode === undefined || ERROR_CODES.has(result.errorCode)) &&
      (result.partial === undefined || typeof result.partial === 'boolean')
  }

  if (value.type === 'zen-connection') {
    const connection = value.connection
    return isRecord(connection) && typeof connection.pairingCode === 'string' &&
      typeof connection.wsUrl === 'string' && typeof connection.connected === 'boolean' &&
      (connection.extensionVersion === undefined || typeof connection.extensionVersion === 'string') &&
      (connection.activeConnectorId === undefined || typeof connection.activeConnectorId === 'string') &&
      (connection.providerConnectors === undefined || (isRecord(connection.providerConnectors) &&
        ['chatgpt', 'qwen', 'deepseek'].every((model) => connection.providerConnectors[model] === null || typeof connection.providerConnectors[model] === 'string'))) &&
      (connection.connectors === undefined || (Array.isArray(connection.connectors) && connection.connectors.every((connector) =>
        isRecord(connector) && typeof connector.instanceId === 'string' &&
        typeof connector.browserName === 'string' && typeof connector.browserVersion === 'string' &&
        typeof connector.extensionVersion === 'string' && Number.isFinite(connector.connectedAt) &&
        Number.isFinite(connector.lastHeartbeatAt) && typeof connector.active === 'boolean')))
  }

  return false
}

contextBridge.exposeInMainWorld('aggregator', {
  getBrowserInfo: () => ipcRenderer.invoke('aggregator:getBrowserInfo'),
  getBrowserDiscovery: () => ipcRenderer.invoke('aggregator:getBrowserDiscovery'),
  launchBrowser: () => ipcRenderer.invoke('aggregator:launchBrowser'),
  checkSessions: () => ipcRenderer.invoke('aggregator:checkSessions'),
  focusModel: (model) => ipcRenderer.invoke('aggregator:focusModel', model),
  sendAll: (prompt) => ipcRenderer.invoke('aggregator:sendAll', prompt),
  sendOne: (model, prompt) => ipcRenderer.invoke('aggregator:sendOne', model, prompt),
  cancelTask: (taskId) => ipcRenderer.invoke('aggregator:cancelTask', taskId),
  cancelBatch: (batchId) => ipcRenderer.invoke('aggregator:cancelBatch', batchId),
  synthesize: (request) => ipcRenderer.invoke('aggregator:synthesize', request),
  copyText: (text) => ipcRenderer.invoke('aggregator:copyText', text),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkAppUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  downloadAppUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
  getZenConnection: () => ipcRenderer.invoke('aggregator:getZenConnection'),
  setActiveConnector: (instanceId) => ipcRenderer.invoke('aggregator:setActiveConnector', instanceId),
  setProviderConnector: (model, instanceId) => ipcRenderer.invoke('aggregator:setProviderConnector', model, instanceId),
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, payload) => {
      if (!isAggregatorEvent(payload)) return
      callback(payload)
    }
    ipcRenderer.on('aggregator:event', handler)
    return () => ipcRenderer.removeListener('aggregator:event', handler)
  },
})
