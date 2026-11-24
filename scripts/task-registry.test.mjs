import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { TaskRegistry } = require('../dist-electron/main/zen/task-registry.js')

const taskId = '2f1a6e40-7a53-4c21-9e11-6e7c8b0f1234'
const batchId = '5a1b6e40-7a53-4c21-9e11-6e7c8b0f1234'

function task(overrides = {}) {
  return {
    taskId,
    batchId,
    model: 'chatgpt',
    connectorId: 'connector-a',
    connectorGeneration: 1,
    status: 'opening',
    ...overrides,
  }
}

function result(status, overrides = {}) {
  return {
    model: 'chatgpt',
    taskId,
    batchId,
    status,
    updatedAt: 1,
    ...overrides,
  }
}

test('registers tasks and groups batch children', () => {
  const registry = new TaskRegistry()
  registry.register(task())
  registry.register(task({
    taskId: '6b1a6e40-7a53-4c21-9e11-6e7c8b0f1234',
    model: 'qwen',
  }))

  assert.equal(registry.get(taskId).model, 'chatgpt')
  assert.equal(registry.getBatch(batchId).length, 2)
})

test('terminal result wins and cannot be overwritten', () => {
  const registry = new TaskRegistry()
  registry.register(task())

  assert.deepEqual(registry.finish(taskId, result('done')), result('done'))
  assert.equal(registry.beginCancellation(taskId), null)
  assert.equal(registry.setStatus(taskId, 'waiting'), false)
  assert.equal(registry.finish(taskId, result('error')), null)
  assert.equal(registry.get(taskId).result.status, 'done')
})

test('progress cannot overwrite cancellation, and failed cancellation restores the prior state', () => {
  const registry = new TaskRegistry()
  registry.register(task({ status: 'waiting' }))

  assert.equal(registry.beginCancellation(taskId).status, 'cancelling')
  assert.equal(registry.setStatus(taskId, 'waiting'), false)
  assert.equal(registry.setStatus(taskId, 'sending'), false)
  assert.equal(registry.get(taskId).status, 'cancelling')
  assert.equal(registry.finish(taskId, result('done')), null)

  assert.equal(registry.restoreAfterCancellationFailure(taskId), true)
  assert.equal(registry.get(taskId).status, 'waiting')
  assert.equal(registry.setStatus(taskId, 'waiting'), true)
  assert.deepEqual(registry.finish(taskId, result('done')), result('done'))
})

test('confirmed cancellation is terminal and preserves its result', () => {
  const registry = new TaskRegistry()
  registry.register(task())
  registry.beginCancellation(taskId)

  const cancelled = result('cancelled')
  assert.deepEqual(registry.finishCancelled(taskId, cancelled), cancelled)
  assert.equal(registry.finish(taskId, result('done')), null)
  assert.equal(registry.get(taskId).result.status, 'cancelled')
})

test('disconnect finalizes only tasks already awaiting cancellation', () => {
  const registry = new TaskRegistry()
  registry.register(task())
  registry.register(task({
    taskId: '6b1a6e40-7a53-4c21-9e11-6e7c8b0f1234',
    model: 'qwen',
  }))
  registry.beginCancellation(taskId)

  const results = registry.finalizeCancelling((active) => ({
    model: active.model,
    taskId: active.taskId,
    batchId: active.batchId,
    status: 'cancelled',
    error: 'Extension disconnected.',
    updatedAt: 2,
  }))

  assert.equal(results.length, 1)
  assert.equal(results[0].taskId, taskId)
  assert.equal(registry.get(taskId).status, 'cancelled')
  assert.equal(registry.get('6b1a6e40-7a53-4c21-9e11-6e7c8b0f1234').status, 'opening')
})

test('removing the final child removes its batch index', () => {
  const registry = new TaskRegistry()
  registry.register(task())
  registry.remove(taskId)

  assert.equal(registry.get(taskId), undefined)
  assert.deepEqual(registry.getBatch(batchId), [])
})
