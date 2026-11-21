import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { OperationGate } = require('../dist-electron/shared/operation-gate.js')

test('operation gate rejects a concurrent operation', () => {
  const gate = new OperationGate()
  assert.equal(gate.tryAcquire(), true)
  assert.equal(gate.isLocked, true)
  assert.equal(gate.tryAcquire(), false)
})

test('operation gate can be reused after release', () => {
  const gate = new OperationGate()
  assert.equal(gate.tryAcquire(), true)
  gate.release()
  assert.equal(gate.isLocked, false)
  assert.equal(gate.tryAcquire(), true)
})

test('releasing an idle gate is safe', () => {
  const gate = new OperationGate()
  gate.release()
  assert.equal(gate.tryAcquire(), true)
})
