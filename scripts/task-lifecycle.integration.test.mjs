import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import test from 'node:test'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const { ZenBridge } = require('../dist-electron/main/zen/bridge.js')
const ORIGIN = 'moz-extension://a1b2c3d4-1111-2222-3333-abcdefabcdef'

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('Timed out waiting for a matching bridge message.'))
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

async function waitForCondition(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('confirmed cancellation wins over a late model response', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'multi-ai-task-lifecycle-'))
  const port = await availablePort()
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(port)
  const events = []
  const bridge = new ZenBridge(dataDir, (event) => events.push(event))
  await bridge.start()

  let socket
  t.after(async () => {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    await bridge.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })

  const connection = bridge.getZenConnection()
  const token = connection.pairingCode.slice(connection.pairingCode.lastIndexOf('|') + 1)
  socket = new WebSocket(connection.wsUrl, { origin: ORIGIN })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'auth', token, extensionVersion: 'test' }))
  await waitForMessage(socket, (message) => message.type === 'auth-ok')

  const operation = bridge.sendOne('chatgpt', 'test prompt')
  const sendCommand = await waitForMessage(
    socket,
    (message) => message.type === 'command' && message.action === 'send',
  )
  assert.match(sendCommand.payload.taskId, /^[0-9a-f-]{36}$/i)

  const cancellation = bridge.cancelTask(sendCommand.payload.taskId)
  const cancelCommand = await waitForMessage(
    socket,
    (message) => message.type === 'command' && message.action === 'cancelTask',
  )
  socket.send(JSON.stringify({
    type: 'response',
    id: cancelCommand.id,
    ok: true,
    data: { taskId: sendCommand.payload.taskId, cancelled: true },
  }))
  assert.deepEqual(await cancellation, { accepted: true, confirmed: true, status: 'cancelled' })

  socket.send(JSON.stringify({
    type: 'response',
    id: sendCommand.id,
    ok: true,
    data: { taskId: sendCommand.payload.taskId, text: 'late model response must be ignored' },
  }))

  const result = await operation
  assert.equal(result.status, 'cancelled')
  assert.equal(result.taskId, sendCommand.payload.taskId)
  assert.equal(result.text, undefined)

  const taskEvents = events
    .filter((event) => event.type === 'model' && event.result.taskId === sendCommand.payload.taskId)
    .map((event) => event.result.status)
  assert.deepEqual(taskEvents, ['opening', 'cancelling', 'cancelled'])

  const interruptedOperation = bridge.sendOne('qwen', 'second prompt')
  const interruptedSend = await waitForMessage(
    socket,
    (message) => message.type === 'command' && message.action === 'send' &&
      message.payload.model === 'qwen',
  )
  const interruptedCancellation = bridge.cancelTask(interruptedSend.payload.taskId)
  await waitForMessage(
    socket,
    (message) => message.type === 'command' && message.action === 'cancelTask' &&
      message.payload.taskId === interruptedSend.payload.taskId,
  )
  await new Promise((resolve) => {
    socket.once('close', resolve)
    socket.close()
  })

  assert.deepEqual(await interruptedCancellation, {
    accepted: true,
    confirmed: false,
    status: 'cancelled',
  })
  assert.equal((await interruptedOperation).status, 'cancelled')
})

test('batch cancellation preserves completed children and cancels only active tasks', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'multi-ai-batch-cancel-'))
  const port = await availablePort()
  const previousPort = process.env.AGGREGATOR_ZEN_PORT
  process.env.AGGREGATOR_ZEN_PORT = String(port)
  const events = []
  const bridge = new ZenBridge(dataDir, (event) => events.push(event))
  await bridge.start()

  let socket
  t.after(async () => {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    await bridge.close()
    if (previousPort === undefined) delete process.env.AGGREGATOR_ZEN_PORT
    else process.env.AGGREGATOR_ZEN_PORT = previousPort
    rmSync(dataDir, { recursive: true, force: true })
  })

  const connection = bridge.getZenConnection()
  const token = connection.pairingCode.slice(connection.pairingCode.lastIndexOf('|') + 1)
  socket = new WebSocket(connection.wsUrl, { origin: ORIGIN })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'auth', token, extensionVersion: 'test' }))
  await waitForMessage(socket, (message) => message.type === 'auth-ok')

  const observedCommands = []
  const observeCommands = (raw) => observedCommands.push(JSON.parse(raw.toString()))
  socket.on('message', observeCommands)
  const batchOperation = bridge.sendAll('batch prompt')
  await waitForCondition(() => observedCommands.filter(
    (message) => message.type === 'command' && message.action === 'send',
  ).length === 3)
  const commands = observedCommands.filter(
    (message) => message.type === 'command' && message.action === 'send',
  )
  socket.off('message', observeCommands)

  const batchId = commands[0].payload.batchId
  assert.ok(batchId)
  assert.ok(commands.every((command) => command.payload.batchId === batchId))
  assert.equal(new Set(commands.map((command) => command.payload.taskId)).size, 3)

  const completed = commands.find((command) => command.payload.model === 'chatgpt')
  socket.send(JSON.stringify({
    type: 'response',
    id: completed.id,
    ok: true,
    data: { taskId: completed.payload.taskId, text: 'completed before batch cancellation' },
  }))
  await waitForCondition(() => events.some(
    (event) => event.type === 'model' &&
      event.result.taskId === completed.payload.taskId &&
      event.result.status === 'done',
  ))
  socket.send(JSON.stringify({
    type: 'progress',
    taskId: completed.payload.taskId,
    model: 'chatgpt',
    phase: 'waiting',
  }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(events.some(
    (event) => event.type === 'model' &&
      event.result.taskId === completed.payload.taskId &&
      event.result.status === 'waiting',
  ), false)

  const activeCommands = commands.filter((command) => command !== completed)
  const observedCancellations = []
  const observeCancellations = (raw) => observedCancellations.push(JSON.parse(raw.toString()))
  socket.on('message', observeCancellations)
  const cancellation = bridge.cancelBatch(batchId)
  await waitForCondition(() => observedCancellations.filter(
    (message) => message.type === 'command' && message.action === 'cancelTask',
  ).length === activeCommands.length)
  const cancelCommands = observedCancellations.filter(
    (message) => message.type === 'command' && message.action === 'cancelTask',
  )
  socket.off('message', observeCancellations)

  for (let index = 0; index < cancelCommands.length; index += 1) {
    socket.send(JSON.stringify({
      type: 'response',
      id: cancelCommands[index].id,
      ok: true,
      data: { taskId: activeCommands[index].payload.taskId, cancelled: true },
    }))
  }
  assert.deepEqual(await cancellation, { accepted: 2, rejected: 0 })

  for (const command of activeCommands) {
    socket.send(JSON.stringify({
      type: 'response',
      id: command.id,
      ok: true,
      data: { taskId: command.payload.taskId, text: 'late batch response must be ignored' },
    }))
  }

  const results = await batchOperation
  assert.equal(results.find((result) => result.model === 'chatgpt').status, 'done')
  assert.equal(results.filter((result) => result.status === 'cancelled').length, 2)
  assert.equal(results.find((result) => result.model === 'chatgpt').text, 'completed before batch cancellation')
})
