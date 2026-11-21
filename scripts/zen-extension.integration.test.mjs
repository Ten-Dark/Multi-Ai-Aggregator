import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = MockWebSocket.CONNECTING
    this.listeners = new Map()
    this.sent = []
    MockWebSocket.instances.push(this)
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || []
    callbacks.push(callback)
    this.listeners.set(type, callbacks)
  }

  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event)
  }

  send(value) {
    this.sent.push(JSON.parse(value))
  }

  close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED
    this.emit('close', { code, reason })
  }
}

function createExtensionHarness() {
  const values = new Map()
  let runtimeListener
  const statusWrites = []
  const browser = {
    runtime: {
      getManifest: () => ({ name: 'Multi-AI Aggregator Bridge', version: '0.3.0' }),
      getURL: (path) => `moz-extension://test/${path}`,
      onMessage: {
        addListener: (listener) => { runtimeListener = listener },
      },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: values.get(key) }),
        set: async (entries) => {
          for (const [key, value] of Object.entries(entries)) {
            values.set(key, value)
            if (key === 'maiStatus') statusWrites.push(value)
          }
        },
        remove: async (key) => { values.delete(key) },
      },
    },
    browserAction: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  }
  const source = readFileSync(new URL('../zen-extension/background.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    browser,
    WebSocket: MockWebSocket,
    URL,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false }),
    Date,
    Promise,
    Map,
    String,
    Boolean,
    Error,
    JSON,
  })
  return {
    dispatch: (message, sender = {}) => runtimeListener(message, sender),
    statusWrites,
    values,
  }
}

test('Zen extension never removes browser tabs and does not create tabs during session checks', () => {
  const source = readFileSync(new URL('../zen-extension/background.js', import.meta.url), 'utf8')
  assert.equal(source.includes('browser.tabs.remove('), false)
  assert.equal(source.includes('browser.windows.remove('), false)
  const sessionCheck = source.split("if (action === 'checkSessions') {")[1]?.split("if (action === 'send') {")[0] || ''
  assert.ok(sessionCheck.includes('getTabsState()'))
  assert.equal(sessionCheck.includes('ensureTabs()'), false)
})
test('Zen extension pairs, authenticates and forwards progress over the bridge', async () => {
  MockWebSocket.instances = []
  const harness = createExtensionHarness()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const pairingCode = 'ws://127.0.0.1:45123|integration-secret'

  const pairingResult = await harness.dispatch({ type: 'mai:set-pairing', code: pairingCode })
  assert.equal(pairingResult.ok, true)
  assert.equal(harness.values.get('maiPairing'), pairingCode)
  assert.equal(MockWebSocket.instances.length, 1)

  const socket = MockWebSocket.instances[0]
  assert.equal(socket.url, 'ws://127.0.0.1:45123/')

  socket.readyState = MockWebSocket.OPEN
  socket.emit('open')
  assert.deepEqual(socket.sent[0], {
    type: 'auth',
    token: 'integration-secret',
    extensionVersion: '0.3.0',
  })

  socket.emit('message', { data: JSON.stringify({ type: 'auth-ok' }) })
  assert.equal(harness.statusWrites.at(-1).state, 'connected')

  await harness.dispatch({
    type: 'mai:progress',
    model: 'qwen',
    phase: 'waiting',
    purpose: 'answer',
  })
  assert.deepEqual(socket.sent.at(-1), {
    type: 'progress',
    model: 'qwen',
    phase: 'waiting',
    purpose: 'answer',
  })
})

test('Zen extension rejects malformed pairing codes before opening a socket', async () => {
  MockWebSocket.instances = []
  const harness = createExtensionHarness()
  const result = await harness.dispatch({ type: 'mai:set-pairing', code: 'https://example.com|token' })
  assert.equal(result.ok, false)
  assert.equal(MockWebSocket.instances.length, 0)
})
