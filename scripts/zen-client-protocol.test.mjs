import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isZenClientHeartbeatMessage,
  isZenClientInfoMessage,
} from '../dist-electron/main/zen/protocol.js'

const instanceId = '123e4567-e89b-42d3-a456-426614174000'

test('accepts bounded browser identity metadata with a canonical instance UUID', () => {
  assert.equal(isZenClientInfoMessage({
    type: 'client-info',
    instanceId,
    browserName: 'Zen',
    browserVersion: '1.2.3',
    extensionVersion: '0.3.4',
  }), true)
})

test('rejects malformed, unbounded, or incomplete browser identity metadata', () => {
  const base = {
    type: 'client-info',
    instanceId,
    browserName: 'Zen',
    browserVersion: '1.2.3',
    extensionVersion: '0.3.4',
  }
  assert.equal(isZenClientInfoMessage({ ...base, instanceId: 'not-a-uuid' }), false)
  assert.equal(isZenClientInfoMessage({ ...base, browserName: '' }), false)
  assert.equal(isZenClientInfoMessage({ ...base, browserName: 'x'.repeat(81) }), false)
  assert.equal(isZenClientInfoMessage({ ...base, browserVersion: 'x'.repeat(81) }), false)
  assert.equal(isZenClientInfoMessage({ ...base, extensionVersion: 'x'.repeat(65) }), false)
})

test('accepts heartbeat only for a canonical connector instance UUID', () => {
  assert.equal(isZenClientHeartbeatMessage({ type: 'client-heartbeat', instanceId }), true)
  assert.equal(isZenClientHeartbeatMessage({ type: 'client-heartbeat', instanceId: 'invalid' }), false)
  assert.equal(isZenClientHeartbeatMessage({ type: 'client-heartbeat', instanceId, extra: true }), true)
})
