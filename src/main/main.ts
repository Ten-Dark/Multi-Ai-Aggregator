import { app, BrowserWindow, Menu } from 'electron'
import { createWindow, getMainWindow } from './window.js'
import { ZenBridge } from './zen/bridge.js'
import { registerAggregatorIpc } from './ipc.js'
import { BrowserDiscoveryService } from './browser/browser-discovery.js'
import type { AggregatorEvent } from '../shared/types.js'

app.setName('Multi-AI Aggregator')

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  let aggregator: ZenBridge | null = null
  const browserDiscovery = new BrowserDiscoveryService()
  let quitting = false

  const emit = (event: AggregatorEvent): void => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send('aggregator:event', event)
  }

  app.on('second-instance', () => {
    const window = getMainWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null)

      aggregator = new ZenBridge(app.getPath('userData'), emit)
      try {
        await aggregator.start()
      } catch (error) {
        console.error('[aggregator] Zen bridge startup failed:', error)
      }

      registerAggregatorIpc(
        () => {
          if (!aggregator) throw new Error('Приложение ещё не готово.')
          return aggregator
        },
        browserDiscovery,
      )

      const window = createWindow()

      window.webContents.once('did-finish-load', () => {
        setTimeout(() => {
          if (!window.isDestroyed()) window.focus()
        }, 2500)
      })

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow()
        }
      })
    })
    .catch((error: unknown) => {
      console.error('[aggregator] Initialization failed:', error)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const instance = aggregator
    if (!instance) {
      app.quit()
      return
    }
    void instance.close().finally(() => app.quit())
  })

  process.on('uncaughtException', (error) => {
    console.error('[main] Uncaught exception:', error)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[main] Unhandled rejection:', reason)
  })
}
