import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import test from 'node:test'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const {
  isAllowedZenExtensionOrigin,
  isValidZenExtensionOrigin,
} = require('../dist-electron/main/zen/origin.js')
const { ZenBridge } = require('../dist-electron/main/zen/bridge.js')

test('accepts a canonical moz-extension origin', () => {
  assert.equal(isValidZenExtensionOrigin('moz-extension://a1b2c3d4-1111-2222-3333-abcdefabcdef'), true)
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
  const approved = 'moz-extension://a1b2c3d4-1111-2222-3333-abcdefabcdef'
  const other = 'moz-extension://bbbbbbbb-1111-2222-3333-abcdefabcdef'

  assert.equal(isAllowedZenExtensionOrigin(approved, approved), true)
  assert.equal(isAllowedZenExtensionOrigin(other, approved), false)
  assert.equal(isAllowedZenExtensionOrigin(approved, null), true)
  assert.equal(isAllowedZenExtensionOrigin('https://example.com', null), false)
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

function authenticate(wsUrl, origin, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin })
    let settled = false
    const timer = setTimeout(() => {
      socket.terminate()
      if (!settled) {
        settled = true
        reject(new Error('Timed out waiting for bridge authentication.'))
      }
    }, 4000)

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, socket })
    }

    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token, extensionVersion: 'test' }))
    })
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

test('rejects WebSocket messages larger than the bridge payload limit', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'multi-ai-payload-test-'))
  const port = await getAvailablePort()
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(port)
  const bridge = new ZenBridge(dataDir, () => {})
  await bridge.start()
  const connection = bridge.getZenConnection()
  const socket = new WebSocket(connection.wsUrl, {
    origin: 'moz-extension://a1b2c3d4-1111-2222-3333-abcdefabcdef',
  })

  t.after(async () => {
    socket.terminate()
    await bridge.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })

  const closeCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Oversized payload was not rejected.')), 4000)
    socket.once('open', () => socket.send('x'.repeat(1024 * 1024 + 1)))
    socket.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  assert.equal(closeCode, 1009)
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

  const approvedOrigin = 'moz-extension://a1b2c3d4-1111-2222-3333-abcdefabcdef'
  const unapprovedOrigin = 'moz-extension://bbbbbbbb-1111-2222-3333-abcdefabcdef'

  bridge = new ZenBridge(dataDir, () => {})
  await bridge.start()
  const connection = bridge.getZenConnection()
  const token = connection.pairingCode.slice(connection.pairingCode.lastIndexOf('|') + 1)

  const first = await authenticate(connection.wsUrl, approvedOrigin, token)
  firstSocket = first.socket
  assert.equal(first.accepted, true, 'the first valid token holder should establish the pin')

  const rejected = await authenticate(connection.wsUrl, unapprovedOrigin, token)
  assert.equal(rejected.accepted, false, 'a different extension origin must be rejected')

  await firstSocket.close()
  await bridge.close()

  bridge = new ZenBridge(dataDir, () => {})
  await bridge.start()
  const restartedConnection = bridge.getZenConnection()
  const restartedToken = restartedConnection.pairingCode.slice(
    restartedConnection.pairingCode.lastIndexOf('|') + 1,
  )

  const sameOrigin = await authenticate(restartedConnection.wsUrl, approvedOrigin, restartedToken)
  restartedSocket = sameOrigin.socket
  assert.equal(sameOrigin.accepted, true, 'the approved origin should survive application restart')

  const stillRejected = await authenticate(restartedConnection.wsUrl, unapprovedOrigin, restartedToken)
  assert.equal(stillRejected.accepted, false, 'the persisted pin must reject a different origin after restart')
})
