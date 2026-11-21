import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { isTaskId, isZenProgressMessage, isZenResponseMessage } = require('../dist-electron/main/zen/protocol.js')

const validTaskId = '2f1a6e40-7a53-4c21-9e11-6e7c8b0f1234'

test('accepts canonical UUID v4 task identifiers', () => {
  assert.equal(isTaskId(validTaskId), true)
  assert.equal(isTaskId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), true)
})

test('rejects malformed, non-v4, and oversized task identifiers', () => {
  for (const value of [
    undefined,
    null,
    '',
    'task-1',
    '2f1a6e40-7a53-1c21-9e11-6e7c8b0f1234',
    '2f1a6e40-7a53-4c21-7e11-6e7c8b0f1234',
    '2f1a6e40-7a53-4c21-9e11-6e7c8b0f1234-extra',
    'x'.repeat(10000),
  ]) {
    assert.equal(isTaskId(value), false, String(value))
  }
})

test('accepts progress messages with an optional valid task identifier', () => {
  assert.equal(isZenProgressMessage({
    type: 'progress',
    model: 'chatgpt',
    phase: 'waiting',
  }), true)

  assert.equal(isZenProgressMessage({
    type: 'progress',
    taskId: validTaskId,
    model: 'qwen',
    phase: 'sending',
    purpose: 'answer',
  }), true)
})

test('rejects progress messages with malformed task identifiers', () => {
  assert.equal(isZenProgressMessage({
    type: 'progress',
    taskId: 'not-a-task-id',
    model: 'deepseek',
    phase: 'opening',
  }), false)
})

test('accepts the cancelled error code returned by cooperative extension cancellation', () => {
  assert.equal(isZenResponseMessage({
    type: 'response',
    id: 'cancelled-task-response',
    ok: false,
    error: { code: 'cancelled', message: 'Operation cancelled.' },
  }), true)
})
