import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { EventSnapshotTracker } = require('../dist-electron/shared/event-snapshot.js')

test('a newer browser event wins over an older initial IPC snapshot', () => {
  const tracker = new EventSnapshotTracker()
  const version = tracker.capture('browser')
  tracker.markEvent('browser')
  assert.equal(tracker.isCurrent('browser', version), false)
})

test('a newer Zen connection event wins over an older initial IPC snapshot', () => {
  const tracker = new EventSnapshotTracker()
  const version = tracker.capture('zenConnection')
  tracker.markEvent('zenConnection')
  assert.equal(tracker.isCurrent('zenConnection', version), false)
})

test('session events invalidate only the matching model snapshot', () => {
  const tracker = new EventSnapshotTracker()
  const chatgpt = tracker.capture('session:chatgpt')
  const qwen = tracker.capture('session:qwen')
  tracker.markEvent('session:chatgpt')
  assert.equal(tracker.isCurrent('session:chatgpt', chatgpt), false)
  assert.equal(tracker.isCurrent('session:qwen', qwen), true)
})

test('snapshots remain applicable when no newer event has arrived', () => {
  const tracker = new EventSnapshotTracker()
  const version = tracker.capture('browser')
  assert.equal(tracker.isCurrent('browser', version), true)
})
