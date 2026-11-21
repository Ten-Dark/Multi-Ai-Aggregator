import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { probeProfileDir } from './probe-profile-path.mjs'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'probe')
const context = await chromium.launchPersistentContext(probeProfileDir, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 900 }
})

async function save(page, name, extra = {}) {
  const data = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 8000),
    markdown: [...document.querySelectorAll('[class*="markdown"], [class*="prose"], [data-message-role="assistant"], [data-message-author-role="assistant"], [class*="assistant"]')].map((el) => ({
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
      text: (el.innerText || '').slice(0, 400),
      visible: !!(el.offsetWidth || el.offsetHeight),
      complete: el.getAttribute('data-message-complete'),
      role: el.getAttribute('data-message-role')
    })).slice(0, 60),
    buttons: [...document.querySelectorAll('button, [role="button"]')].filter((el) => !!(el.offsetWidth || el.offsetHeight)).map((el) => ({
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      aria: el.getAttribute('aria-label'),
      text: (el.innerText || '').trim().slice(0, 60),
      disabled: el.disabled ?? null
    })).slice(0, 100)
  }))
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ ...data, ...extra }, null, 2), 'utf8')
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })
  console.log(`== ${name} ==\n${JSON.stringify(data.bodyText.slice(0, 2000))}`)
}

const gpt = await context.newPage()
try {
  await gpt.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: 90000 })
  await gpt.waitForTimeout(7000)
  const input = gpt.locator('textarea#mobile-composer-prompt, textarea[name="prompt"], #prompt-textarea').first()
  await input.fill('Second test')
  await gpt.waitForTimeout(800)
  const buttons = await gpt.evaluate(() => [...document.querySelectorAll('button, [role="button"]')].filter((el) => !!(el.offsetWidth || el.offsetHeight)).map((el) => ({ tag: el.tagName, aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid'), text: (el.innerText || '').trim().slice(0, 40), cls: typeof el.className === 'string' ? el.className.slice(0, 80) : '' })))
  console.log('GPT BUTTONS AFTER FILL', JSON.stringify(buttons, null, 2))
} finally {
  await gpt.close()
}

const qwen = await context.newPage()
try {
  await qwen.goto('https://chat.qwen.ai/', { waitUntil: 'commit', timeout: 90000 })
  await qwen.waitForTimeout(9000)
  const ageVisible = await qwen.getByText('Confirm your age to continue').isVisible().catch(() => false)
  console.log('age modal', ageVisible)
  if (ageVisible) {
    const continueBtn = qwen.getByRole('button', { name: 'Continue' })
    console.log('continue count', await continueBtn.count())
    if (await continueBtn.count()) await continueBtn.click()
    await qwen.waitForTimeout(2500)
  }
  const input = qwen.locator('textarea.message-input-textarea').first()
  await input.fill('Reply with exactly: TEST_OK')
  await qwen.waitForTimeout(1000)
  await save(qwen, 'qwen2-filled')
  await qwen.keyboard.press('Enter')
  await qwen.waitForTimeout(20000)
  await save(qwen, 'qwen2-after-send')
} finally {
  await qwen.close()
}

await context.close()
