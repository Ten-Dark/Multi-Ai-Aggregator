import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { ZenConnectorRegistry } = require('../dist-electron/main/zen/connector-registry.js')

const identity = (instanceId, overrides = {}) => ({
  instanceId,
  browserName: 'Zen',
  browserVersion: '1.2.3',
  extensionVersion: '0.3.4',
  ...overrides,
})

test('keeps independently authenticated browser profiles connected', () => {
  const registry = new ZenConnectorRegistry()
  const firstSocket = {}
  const secondSocket = {}

  registry.register(identity('profile-one'), firstSocket, 100)
  registry.register(identity('profile-two', { browserName: 'Firefox' }), secondSocket, 200)

  assert.equal(registry.size, 2)
  assert.equal(registry.getByTransport(firstSocket).instanceId, 'profile-one')
  assert.equal(registry.getByTransport(secondSocket).browserName, 'Firefox')
  assert.equal(registry.getActive().instanceId, 'profile-one')
})

test('reconnect replaces only the matching profile transport', () => {
  const registry = new ZenConnectorRegistry()
  const firstSocket = {}
  const replacementSocket = {}
  const otherSocket = {}

  registry.register(identity('profile-one'), firstSocket, 100)
  registry.register(identity('profile-two'), otherSocket, 150)
  const result = registry.register(identity('profile-one'), replacementSocket, 200)

  assert.equal(result.replacedTransport, firstSocket)
  assert.equal(registry.size, 2)
  assert.equal(registry.getByTransport(firstSocket), undefined)
  assert.equal(registry.getByTransport(replacementSocket).instanceId, 'profile-one')
  assert.equal(registry.getByTransport(otherSocket).instanceId, 'profile-two')
  assert.equal(registry.remove(firstSocket), undefined)
  assert.equal(registry.size, 2)
})

test('rejects heartbeats from an unregistered or mismatched transport', () => {
  const registry = new ZenConnectorRegistry()
  const firstSocket = {}
  const impostorSocket = {}
  registry.register(identity('profile-one'), firstSocket, 100)

  assert.equal(registry.heartbeat(impostorSocket, 'profile-one', 200), false)
  assert.equal(registry.heartbeat(firstSocket, 'profile-two', 200), false)
  assert.equal(registry.heartbeat(firstSocket, 'profile-one', 250), true)
  assert.equal(registry.get('profile-one').lastHeartbeatAt, 250)
})

test('removing one profile leaves other profiles and active selection intact', () => {
  const registry = new ZenConnectorRegistry()
  const firstSocket = {}
  const secondSocket = {}
  registry.register(identity('profile-one'), firstSocket, 100)
  registry.register(identity('profile-two'), secondSocket, 200)
  registry.setActive('profile-two')

  const removed = registry.remove(firstSocket)
  assert.equal(removed.instanceId, 'profile-one')
  assert.equal(registry.size, 1)
  assert.equal(registry.getActive().instanceId, 'profile-two')
  assert.equal(registry.getByTransport(secondSocket).instanceId, 'profile-two')
})

test('active selection is explicit and cannot select an unknown profile', () => {
  const registry = new ZenConnectorRegistry()
  const firstSocket = {}
  const secondSocket = {}
  registry.register(identity('profile-one'), firstSocket, 100)
  registry.register(identity('profile-two'), secondSocket, 200)

  assert.equal(registry.setActive('profile-two'), true)
  assert.equal(registry.getActive().instanceId, 'profile-two')
  assert.equal(registry.setActive('missing-profile'), false)
  assert.equal(registry.getActive().instanceId, 'profile-two')
})

test('freshness expires independently for each connector', () => {
  const registry = new ZenConnectorRegistry()
  const firstSocket = {}
  const secondSocket = {}
  registry.register(identity('profile-one'), firstSocket, 100)
  registry.register(identity('profile-two'), secondSocket, 1_000)

  assert.equal(registry.isFresh(registry.get('profile-one'), 45_100), true)
  assert.equal(registry.isFresh(registry.get('profile-one'), 45_101), false)
  assert.equal(registry.isFresh(registry.get('profile-two'), 45_100), true)
})

test('clear returns all transports and resets registry state', () => {
  const registry = new ZenConnectorRegistry()
  registry.register(identity('profile-one'), {}, 100)
  registry.register(identity('profile-two'), {}, 200)

  assert.equal(registry.clear().length, 2)
  assert.equal(registry.size, 0)
  assert.equal(registry.getActive(), undefined)
})
