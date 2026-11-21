import path from 'node:path'
import { _electron as electron } from 'playwright'

const project = process.cwd()
const log = (k, v) => console.log(k, typeof v === 'string' ? v : JSON.stringify(v))

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
  log('CODE_SHOWN', pairingCode.startsWith('ws://127.0.0.1:') && pairingCode.includes('|'))
  log('BADGE', await waitBadge(60_000))
  log('CONNECTION_INFO', await page.evaluate(() => {
    const info = window.aggregator.getZenConnection()
    return { wsUrl: info.wsUrl, connected: info.connected, extensionVersion: info.extensionVersion }
  }))

  const sessions = await page.evaluate(() => window.aggregator.checkSessions())
  log('SESSIONS', sessions.map((s) => `${s.model}=${s.status} (${s.message})`).join(' | '))

  const prompt = 'Ответь ровно одним словом: ОК'
  const started = Date.now()
  const results = await page.evaluate((p) => window.aggregator.sendAll(p), prompt)
  log('SEND_ALL_SECONDS', String(Math.round((Date.now() - started) / 1000)))
  for (const r of results) {
    log(`RESULT_${r.model.toUpperCase()}`, {
      status: r.status,
      code: r.errorCode,
      error: r.error ? r.error.slice(0, 200) : undefined,
      text: (r.text || '').slice(0, 120),
    })
  }

  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(project, 'live-ui.png'), fullPage: true })

  const answers = results
    .filter((r) => r.status === 'done' && r.text)
    .map((r) => ({ model: r.model, text: r.text }))
  if (answers.length > 0) {
    const synth = await page.evaluate(
      ({ p, a }) => window.aggregator.synthesize({ model: 'chatgpt', prompt: p, answers: a }),
      { p: prompt, a: answers },
    )
    log('SYNTHESIS', { model: synth.model, text: synth.text.slice(0, 200) })
    await page.screenshot({ path: path.join(project, 'live-synthesis.png'), fullPage: true })
  } else {
    log('SYNTHESIS', 'skipped: no completed answers')
  }
} catch (error) {
  log('FAIL', error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: path.join(project, 'live-fail.png'), fullPage: true }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
