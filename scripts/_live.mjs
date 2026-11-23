import { _electron as electron } from 'playwright'

const project = process.cwd()
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v))

if (process.env.MAI_ALLOW_USER_PROFILE_SMOKE !== '1') {
  throw new Error('Refusing to launch against the normal user profile. Set MAI_ALLOW_USER_PROFILE_SMOKE=1 explicitly.')
}

const app = await electron.launch({ args: ['.'], cwd: project })
const page = await app.firstWindow()
await page.waitForSelector('h1', { timeout: 30_000 })

const waitBadge = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await page.locator('.browser-badge').innerText().catch(() => '')
    if (last.includes('подключён')) return last
    await page.waitForTimeout(1000)
  }
  throw new Error(`not connected. last=${last}`)
}

try {
  const pairingCode = (await page.locator('.pairing-code').innerText()).trim()
  log('CODE_SHOWN', Boolean(pairingCode))
  await waitBadge(60_000)
  log('BADGE_CONNECTED', true)
  log('CONNECTION_INFO', await page.evaluate(() => {
    const info = window.aggregator.getZenConnection()
    return { connected: info.connected, extensionVersion: info.extensionVersion }
  }))

  const sessions = await page.evaluate(() => window.aggregator.checkSessions())
  log('SESSIONS', sessions.map((s) => `${s.model}=${s.status}`).join(' | '))

  if (process.env.MAI_ALLOW_LIVE_PROVIDER_TESTS !== '1') {
    log('SEND_ALL', 'skipped; set MAI_ALLOW_LIVE_PROVIDER_TESTS=1 to submit a real prompt')
    process.exitCode = 0
  } else {
    const prompt = 'Ответь ровно одним словом: ОК'
    const started = Date.now()
    const results = await page.evaluate((p) => window.aggregator.sendAll(p), prompt)
    log('SEND_ALL_SECONDS', String(Math.round((Date.now() - started) / 1000)))
    for (const r of results) {
      log(`RESULT_${r.model.toUpperCase()}`, {
        status: r.status,
        code: r.errorCode,
        hasText: Boolean(r.text),
        textLength: r.text?.length ?? 0,
      })
    }

    await page.waitForTimeout(1500)

    const answers = results
      .filter((r) => r.status === 'done' && r.text)
      .map((r) => ({ model: r.model, text: r.text }))
    if (answers.length > 0) {
      const synth = await page.evaluate(
        ({ p, a }) => window.aggregator.synthesize({ model: 'chatgpt', prompt: p, answers: a }),
        { p: prompt, a: answers },
      )
      log('SYNTHESIS', { model: synth.model, hasText: Boolean(synth.text), textLength: synth.text.length })
    } else {
      log('SYNTHESIS', 'skipped: no completed answers')
    }
  }
} catch (error) {
  log('FAIL', error instanceof Error ? error.name : 'UnknownError')
} finally {
  await app.close().catch(() => {})
}
