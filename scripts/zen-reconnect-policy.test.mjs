import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../zen-extension/reconnect-policy.js', import.meta.url), 'utf8')
const context = { globalThis: {} }
vm.runInNewContext(source, context)
const createReconnectPolicy = context.globalThis.MaiReconnectPolicy.createReconnectPolicy

test('reconnect delay grows exponentially and is capped', () => {
  const policy = createReconnectPolicy({ baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 })
  assert.deepEqual(
    [policy.nextDelay(), policy.nextDelay(), policy.nextDelay(), policy.nextDelay(), policy.nextDelay(), policy.nextDelay()],
    [1000, 2000, 4000, 5000, 5000, 5000],
  )
  assert.equal(policy.getAttempts(), 6)
})

test('reconnect delay applies bounded symmetric jitter', () => {
  const policy = createReconnectPolicy({ baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0.2 })
  assert.equal(policy.nextDelay(() => 0), 800)
  assert.equal(policy.nextDelay(() => 1), 2400)
})

test('reconnect policy reset restarts the backoff sequence', () => {
  const policy = createReconnectPolicy({ baseDelayMs: 750, maxDelayMs: 10_000, jitterRatio: 0 })
  assert.equal(policy.nextDelay(), 750)
  assert.equal(policy.nextDelay(), 1500)
  policy.reset()
  assert.equal(policy.getAttempts(), 0)
  assert.equal(policy.nextDelay(), 750)
})

test('invalid random samples and options fall back to safe defaults', () => {
  const policy = createReconnectPolicy({ baseDelayMs: -1, maxDelayMs: 0, jitterRatio: 5 })
  assert.equal(policy.nextDelay(() => Number.NaN), 1000)
  assert.equal(policy.nextDelay(() => 2), 3000)
})
