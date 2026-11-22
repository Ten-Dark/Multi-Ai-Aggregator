(() => {
  'use strict'

  const DEFAULTS = Object.freeze({
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
  })

  function createReconnectPolicy(options = {}) {
    const baseDelayMs = Number.isFinite(options.baseDelayMs) && options.baseDelayMs > 0
      ? options.baseDelayMs
      : DEFAULTS.baseDelayMs
    const maxDelayMs = Number.isFinite(options.maxDelayMs) && options.maxDelayMs >= baseDelayMs
      ? options.maxDelayMs
      : DEFAULTS.maxDelayMs
    const jitterRatio = Number.isFinite(options.jitterRatio)
      ? Math.min(0.5, Math.max(0, options.jitterRatio))
      : DEFAULTS.jitterRatio
    let attempts = 0

    return Object.freeze({
      nextDelay(random = Math.random) {
        attempts += 1
        const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(attempts - 1, 30)))
        const rawSample = random()
        const sample = Number.isFinite(rawSample) ? Math.min(1, Math.max(0, rawSample)) : 0.5
        const jittered = exponential * (1 - jitterRatio + sample * jitterRatio * 2)
        return Math.min(maxDelayMs, Math.max(0, Math.round(jittered)))
      },
      reset() {
        attempts = 0
      },
      getAttempts() {
        return attempts
      },
    })
  }

  globalThis.MaiReconnectPolicy = Object.freeze({ createReconnectPolicy })
})()
