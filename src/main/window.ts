import { app, BrowserWindow } from 'electron'
import path from 'node:path'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    title: 'Multi-AI Aggregator',
    backgroundColor: '#f4f6f9',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), 'preload', 'preload.cjs'),
    },
  })

  mainWindow = window

  window.once('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[main] Renderer failed to load: ${description} (${code}) ${url}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] Renderer process gone:', details.reason)
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}
