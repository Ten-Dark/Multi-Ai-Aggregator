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
  const intervals = []
  const browser = {
    runtime: {
      getManifest: () => ({ name: 'Multi-AI Aggregator Bridge', version: '0.3.4' }),
      getURL: (path) => `moz-extension://test/${path}`,
      getBrowserInfo: async () => ({ name: 'Zen', version: '1.2.3' }),
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
    setInterval: (callback, ms) => { intervals.push({ callback, ms }); return intervals.length },
    clearInterval: () => {},
    crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' },
    fetch: async () => ({ ok: false }),
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
    intervals,
  }
}

test('Zen extension discovers existing provider tabs without destructive browser changes', () => {
  const source = readFileSync(new URL('../zen-extension/background.js', import.meta.url), 'utf8')
  assert.equal(source.includes('browser.tabs.remove('), false)
  assert.equal(source.includes('browser.windows.remove('), false)
  const sessionCheck = source.split("if (action === 'checkSessions') {")[1]?.split("if (action === 'send') {")[0] || ''
  assert.ok(sessionCheck.includes('discoverProviderTabs()'))
  assert.equal(sessionCheck.includes('ensureTabs()'), false)
  assert.ok(source.includes('browser.tabs.query({})'))
})


test('Zen extension can activate content scripts in already-open provider tabs', () => {
  const source = readFileSync(new URL('../zen-extension/background.js', import.meta.url), 'utf8')
  const waitForContent = source.split('async function waitForContent(')[1]?.split('async function ensureModelTab(')[0] || ''
  const automation = readFileSync(new URL('../zen-extension/content/automation.js', import.meta.url), 'utf8')
  assert.ok(waitForContent.includes("file: 'content/submission.js'"))
  assert.ok(waitForContent.includes("file: 'content/automation.js'"))
  assert.ok(waitForContent.includes("type: 'mai:ping'"))
  assert.ok(waitForContent.includes('browser.tabs.onUpdated?.addListener(onTabUpdated)'))
  assert.ok(waitForContent.includes("tab.status === 'loading'"))
  assert.ok(waitForContent.includes('injectionAttempted = false'))
  assert.ok(waitForContent.includes('browser.tabs.onUpdated?.removeListener(onTabUpdated)'))
  assert.ok(automation.includes('window.__maiAutomationVersion === EXTENSION_VERSION'))
  assert.ok(automation.includes('browser.runtime.onMessage.removeListener(window.__maiAutomationListener)'))
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
    extensionVersion: '0.3.4',
  })

  socket.emit('message', { data: JSON.stringify({ type: 'auth-ok' }) })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(socket.sent[1], {
    type: 'client-info',
    instanceId: '123e4567-e89b-42d3-a456-426614174000',
    browserName: 'Zen',
    browserVersion: '1.2.3',
    extensionVersion: '0.3.4',
  })
  assert.equal(harness.statusWrites.at(-1).state, 'connected')
  assert.equal(harness.values.get('maiClientInstanceId'), '123e4567-e89b-42d3-a456-426614174000')
  assert.equal(harness.intervals[0].ms, 15_000)
  harness.intervals[0].callback()
  assert.deepEqual(socket.sent[2], {
    type: 'client-heartbeat',
    instanceId: '123e4567-e89b-42d3-a456-426614174000',
  })
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
