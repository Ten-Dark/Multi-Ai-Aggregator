import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const handlers = new Map()
const calls = []
const win = { isDestroyed: () => false, webContents: { getURL: () => 'http://localhost:5173/' } }
const electron = { app: { isPackaged: false }, clipboard: { writeText: (v) => calls.push(['copy', v]) }, ipcMain: { handle: (c, h) => handlers.set(c, h) } }
const load = Module._load
Module._load = function(id, parent, main) {
  if (id === 'electron') return electron
  if (id === './window.js' && parent?.filename.endsWith('ipc.js')) return { getMainWindow: () => win }
  return load.call(this, id, parent, main)
}
let register
try { register = require('../dist-electron/main/ipc.js').registerAggregatorIpc }
finally { Module._load = load }
const bridge = {
  getBrowserInfo: () => ({}), getZenConnection: () => ({}), openBrowser: () => calls.push(['open']),
  checkSessions: () => [], focusModel: (m) => calls.push(['focus', m]),
  sendAll: (p) => calls.push(['all', p]), sendOne: (m, p) => calls.push(['one', m, p]),
  synthesize: (r) => calls.push(['synth', r]),
}
register(() => bridge)
const event = { sender: win.webContents, senderFrame: { parent: null, url: 'http://localhost:5173/' } }
const invoke = (channel, ...args) => handlers.get(channel)(event, ...args)

test('rejects invalid model and prompt payloads without side effects', async () => {
  const n = calls.length
  await assert.rejects(invoke('aggregator:focusModel', 'invalid'))
  await assert.rejects(invoke('aggregator:sendAll', ' '))
  await assert.rejects(invoke('aggregator:sendAll', 'x'.repeat(300001)))
  await assert.rejects(invoke('aggregator:sendOne', 'chatgpt', null))
  await assert.rejects(invoke('aggregator:sendOne', 'invalid', 'prompt'))
  assert.equal(calls.length, n)
})

test('rejects malformed synthesis payloads without side effects', async () => {
  const n = calls.length
  for (const value of [null, {}, { model: 'invalid', prompt: 'x', answers: [{ model: 'qwen' }] },
    { model: 'chatgpt', prompt: 'x', answers: [] },
    { model: 'chatgpt', prompt: 'x', answers: [{ model: 'qwen' }, { model: 'qwen' }] },
    { model: 'chatgpt', prompt: 'x', answers: [{ model: 'qwen', text: 42 }] }]) {
    await assert.rejects(invoke('aggregator:synthesize', value))
  }
  assert.equal(calls.length, n)
})

test('rejects untrusted frames and accepts valid requests', async () => {
  const n = calls.length
  await assert.rejects(handlers.get('aggregator:launchBrowser')({ ...event, senderFrame: { parent: {}, url: event.senderFrame.url } }))
  assert.equal(calls.length, n)
  await invoke('aggregator:focusModel', 'chatgpt')
  await invoke('aggregator:sendOne', 'qwen', 'prompt')
  await invoke('aggregator:synthesize', { model: 'deepseek', prompt: 'q', answers: [{ model: 'chatgpt', text: 'a' }] })
  assert.equal(calls.length, n + 3)
})
