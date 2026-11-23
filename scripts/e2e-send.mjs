import { _electron as electron } from 'playwright'

if (process.env.MAI_ALLOW_USER_PROFILE_SMOKE !== '1') {
  throw new Error('Refusing to launch against the normal user profile. Set MAI_ALLOW_USER_PROFILE_SMOKE=1 explicitly.')
}
if (process.env.MAI_ALLOW_LIVE_PROVIDER_TESTS !== '1') {
  throw new Error('Refusing to submit real provider prompts. Set MAI_ALLOW_LIVE_PROVIDER_TESTS=1 explicitly.')
}

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })

const log = (label, value) => console.log(label, JSON.stringify(value))

try {
  const window = await app.firstWindow()
  window.on('pageerror', (error) => console.log('[pageerror]', error.name))
  await window.waitForSelector('h1', { timeout: 30_000 })

  const waitForSessions = async () => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const texts = await window.locator('.session-chip').allInnerTexts()
      if (texts.length === 3 && !texts.some((text) => text.includes('Провер'))) return texts
      await window.waitForTimeout(1000)
    }
    return window.locator('.session-chip').allInnerTexts()
  }

  const readCards = async () => window.locator('.response-card').evaluateAll((cards) =>
    cards.map((card) => ({
      model: card.querySelector('h2')?.textContent?.trim() || '',
      status: card.querySelector('.status-pill')?.textContent?.trim() || '',
      hasText: Boolean((card.querySelector('.response-text')?.textContent || '').trim()),
      textLength: (card.querySelector('.response-text')?.textContent || '').trim().length,
      hasError: Boolean(card.querySelector('.error-text, .inline-error')),
    })),
  )

  const terminal = ['Готово', 'Ошибка']
  const waitForResults = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const cards = await readCards()
      if (cards.length > 0 && cards.every((card) => terminal.includes(card.status))) return cards
      await window.waitForTimeout(2000)
    }
    return readCards()
  }

  log('SESSIONS', await waitForSessions())

  await window.locator('.query-input').fill('Ответь одним словом: ОК')
  await window.locator('.query-actions .button.primary').click()
  console.log('SEND_STARTED')

  const cards = await waitForResults(6 * 60_000)
  log('RESULTS', cards)

  const synthButton = window.locator('.synthesis-controls .button.primary')
  if (!(await synthButton.isDisabled())) {
    await synthButton.click()
    const deadline = Date.now() + 6 * 60_000
    while (Date.now() < deadline) {
      const busy = (await synthButton.innerText()).includes('Собираю')
      const synthText = (await window.locator('.synthesis-body').innerText()).trim()
      if (!busy && synthText) {
        log('SYNTHESIS', { completed: true, hasText: true, textLength: synthText.length })
        break
      }
      await window.waitForTimeout(2000)
    }
  } else {
    console.log('SYNTHESIS_SKIPPED')
  }

  if (cards.some((card) => !terminal.includes(card.status))) process.exitCode = 1
} catch (error) {
  console.error('E2E_FAILED', error instanceof Error ? error.name : 'UnknownError')
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
}
