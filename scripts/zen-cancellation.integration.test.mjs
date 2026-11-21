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
    const listeners = this.listeners.get(type) || []
    listeners.push(callback)
    this.listeners.set(type, listeners)
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

const TASK_ID = '2f1a6e40-7a53-4c21-9e11-6e7c8b0f1234'
const ORIGIN = 'moz-extension://test/'

function createBackgroundHarness({ completeImmediately = false } = {}) {
  const values = new Map()
  let runtimeListener
  let pendingSend = null
  let cancelMessages = 0
  const tabById = new Map([
    [101, { id: 101, windowId: 1, status: 'complete', url: 'https://chat.qwen.ai/' }],
  ])
  const browser = {
    runtime: {
      getManifest: () => ({ name: 'Multi-AI Aggregator Bridge', version: '0.3.0' }),
      getURL: (path) => `moz-extension://test/${path}`,
      onMessage: { addListener: (listener) => { runtimeListener = listener } },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: values.get(key) }),
        set: async (entries) => { for (const [key, value] of Object.entries(entries)) values.set(key, value) },
        remove: async (key) => { values.delete(key) },
      },
    },
    browserAction: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    windows: {
      get: async (id) => ({ id }),
      update: async () => ({}),
    },
    tabs: {
      get: async (id) => tabById.get(id),
      update: async (id, changes) => {
        const tab = tabById.get(id)
        Object.assign(tab, changes, { status: 'complete' })
        return tab
      },
      sendMessage: async (tabId, message) => {
        if (message.type === 'mai:ping') return { ok: true }
        if (message.type === 'mai:send') {
          if (completeImmediately) return { ok: true, taskId: message.taskId, text: 'completed answer' }
          return new Promise((resolve) => { pendingSend = { resolve, tabId, message } })
        }
        if (message.type === 'mai:cancel') {
          cancelMessages += 1
          pendingSend?.resolve({
            ok: false,
            taskId: message.taskId,
            error: { code: 'cancelled', message: 'Operation cancelled.' },
          })
          return { ok: true, taskId: message.taskId, cancelled: true }
        }
        return undefined
      },
    },
  }

  values.set('maiTabs', { windowId: 1, tabs: { chatgpt: 101, qwen: 101, deepseek: 101 } })
  const source = readFileSync(new URL('../zen-extension/background.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    browser,
    WebSocket: MockWebSocket,
    URL,
    AbortController,
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
    Number,
    Math,
    Array,
    RegExp,
  })

  return {
    values,
    get pendingSend() { return pendingSend },
    get cancelMessages() { return cancelMessages },
    dispatch: (message, sender = {}) => runtimeListener(message, sender),
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for extension state.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function connectBackground(harness) {
  const pairingCode = 'ws://127.0.0.1:45123|integration-secret'
  assert.equal((await harness.dispatch({ type: 'mai:set-pairing', code: pairingCode })).ok, true)
  const socket = MockWebSocket.instances.at(-1)
  socket.readyState = MockWebSocket.OPEN
  socket.emit('open')
  socket.emit('message', { data: JSON.stringify({ type: 'auth-ok' }) })
  return socket
}

function command(socket, id, action, payload) {
  socket.emit('message', { data: JSON.stringify({ type: 'command', id, action, payload }) })
}

async function waitForResponse(socket, id) {
  await waitFor(() => socket.sent.some((message) => message.type === 'response' && message.id === id))
  return socket.sent.find((message) => message.type === 'response' && message.id === id)
}

test('background routes cancellation to the matching tab and waits for automation settlement', async () => {
  MockWebSocket.instances = []
  const harness = createBackgroundHarness()
  const socket = await connectBackground(harness)

  command(socket, 'send-invalid', 'send', {
    taskId: 'not-a-uuid',
    model: 'qwen',
    prompt: 'invalid task',
  })
  const invalid = await waitForResponse(socket, 'send-invalid')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'unknown')
  assert.equal(harness.pendingSend, null)

  command(socket, 'send-1', 'send', {
    taskId: TASK_ID,
    batchId: '5a1b6e40-7a53-4c21-9e11-6e7c8b0f1234',
    model: 'qwen',
    prompt: 'test prompt',
    timeoutMs: 30_000,
    purpose: 'answer',
  })
  await waitFor(() => Boolean(harness.pendingSend))
  assert.equal(harness.pendingSend.message.taskId, TASK_ID)

  await harness.dispatch({ type: 'mai:progress', taskId: TASK_ID, model: 'qwen', phase: 'waiting' }, { tab: { id: 101 } })
  assert.equal(socket.sent.at(-1).taskId, TASK_ID)
  const progressCount = socket.sent.length
  await harness.dispatch({ type: 'mai:progress', taskId: TASK_ID, model: 'qwen', phase: 'waiting' }, { tab: { id: 999 } })
  assert.equal(socket.sent.length, progressCount)

  command(socket, 'cancel-1', 'cancelTask', { taskId: TASK_ID })
  const cancellation = await waitForResponse(socket, 'cancel-1')
  assert.equal(cancellation.ok, true)
  assert.deepEqual(cancellation.data, { taskId: TASK_ID, cancelled: true })

  const original = await waitForResponse(socket, 'send-1')
  assert.equal(original.ok, false)
  assert.equal(original.error.code, 'cancelled')

  command(socket, 'cancel-2', 'cancelTask', { taskId: TASK_ID })
  const repeated = await waitForResponse(socket, 'cancel-2')
  assert.deepEqual(repeated.data, { taskId: TASK_ID, cancelled: true })

  command(socket, 'send-duplicate', 'send', {
    taskId: TASK_ID,
    model: 'qwen',
    prompt: 'must be rejected',
  })
  const duplicate = await waitForResponse(socket, 'send-duplicate')
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error.code, 'busy')
})

test('background disconnect aborts active content automation', async () => {
  MockWebSocket.instances = []
  const harness = createBackgroundHarness()
  const socket = await connectBackground(harness)

  command(socket, 'send-disconnect', 'send', {
    taskId: TASK_ID,
    model: 'qwen',
    prompt: 'disconnect test',
    timeoutMs: 30_000,
    purpose: 'answer',
  })
  await waitFor(() => Boolean(harness.pendingSend))

  socket.close(1008, 'Replaced')
  await waitFor(() => harness.cancelMessages === 1)
  assert.equal(harness.cancelMessages, 1)
})

test('background does not report cancellation when the content task already finished', async () => {
  MockWebSocket.instances = []
  const harness = createBackgroundHarness({ completeImmediately: true })
  const socket = await connectBackground(harness)

  command(socket, 'send-done', 'send', {
    taskId: TASK_ID,
    model: 'qwen',
    prompt: 'test prompt',
    timeoutMs: 30_000,
    purpose: 'answer',
  })
  const original = await waitForResponse(socket, 'send-done')
  assert.equal(original.ok, true)
  assert.deepEqual(original.data, { taskId: TASK_ID, text: 'completed answer' })

  command(socket, 'cancel-done', 'cancelTask', { taskId: TASK_ID })
  const cancellation = await waitForResponse(socket, 'cancel-done')
  assert.equal(cancellation.ok, true)
  assert.deepEqual(cancellation.data, { taskId: TASK_ID, cancelled: false, reason: 'already-finished' })
})

function createContentHarness() {
  let listener
  const browser = {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: (callback) => { listener = callback } },
    },
  }
  const document = {
    title: 'ChatGPT',
    body: { innerText: '' },
    querySelectorAll: () => [],
  }
  const window = { __maiAutomationLoaded: false }
  const submissionSource = readFileSync(new URL('../zen-extension/content/submission.js', import.meta.url), 'utf8')
  const automationSource = readFileSync(new URL('../zen-extension/content/automation.js', import.meta.url), 'utf8')
  const source = `${submissionSource}\n;\n${automationSource}`
  runInNewContext(source, {
    browser,
    window,
    location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/' },
    document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    HTMLButtonElement: class HTMLButtonElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLInputElement: class HTMLInputElement {},
    InputEvent: class InputEvent {},
    Event: class Event {},
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Map,
    Set,
    Array,
    String,
    Boolean,
    Error,
    RegExp,
    Math,
    Number,
  })
  return { dispatch: (message) => listener(message) }
}

function createSessionHarness({ loggedIn = false, loggedOut = false } = {}) {
  let listener
  class FakeElement {
    constructor() {
      this.disabled = false
      this.className = ''
      this.classList = { contains: () => false }
    }
    getAttribute() { return null }
    getBoundingClientRect() { return { width: 300, height: 40, top: 0, left: 0, right: 300 } }
  }
  const composer = new FakeElement()
  const avatar = new FakeElement()
  const loginButton = new FakeElement()
  const document = {
    title: 'DeepSeek',
    body: { innerText: '' },
    querySelectorAll: (selector) => {
      if (selector === 'textarea#chat-input') return [composer]
      if (selector === 'img[src*="static.deepseek.com/user-avatar"]') return loggedIn ? [avatar] : []
      if (selector === 'button[aria-label*="Log in" i]') return loggedOut ? [loginButton] : []
      return []
    },
  }
  const browser = {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: (callback) => { listener = callback } },
    },
  }
  const submissionSource = readFileSync(new URL('../zen-extension/content/submission.js', import.meta.url), 'utf8')
  const automationSource = readFileSync(new URL('../zen-extension/content/automation.js', import.meta.url), 'utf8')
  runInNewContext(`${submissionSource}\n;\n${automationSource}`, {
    browser,
    window: { __maiAutomationLoaded: false },
    location: { hostname: 'chat.deepseek.com', href: 'https://chat.deepseek.com/' },
    document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    HTMLButtonElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    HTMLInputElement: FakeElement,
    InputEvent: class InputEvent {},
    Event: class Event {},
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Map,
    Set,
    Array,
    String,
    Boolean,
    Error,
    RegExp,
    Math,
    Number,
  })
  return { inspect: (timeoutMs = 1000) => listener({ type: 'mai:inspect', timeoutMs }) }
}

function createSubmittedContentHarness({ staleResponse = false } = {}) {
  let listener
  let submitted = false
  let clickCount = 0
  const assistant = {
    innerText: 'partial response',
    textContent: 'partial response',
    querySelectorAll: () => [],
    hasAttribute: () => false,
  }
  const userMessage = {
    innerText: 'test prompt',
    textContent: 'test prompt',
    getBoundingClientRect: () => ({ width: 300, height: 40, top: 0, left: 0, right: 300 }),
    compareDocumentPosition: () => staleResponse ? 2 : 4,
  }
  class FakeTextArea {
    constructor() {
      this._value = ''
      this.form = { requestSubmit: () => { clickCount += 1; submitted = true } }
    }
    get value() { return this._value }
    set value(value) { this._value = value }
    focus() {}
    dispatchEvent() {}
    getBoundingClientRect() { return { width: 300, height: 40, top: 0, left: 0, right: 300 } }
  }
  class FakeButton {
    constructor() {
      this.disabled = false
      this.className = 'send-button'
      this.classList = { contains: () => false }
      this.innerText = 'Send'
    }
    getAttribute(name) { return name === 'aria-label' ? 'Send' : null }
    getBoundingClientRect() { return { width: 24, height: 24, top: 8, left: 310, right: 334 } }
    scrollIntoView() {}
    click() { clickCount += 1; submitted = true }
  }
  const composer = new FakeTextArea()
  const button = new FakeButton()
  const document = {
    title: 'ChatGPT',
    body: { innerText: '' },
    querySelectorAll: (selector) => {
      if (selector === '#prompt-textarea') return [composer]
      if (selector === 'button, [role="button"]') return [button]
      if (selector === '[data-message-author-role="user"]') return submitted ? [userMessage] : []
      if (selector.includes('button[') || selector.includes('data-testid="send-button"')) return [button]
      if (selector.includes('data-message-role="assistant"') || selector.includes('data-message-author-role="assistant"')) {
        return submitted ? [assistant] : []
      }
      return []
    },
  }
  const browser = {
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener: (callback) => { listener = callback } },
    },
  }
  const submissionSource = readFileSync(new URL('../zen-extension/content/submission.js', import.meta.url), 'utf8')
  const automationSource = readFileSync(new URL('../zen-extension/content/automation.js', import.meta.url), 'utf8')
  const source = `${submissionSource}\n;\n${automationSource}`
  runInNewContext(source, {
    browser,
    window: { __maiAutomationLoaded: false },
    location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/' },
    document,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    HTMLButtonElement: FakeButton,
    HTMLTextAreaElement: FakeTextArea,
    HTMLInputElement: class HTMLInputElement {},
    InputEvent: class InputEvent {},
    Event: class Event {},
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Map,
    Set,
    Array,
    String,
    Boolean,
    Error,
    RegExp,
    Math,
    Number,
  })
  return {
    dispatch: (message) => listener(message),
    get clickCount() { return clickCount },
  }
}

test('content script aborts DOM automation during a wait and acknowledges only after settlement', async () => {
  const harness = createContentHarness()
  const send = harness.dispatch({
    type: 'mai:send',
    taskId: TASK_ID,
    prompt: 'test prompt',
    timeoutMs: 30_000,
    purpose: 'answer',
  })

  const duplicate = await harness.dispatch({
    type: 'mai:send',
    taskId: TASK_ID,
    prompt: 'duplicate prompt',
    timeoutMs: 30_000,
    purpose: 'answer',
  })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error.code, 'busy')

  await new Promise((resolve) => setTimeout(resolve, 20))
  const cancellation = await harness.dispatch({ type: 'mai:cancel', taskId: TASK_ID })
  assert.equal(cancellation.ok, true)
  assert.equal(cancellation.cancelled, true)
  assert.equal(cancellation.taskId, TASK_ID)

  const result = await send
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'cancelled')

  const repeated = await harness.dispatch({ type: 'mai:cancel', taskId: TASK_ID })
  assert.equal(repeated.cancelled, true)
})

test('content script records cancellation that arrives before the send command', async () => {
  const harness = createContentHarness()
  const cancellation = await harness.dispatch({ type: 'mai:cancel', taskId: TASK_ID })
  assert.equal(cancellation.cancelled, true)

  const result = await harness.dispatch({
    type: 'mai:send',
    taskId: TASK_ID,
    prompt: 'must not start',
    timeoutMs: 30_000,
    purpose: 'answer',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'cancelled')
})

test('content cancellation after submit stops response collection without resubmitting', async () => {
  const harness = createSubmittedContentHarness()
  const send = harness.dispatch({
    type: 'mai:send',
    taskId: TASK_ID,
    prompt: 'test prompt',
    timeoutMs: 30_000,
    purpose: 'answer',
  })

  await waitFor(() => harness.clickCount === 1)
  const cancellation = await harness.dispatch({ type: 'mai:cancel', taskId: TASK_ID })
  const result = await send

  assert.equal(cancellation.cancelled, true)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'cancelled')
  assert.equal(harness.clickCount, 1)
})

test('content automation ignores a late assistant node that precedes the current user prompt', async () => {
  const harness = createSubmittedContentHarness({ staleResponse: true })
  let settled = false
  const send = harness.dispatch({
    type: 'mai:send',
    taskId: TASK_ID,
    prompt: 'test prompt',
    timeoutMs: 30_000,
    purpose: 'answer',
  }).then((result) => { settled = true; return result })

  await waitFor(() => harness.clickCount === 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(settled, false)

  const cancellation = await harness.dispatch({ type: 'mai:cancel', taskId: TASK_ID })
  const result = await send
  assert.equal(cancellation.cancelled, true)
  assert.equal(result.error.code, 'cancelled')
  assert.equal(harness.clickCount, 1)
})

test('session inspection does not infer DeepSeek login from composer visibility alone', async () => {
  const result = await createSessionHarness().inspect()
  assert.equal(result.ok, true)
  assert.equal(result.session.status, 'unknown')
})

test('session inspection requires positive DeepSeek profile evidence for logged-in status', async () => {
  const result = await createSessionHarness({ loggedIn: true }).inspect()
  assert.equal(result.ok, true)
  assert.equal(result.session.status, 'logged-in')
})

test('session inspection classifies an explicit DeepSeek login control as login-required', async () => {
  const result = await createSessionHarness({ loggedOut: true }).inspect()
  assert.equal(result.ok, true)
  assert.equal(result.session.status, 'login-required')
})
