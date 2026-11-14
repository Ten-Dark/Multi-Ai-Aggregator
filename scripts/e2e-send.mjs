import { _electron as electron } from 'playwright'

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
app.process().stderr?.on('data', (chunk) => process.stderr.write(`[app:err] ${chunk}`))

const window = await app.firstWindow()
window.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))
await window.waitForSelector('h1', { timeout: 30_000 })

const waitForSessions = async () => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const texts = await window.locator('.session-chip').allInnerTexts()
    if (texts.length === 3 && !texts.some((text) => text.includes('Проверк'))) return texts
    await window.waitForTimeout(1000)
  }
  return window.locator('.session-chip').allInnerTexts()
}

const readCards = async () => {
  return window.locator('.response-card').evaluateAll((cards) =>
    cards.map((card) => ({
      model: card.querySelector('h2')?.textContent?.trim() || '',
      status: card.querySelector('.status-pill')?.textContent?.trim() || '',
      text: (card.querySelector('.response-text')?.textContent || '').trim().slice(0, 1200),
      error: (card.querySelector('.error-text, .inline-error')?.textContent || '').trim(),
      session: (card.querySelector('.session-inline')?.textContent || '').trim(),
    })),
  )
}

const terminal = ['Готово', 'Ошибка']
const waitForResults = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const cards = await readCards()
    if (cards.every((card) => terminal.includes(card.status))) return cards
    await window.waitForTimeout(2000)
  }
  return readCards()
}

console.log('sessions:', JSON.stringify(await waitForSessions(), null, 2))

await window.locator('.query-input').fill('Ответь одним словом: ОК')
await window.locator('.query-actions .button.primary').click()
console.log('sent, waiting for answers…')

const cards = await waitForResults(6 * 60_000)
console.log('results:', JSON.stringify(cards, null, 2))
await window.screenshot({ path: 'smoke-send.png', fullPage: true })

const synthButton = window.locator('.synthesis-controls .button.primary')
const canSynthesize = !(await synthButton.isDisabled())
if (canSynthesize) {
  console.log('starting synthesis…')
  await synthButton.click()
  const deadline = Date.now() + 6 * 60_000
  while (Date.now() < deadline) {
    const busy = (await synthButton.innerText()).includes('Собираю')
    const synthText = (await window.locator('.synthesis-body').innerText()).trim()
    if (!busy && synthText) break
    await window.waitForTimeout(2000)
  }
  console.log('synthesis:', JSON.stringify((await window.locator('.synthesis-body').innerText()).trim(), null, 2))
  await window.screenshot({ path: 'smoke-synthesis.png', fullPage: true })
} else {
  console.log('synthesis button is disabled')
}

await app.close()
