import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../zen-extension/content/submission.js', import.meta.url), 'utf8')
const context = { Object, TypeError, Promise }
runInNewContext(source, context)
const { submitOnce, matchesPrompt } = context.MaiSubmission

test('prompt verification accepts only the same text with normalized line endings', () => {
  assert.equal(matchesPrompt('first\r\nsecond', 'first\nsecond'), true)
  assert.equal(matchesPrompt('requested prompt', 'requested prompt '), false)
  assert.equal(matchesPrompt('different prompt', 'requested prompt'), false)
})

test('submission invokes the provider action exactly once when evidence is delayed', async () => {
  let submitCount = 0
  let evidenceChecks = 0

  const state = await submitOnce(
    () => { submitCount += 1 },
    async () => {
      while (evidenceChecks < 3) {
        evidenceChecks += 1
        await Promise.resolve()
      }
      return true
    },
  )

  assert.equal(state, 'submitted')
  assert.equal(submitCount, 1)
  assert.equal(evidenceChecks, 3)
})

test('submission becomes unknown without retry when evidence never appears', async () => {
  let submitCount = 0

  const state = await submitOnce(
    () => { submitCount += 1 },
    async () => false,
  )

  assert.equal(state, 'submission-unknown')
  assert.equal(submitCount, 1)
})

test('submission does not invoke evidence polling if the submit action throws', async () => {
  let evidenceChecks = 0

  await assert.rejects(
    submitOnce(
      () => { throw new Error('click failed') },
      async () => { evidenceChecks += 1; return true },
    ),
    /click failed/,
  )
  assert.equal(evidenceChecks, 0)
})
