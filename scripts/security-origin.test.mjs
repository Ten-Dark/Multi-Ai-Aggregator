import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import test from 'node:test'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const { isValidZenExtensionOrigin, isAllowedZenExtensionOrigin } = require('../dist-electron/main/zen/origin.js')
const { isTrustedIpcSender } = require('../dist-electron/main/ipc-security.js')
const { ZenBridge } = require('../dist-electron/main/zen/bridge.js')
const APPROVED_ORIGIN = 'moz-extension://a1b2c3d4-1111-2222-3333-abcdefabcdef'

test('accepts a canonical moz-extension origin', () => {
  assert.equal(isValidZenExtensionOrigin(APPROVED_ORIGIN), true)
})

test('rejects non-extension, malformed, and non-canonical origins', () => {
  for (const origin of [
    'https://example.com',
    'http://localhost:5173',
    'moz-extension://',
    'moz-extension://extension-id/path',
    'moz-extension://user@extension-id',
    'not a url',
    '',
  ]) {
    assert.equal(isValidZenExtensionOrigin(origin), false, origin)
  }
})

test('allows only the previously approved extension origin', () => {
  const other = 'moz-extension://bbbbbbbb-1111-2222-3333-abcdefabcdef'
  assert.equal(isAllowedZenExtensionOrigin(APPROVED_ORIGIN, APPROVED_ORIGIN), true)
  assert.equal(isAllowedZenExtensionOrigin(other, APPROVED_ORIGIN), false)
  assert.equal(isAllowedZenExtensionOrigin(APPROVED_ORIGIN, null), true)
  assert.equal(isAllowedZenExtensionOrigin('https://example.com', null), false)
})

test('accepts only the current trusted main renderer for IPC', () => {
  const base = {
    senderMatchesWindow: true,
    frameExists: true,
    isMainFrame: true,
    frameUrl: 'http://localhost:5173/',
    currentUrl: 'http://localhost:5173/',
    isPackaged: false,
  }

  assert.equal(isTrustedIpcSender(base), true)
  for (const patch of [
    { senderMatchesWindow: false },
    { frameExists: false },
    { isMainFrame: false },
    { frameUrl: 'http://localhost:5173/evil' },
    { currentUrl: 'http://localhost:5173/other' },
    { frameUrl: 'http://127.0.0.1:5173/' },
    { frameUrl: 'https://localhost:5173/' },
    { frameUrl: 'http://user@localhost:5173/' },
    { frameUrl: 'http://localhost:5173/?debug=1' },
  ]) {
    assert.equal(isTrustedIpcSender({ ...base, ...patch }), false, JSON.stringify(patch))
  }

  const devFileUrl = 'file:///C:/app/dist-electron/renderer/index.html'
  assert.equal(isTrustedIpcSender({ ...base, frameUrl: devFileUrl, currentUrl: devFileUrl }), true)
  const foreignFileUrl = 'file:///C:/Users/Public/hostile.html'
  assert.equal(isTrustedIpcSender({ ...base, frameUrl: foreignFileUrl, currentUrl: foreignFileUrl }), false)

  assert.equal(isTrustedIpcSender({
    ...base,
    isPackaged: true,
    frameUrl: 'file:///app/index.html',
    currentUrl: 'file:///app/index.html',
  }), true)
})

async function getAvailablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function createBridge(t, prefix) {
  const dataDir = mkdtempSync(path.join(tmpdir(), prefix))
  const port = await getAvailablePort()
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(port)
  const bridge = new ZenBridge(dataDir, () => {})
  await bridge.start()
  t.after(async () => {
    await bridge.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })
  const connection = bridge.getZenConnection()
  const token = connection.pairingCode.slice(connection.pairingCode.lastIndexOf('|') + 1)
  return { bridge, connection, token }
}

function waitForClose(socket, sendOnOpen) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('WebSocket did not close as expected.'))
    }, 4000)
    socket.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    if (socket.readyState === WebSocket.OPEN) sendOnOpen()
    else if (socket.readyState === WebSocket.CONNECTING) socket.once('open', sendOnOpen)
  })
}

function authenticate(wsUrl, origin, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('Timed out waiting for bridge authentication.'))
    }, 4000)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, socket })
    }
    socket.once('open', () => socket.send(JSON.stringify({ type: 'auth', token, extensionVersion: 'test' })))
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.type === 'auth-ok') finish({ accepted: true })
      if (message.type === 'auth-error') finish({ accepted: false, reason: message.message })
    })
    socket.once('close', () => finish({ accepted: false }))
    socket.once('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    })
  })
}

test('can restart the bridge after a clean shutdown', async (t) => {
  const { bridge, connection } = await createBridge(t, 'multi-ai-restart-test-')
  await bridge.close()

  const [restarted, concurrentStart] = await Promise.all([bridge.start(), bridge.start()])
  assert.equal(restarted.status, 'starting')
  assert.equal(concurrentStart.status, 'starting')
  assert.equal(bridge.getZenConnection().wsUrl, connection.wsUrl)
  assert.equal(bridge.getBrowserInfo().status, 'starting')
})

test('rejects WebSocket messages larger than the bridge payload limit', async (t) => {
  const { connection } = await createBridge(t, 'multi-ai-payload-test-')
  const socket = new WebSocket(connection.wsUrl, { origin: APPROVED_ORIGIN })
  const closeCode = await waitForClose(socket, () => socket.send('x'.repeat(1024 * 1024 + 1)))
  assert.equal(closeCode, 1009)
})

test('closes connections that send malformed JSON', async (t) => {
  const { connection } = await createBridge(t, 'multi-ai-malformed-test-')
  const socket = new WebSocket(connection.wsUrl, { origin: APPROVED_ORIGIN })
  const closeCode = await waitForClose(socket, () => socket.send('{invalid-json'))
  assert.equal(closeCode, 1007)
})

test('requires authentication before accepting application messages', async (t) => {
  const { connection } = await createBridge(t, 'multi-ai-unauth-test-')
  const socket = new WebSocket(connection.wsUrl, { origin: APPROVED_ORIGIN })
  const closeCode = await waitForClose(socket, () => socket.send(JSON.stringify({ type: 'ping' })))
  assert.equal(closeCode, 1008)
})

test('rejects unsupported message types after authentication', async (t) => {
  const { connection, token } = await createBridge(t, 'multi-ai-message-type-test-')
  const result = await authenticate(connection.wsUrl, APPROVED_ORIGIN, token)
  assert.equal(result.accepted, true)
  const closeCode = await waitForClose(result.socket, () => result.socket.send(JSON.stringify({ type: 'unexpected' })))
  assert.equal(closeCode, 1008)
})

test('revokes a replaced WebSocket before its asynchronous close event', async (t) => {
  const { connection, token } = await createBridge(t, 'multi-ai-replacement-test-')
  const first = await authenticate(connection.wsUrl, APPROVED_ORIGIN, token)
  assert.equal(first.accepted, true)

  const second = await authenticate(connection.wsUrl, APPROVED_ORIGIN, token)
  assert.equal(second.accepted, true)

  if (first.socket.readyState !== WebSocket.CLOSED) {
    const closeCode = await waitForClose(first.socket, () => {
      if (first.socket.readyState === WebSocket.OPEN) {
        first.socket.send(JSON.stringify({ type: 'ping' }))
      }
    })
    assert.equal(closeCode, 1008)
  }

  const pong = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Active socket did not answer ping.')), 2000)
    second.socket.once('message', (raw) => {
      clearTimeout(timer)
      resolve(JSON.parse(raw.toString()))
    })
  })
  second.socket.send(JSON.stringify({ type: 'ping' }))
  assert.deepEqual(await pong, { type: 'pong' })
})

test('rejects an invalid pairing token', async (t) => {
  const { connection } = await createBridge(t, 'multi-ai-invalid-token-test-')
  const result = await authenticate(connection.wsUrl, APPROVED_ORIGIN, 'invalid-token')
  assert.equal(result.accepted, false)
  assert.match(result.reason ?? '', /Неверный код подключения/)
})

test('persists the first authenticated extension origin across bridge restarts', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'multi-ai-origin-test-'))
  const port = await getAvailablePort()
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(port)
  let bridge
  let firstSocket
  let restartedSocket

  t.after(async () => {
    firstSocket?.close()
    restartedSocket?.close()
    await bridge?.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })

  const otherOrigin = 'moz-extension://bbbbbbbb-1111-2222-3333-abcdefabcdef'
  bridge = new ZenBridge(dataDir, () => {})
  await bridge.start()
  const connection = bridge.getZenConnection()
  const token = connection.pairingCode.slice(connection.pairingCode.lastIndexOf('|') + 1)

  const first = await authenticate(connection.wsUrl, APPROVED_ORIGIN, token)
  firstSocket = first.socket
  assert.equal(first.accepted, true)

  const rejected = await authenticate(connection.wsUrl, otherOrigin, token)
  assert.equal(rejected.accepted, false)

  await firstSocket.close()
  await bridge.close()

  bridge = new ZenBridge(dataDir, () => {})
  await bridge.start()
  const restartedConnection = bridge.getZenConnection()
  const restartedToken = restartedConnection.pairingCode.slice(restartedConnection.pairingCode.lastIndexOf('|') + 1)

  const sameOrigin = await authenticate(restartedConnection.wsUrl, APPROVED_ORIGIN, restartedToken)
  restartedSocket = sameOrigin.socket
  assert.equal(sameOrigin.accepted, true)

  const stillRejected = await authenticate(restartedConnection.wsUrl, otherOrigin, restartedToken)
  assert.equal(stillRejected.accepted, false)
})
