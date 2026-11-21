import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

function loadPreload() {
  let api
  let listener
  let removed
  const ipcRenderer = {
    invoke: async () => undefined,
    on: (channel, handler) => {
      assert.equal(channel, 'aggregator:event')
      listener = handler
    },
    removeListener: (channel, handler) => {
      removed = channel === 'aggregator:event' && handler === listener
      if (removed) listener = undefined
    },
  }
  const contextBridge = {
    exposeInMainWorld: (name, value) => {
      assert.equal(name, 'aggregator')
      api = value
    },
  }
  const source = readFileSync(new URL('../preload/preload.cjs', import.meta.url), 'utf8')
  runInNewContext(source, { require: () => ({ contextBridge, ipcRenderer }), Number, Set, Array })
  return {
    api,
    dispatch: (payload) => listener?.({}, payload),
    wasRemoved: () => removed,
  }
}

test('preload forwards valid typed events and ignores malformed payloads', () => {
  const preload = loadPreload()
  const received = []
  const unsubscribe = preload.api.onEvent((event) => received.push(event))

  const validEvents = [
    { type: 'browser', browser: { status: 'running', browserName: 'Zen Browser' } },
    { type: 'session', session: { model: 'chatgpt', status: 'logged-in', message: 'ok' } },
    { type: 'model', result: { model: 'qwen', status: 'done', updatedAt: 123, text: 'answer' } },
    { type: 'model', result: { model: 'chatgpt', status: 'cancelling', updatedAt: 124, taskId: '2f1a6e40-7a53-4c21-9e11-6e7c8b0f1234' } },
    { type: 'model', result: { model: 'deepseek', status: 'cancelled', updatedAt: 125, taskId: '2f1a6e40-7a53-4c21-9e11-6e7c8b0f1234', batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
    { type: 'model', result: { model: 'qwen', status: 'error', updatedAt: 126, errorCode: 'cancelled', error: 'Operation cancelled.' } },
    { type: 'zen-connection', connection: { pairingCode: 'ws://127.0.0.1:45123|token', wsUrl: 'ws://127.0.0.1:45123', connected: true } },
  ]

  for (const event of validEvents) preload.dispatch(event)
  assert.equal(received.length, validEvents.length)
  assert.deepEqual(received.map((event) => event.type), validEvents.map((event) => event.type))

  for (const event of [
    null,
    { type: 'unknown' },
    { type: 'browser', browser: { status: 'connected' } },
    { type: 'session', session: { model: 'other', status: 'logged-in', message: 'bad' } },
    { type: 'model', result: { model: 'chatgpt', status: 'done', updatedAt: NaN } },
    { type: 'model', result: { model: 'chatgpt', status: 'done', updatedAt: 1, errorCode: 'arbitrary' } },
    { type: 'model', result: { model: 'chatgpt', status: 'done', updatedAt: 1, taskId: 'invalid-id' } },
    { type: 'model', result: { model: 'chatgpt', status: 'cancelled', updatedAt: 1, batchId: 'not-a-uuid' } },
    { type: 'zen-connection', connection: { pairingCode: 1, wsUrl: 'bad', connected: true } },
  ]) preload.dispatch(event)

  assert.equal(received.length, validEvents.length)
  unsubscribe()
  assert.equal(preload.wasRemoved(), true)
  preload.dispatch(validEvents[0])
  assert.equal(received.length, validEvents.length)
})

test('preload safely ignores non-function event subscribers', () => {
  const preload = loadPreload()
  assert.equal(typeof preload.api.onEvent(null), 'function')
})
