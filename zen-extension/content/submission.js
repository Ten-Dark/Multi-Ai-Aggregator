(() => {
  'use strict'

  async function submitOnce(submit, waitForEvidence) {
    if (typeof submit !== 'function' || typeof waitForEvidence !== 'function') {
      throw new TypeError('submitOnce requires submit and waitForEvidence functions.')
    }

    // Once the UI action is invoked, the provider may have accepted the prompt
    // even if its DOM does not expose confirmation immediately. Never retry here.
    await submit()
    const confirmed = await waitForEvidence()
    return confirmed ? 'submitted' : 'submission-unknown'
  }

  function normalizePromptText(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
  }

  function matchesPrompt(actual, expected) {
    return normalizePromptText(actual) === normalizePromptText(expected)
  }

  globalThis.MaiSubmission = Object.freeze({ submitOnce, matchesPrompt })
})()
