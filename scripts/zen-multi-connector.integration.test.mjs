import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ZenBridge } = require('../dist-electron/main/zen/bridge.js')

const ORIGIN = 'moz-extension://12345678-1234-4234-8234-123456789abc'
const EXTENSION_VERSION = '0.3.4'
const IDS = {
  first: '123e4567-e89b-42d3-a456-426614174000',
  second: '223e4567-e89b-42d3-a456-426614174000',
  third: '323e4567-e89b-42d3-a456-426614174000',
}

async function getAvailablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForCondition(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for bridge state.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('Timed out waiting for a matching WebSocket message.'))
    }, timeoutMs)
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString())
      if (!predicate(message)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })
}

async function connectConnector(url, token, instanceId, browserName = 'Zen', reportedExtensionVersion = EXTENSION_VERSION) {
  const socket = new WebSocket(url, { headers: { Origin: ORIGIN } })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const auth = waitForMessage(socket, (message) => message.type === 'auth-ok')
  socket.send(JSON.stringify({ type: 'auth', token, extensionVersion: EXTENSION_VERSION }))
  await auth
  socket.send(JSON.stringify({
    type: 'client-info',
    instanceId,
    browserName,
    browserVersion: '1.2.3',
    extensionVersion: reportedExtensionVersion,
  }))
  return socket
}

function waitForClose(socket, send) {
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code))
    send()
  })
}

function sessionsPayload() {
  return [
    { model: 'chatgpt', status: 'logged-in', message: 'ChatGPT ready.' },
    { model: 'qwen', status: 'logged-in', message: 'Qwen ready.' },
    { model: 'deepseek', status: 'logged-in', message: 'DeepSeek ready.' },
  ]
}

test('bridge keeps multiple profiles connected, replaces only matching identity, and routes through active profile', async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mai-multi-connector-'))
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(await getAvailablePort())
  const events = []
  const bridge = new ZenBridge(dataDir, (event) => events.push(event), {
    secureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    secureFile: () => {},
  })

  t.after(async () => {
    await bridge.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })

  await bridge.start()
  const initial = bridge.getZenConnection()
  const token = initial.pairingCode.slice(initial.pairingCode.lastIndexOf('|') + 1)

  const first = await connectConnector(initial.wsUrl, token, IDS.first, 'Zen')
  const second = await connectConnector(initial.wsUrl, token, IDS.second, 'Firefox')
  const incompatible = await connectConnector(initial.wsUrl, token, '323e4567-e89b-42d3-a456-426614174000', 'Zen', '0.3.3')
  const incompatibleClose = await new Promise((resolve) => incompatible.once('close', resolve))
  assert.equal(incompatibleClose, 1007)
  await waitForCondition(() => bridge.getZenConnection().connectors?.length === 2)
  const third = await connectConnector(initial.wsUrl, token, IDS.third, 'Chrome')
  await waitForCondition(() => bridge.getZenConnection().connectors?.length === 3)
  const thirdClosed = new Promise((resolve) => third.once('close', resolve))
  third.close()
  await thirdClosed
  await waitForCondition(() => bridge.getZenConnection().connectors?.length === 2)
  assert.equal(bridge.getZenConnection().activeConnectorId, IDS.first)
  let connection = bridge.getZenConnection()
  assert.equal(connection.connected, true)
  assert.equal(connection.connectors.length, 2)
  assert.equal(connection.activeConnectorId, IDS.first)
  assert.equal(connection.connectors.find((item) => item.instanceId === IDS.second).browserName, 'Firefox')

  const firstClosed = new Promise((resolve) => first.once('close', resolve))
  const replacement = await connectConnector(initial.wsUrl, token, IDS.first, 'Zen')
  await firstClosed
  await waitForCondition(() => bridge.getZenConnection().connectors?.length === 2)
  connection = bridge.getZenConnection()
  assert.equal(connection.connectors.length, 2)
  assert.equal(connection.activeConnectorId, IDS.first)
  assert.equal(connection.connectors.some((item) => item.instanceId === IDS.first), true)

  const firstCommand = waitForMessage(replacement, (message) => message.type === 'command' && message.action === 'checkSessions')
  const secondCommands = []
  second.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.type === 'command') secondCommands.push(message)
  })
  const sessionsPromise = bridge.checkSessions()
  const command = await firstCommand
  const selectedCommand = waitForMessage(second, (message) => message.type === 'command' && message.action === 'checkSessions')
  const selected = bridge.setActiveConnector(IDS.second)
  assert.equal(selected.activeConnectorId, IDS.second)

  second.send(JSON.stringify({ type: 'response', id: command.id, ok: true, data: sessionsPayload() }))
  await new Promise((resolve) => setTimeout(resolve, 15))
  replacement.send(JSON.stringify({ type: 'response', id: command.id, ok: true, data: sessionsPayload() }))
  const sessions = await sessionsPromise
  assert.equal(sessions.length, 3)

  const routedCommand = await selectedCommand
  second.send(JSON.stringify({ type: 'response', id: routedCommand.id, ok: true, data: sessionsPayload() }))
  await waitForCondition(() => bridge.getZenConnection().activeConnectorId === IDS.second)
  assert.equal(bridge.getZenConnection().activeConnectorId, IDS.second)
  assert.equal(secondCommands.some((item) => item.id === routedCommand.id), true)

  const heartbeatCloseCode = await waitForClose(second, () => {
    second.send(JSON.stringify({ type: 'client-heartbeat', instanceId: IDS.first }))
  })
  assert.equal(heartbeatCloseCode, 1008)
  await waitForCondition(() => bridge.getZenConnection().connectors?.length === 1)
  await waitForCondition(() => bridge.getZenConnection().connectors?.length === 1)
  assert.equal(bridge.getZenConnection().activeConnectorId, IDS.first)
  assert.equal(bridge.getZenConnection().connectors.length, 1)
  replacement.close()
})


test('provider affinity routes each model independently, snapshots batch routes, and persists assignments', async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mai-provider-affinity-'))
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(await getAvailablePort())
  const bridge = new ZenBridge(dataDir, () => {}, {
    secureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    secureFile: () => {},
  })

  t.after(async () => {
    await bridge.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })

  await bridge.start()
  const initial = bridge.getZenConnection()
  const token = initial.pairingCode.slice(initial.pairingCode.lastIndexOf('|') + 1)
  const first = await connectConnector(initial.wsUrl, token, IDS.first, 'Zen')
  const second = await connectConnector(initial.wsUrl, token, IDS.second, 'Firefox')
  await waitForCondition(() => bridge.getZenConnection().connectors?.length === 2)

  const firstSessionCommand = waitForMessage(first, (message) => message.type === 'command' && message.action === 'checkSessions')
  const secondSessionCommand = waitForMessage(second, (message) => message.type === 'command' && message.action === 'checkSessions')
  bridge.setProviderConnector('chatgpt', IDS.second)
  bridge.setProviderConnector('qwen', IDS.first)
  const sessionsPromise = bridge.checkSessions()
  const [firstCheck, secondCheck] = await Promise.all([firstSessionCommand, secondSessionCommand])
  first.send(JSON.stringify({
    type: 'response', id: firstCheck.id, ok: true,
    data: sessionsPayload().map((session) => ({ ...session, message: 'from-profile-one' })),
  }))
  second.send(JSON.stringify({
    type: 'response', id: secondCheck.id, ok: true,
    data: sessionsPayload().map((session) => ({ ...session, message: 'from-profile-two' })),
  }))
  const sessions = await sessionsPromise
  assert.equal(sessions.find((session) => session.model === 'chatgpt').message, 'from-profile-two')
  assert.equal(sessions.find((session) => session.model === 'qwen').message, 'from-profile-one')
  assert.equal(sessions.find((session) => session.model === 'deepseek').message, 'from-profile-one')

  const sendAllPromise = bridge.sendAll('route each provider to its assigned profile')
  bridge.connectors.setActive(IDS.second)
  const [chatgptCommand, qwenCommand, deepseekCommand] = await Promise.all([
    waitForMessage(second, (message) => message.type === 'command' && message.action === 'send' && message.payload.model === 'chatgpt'),
    waitForMessage(first, (message) => message.type === 'command' && message.action === 'send' && message.payload.model === 'qwen'),
    waitForMessage(first, (message) => message.type === 'command' && message.action === 'send' && message.payload.model === 'deepseek'),
  ])
  assert.equal(chatgptCommand.payload.model, 'chatgpt')
  assert.equal(qwenCommand.payload.model, 'qwen')
  assert.equal(deepseekCommand.payload.model, 'deepseek')
  assert.equal(bridge.getZenConnection().providerConnectors.chatgpt, IDS.second)
  assert.equal(bridge.getZenConnection().providerConnectors.qwen, IDS.first)
  assert.equal(bridge.getZenConnection().providerConnectors.deepseek, null)

  second.send(JSON.stringify({
    type: 'response', id: chatgptCommand.id, ok: true,
    data: { taskId: chatgptCommand.payload.taskId, text: 'ChatGPT from profile two' },
  }))
  first.send(JSON.stringify({
    type: 'response', id: qwenCommand.id, ok: true,
    data: { taskId: qwenCommand.payload.taskId, text: 'Qwen from profile one' },
  }))
  first.send(JSON.stringify({
    type: 'response', id: deepseekCommand.id, ok: true,
    data: { taskId: deepseekCommand.payload.taskId, text: 'DeepSeek from profile one' },
  }))
  const results = await sendAllPromise
  assert.equal(results.every((result) => result.status === 'done'), true)
  assert.equal(results.find((result) => result.model === 'chatgpt').text, 'ChatGPT from profile two')
  assert.equal(results.find((result) => result.model === 'qwen').text, 'Qwen from profile one')
  assert.equal(results.find((result) => result.model === 'deepseek').text, 'DeepSeek from profile one')

  const focusPromise = bridge.focusModel('chatgpt')
  const focusCommand = await waitForMessage(second, (message) => message.type === 'command' && message.action === 'focus')
  assert.equal(focusCommand.payload.model, 'chatgpt')
  second.send(JSON.stringify({ type: 'response', id: focusCommand.id, ok: true, data: {} }))
  await focusPromise

  const synthesisPromise = bridge.synthesize({
    model: 'qwen',
    prompt: 'Synthesize the result',
    answers: [{ model: 'chatgpt', text: 'An answer' }],
  })
  const synthesisCommand = await waitForMessage(first, (message) => message.type === 'command' && message.action === 'send' && message.payload.purpose === 'synthesis')
  assert.equal(synthesisCommand.payload.model, 'qwen')
  first.send(JSON.stringify({
    type: 'response', id: synthesisCommand.id, ok: true,
    data: { taskId: synthesisCommand.payload.taskId, text: 'Synthesis from profile one' },
  }))
  const synthesis = await synthesisPromise
  assert.equal(synthesis.text, 'Synthesis from profile one')

  const restarted = new ZenBridge(dataDir, () => {}, {
    secureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    secureFile: () => {},
  })
  assert.deepEqual(restarted.getZenConnection().providerConnectors, {
    chatgpt: IDS.second,
    qwen: IDS.first,
    deepseek: null,
  })
  await restarted.close()

  const secondClosed = new Promise((resolve) => second.once('close', resolve))
  second.close()
  await secondClosed
  const unavailable = await bridge.sendOne('chatgpt', 'must not fall back to another profile')
  assert.equal(unavailable.status, 'error')
  assert.match(unavailable.error, /закреплённый профиль/)
  first.close()
})

test('task and cancellation remain pinned to the originating connector generation', async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mai-task-connector-'))
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(await getAvailablePort())
  const bridge = new ZenBridge(dataDir, () => {}, {
    secureDirectory: (directory) => mkdirSync(directory, { recursive: true }),
    secureFile: () => {},
  })

  t.after(async () => {
    await bridge.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })

  await bridge.start()
  const initial = bridge.getZenConnection()
  const token = initial.pairingCode.slice(initial.pairingCode.lastIndexOf('|') + 1)
  const first = await connectConnector(initial.wsUrl, token, IDS.first, 'Zen')
  const second = await connectConnector(initial.wsUrl, token, IDS.second, 'Firefox')
  const commandsOnSecond = []
  second.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.type === 'command') commandsOnSecond.push(message)
  })

  const sendPromise = bridge.sendOne('chatgpt', 'task bound to first connector')
  const sendCommand = await waitForMessage(first, (message) => message.type === 'command' && message.action === 'send')
  assert.equal(sendCommand.payload.model, 'chatgpt')

  // Simulate an unexpected active-profile change: task ownership must override it.
  bridge.connectors.setActive(IDS.second)
  const cancellationPromise = bridge.cancelTask(sendCommand.payload.taskId)
  const cancelCommand = await waitForMessage(first, (message) => message.type === 'command' && message.action === 'cancelTask')
  assert.equal(cancelCommand.payload.taskId, sendCommand.payload.taskId)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(commandsOnSecond.length, 0, 'task and cancellation must never migrate to another profile')

  first.send(JSON.stringify({
    type: 'response',
    id: cancelCommand.id,
    ok: true,
    data: { taskId: sendCommand.payload.taskId, cancelled: true },
  }))
  const cancellation = await cancellationPromise
  assert.equal(cancellation.accepted, true)
  assert.equal(cancellation.confirmed, true)

  first.send(JSON.stringify({
    type: 'response',
    id: sendCommand.id,
    ok: true,
    data: { taskId: sendCommand.payload.taskId, text: 'late response' },
  }))
  const result = await sendPromise
  assert.equal(result.status, 'cancelled', 'late completion must not overwrite confirmed cancellation')
  assert.equal(commandsOnSecond.length, 0)

  first.close()
  second.close()
})
