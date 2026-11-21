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
const page = context.pages()[0] || (await context.newPage())

async function snapshot(name) {
  const data = await page.evaluate(() => {
    const clip = (s, n) => (s || '').slice(0, n)
    return {
      url: location.href,
      title: document.title,
      bodyText: clip(document.body?.innerText, 10000),
      sendCandidates: [...document.querySelectorAll('[class*="send"], [class*="stop"], button[aria-label]')].map((el) => ({
        tag: el.tagName,
        cls: clip(typeof el.className === 'string' ? el.className : '', 160),
        aria: el.getAttribute('aria-label'),
        text: clip((el.innerText || '').trim(), 80),
        visible: !!(el.offsetWidth || el.offsetHeight)
      })),
      markdownNodes: [...document.querySelectorAll('[class*="markdown"], [class*="prose"], [class*="message-content"], [data-message-role], [data-message-author-role]')].map((el) => ({
        tag: el.tagName,
        cls: clip(typeof el.className === 'string' ? el.className : '', 160),
        role: el.getAttribute('data-message-role') || el.getAttribute('data-message-author-role'),
        text: clip((el.innerText || '').trim(), 1000),
        visible: !!(el.offsetWidth || el.offsetHeight)
      })).slice(0, 100),
      dialogs: [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"]')].map((el) => ({
        cls: clip(typeof el.className === 'string' ? el.className : '', 160),
        text: clip((el.innerText || '').trim(), 500),
        visible: !!(el.offsetWidth || el.offsetHeight)
      }))
    }
  })
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8')
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })
  console.log(`== ${name} ==\n${JSON.stringify({ bodyText: data.bodyText.slice(0, 2500), dialogs: data.dialogs, sendCandidates: data.sendCandidates.filter((s) => s.visible && (s.aria || /send|stop/i.test(s.cls))) }, null, 2)}`)
  return data
}

try {
  await page.goto('https://chat.qwen.ai/', { waitUntil: 'commit', timeout: 90000 })
  await page.waitForTimeout(12000)
  const input = page.locator('textarea.message-input-textarea').first()
  await input.fill('Reply with exactly: TEST_OK')
  await page.waitForTimeout(1500)
  await snapshot('qwen3-filled')
  const send = page.locator('button.send-button[aria-label="Send"], .message-input-right-button-send').first()
  console.log('send visible', await send.isVisible().catch(() => false))
  await send.click().catch((e) => console.log('send err', e.message))
  await page.waitForTimeout(4000)
  await snapshot('qwen3-after-click')

  const ageDialog = page.getByText('Confirm your age to continue')
  if (await ageDialog.isVisible().catch(() => false)) {
    console.log('AGE DIALOG SHOWN')
    const selects = page.locator('[role="dialog"] select, [class*="dialog"] select, select')
    console.log('select count', await selects.count())
    if (await selects.count()) {
      await selects.first().selectOption({ label: '2000' }).catch(() => {})
      await page.waitForTimeout(500)
    }
    await page.getByRole('button', { name: 'Continue' }).click().catch((e) => console.log('continue err', e.message))
    await page.waitForTimeout(4000)
    await snapshot('qwen3-after-age')
  }

  await input.fill('Reply with exactly: TEST_OK')
  await page.waitForTimeout(1000)
  await page.locator('button.send-button[aria-label="Send"], .message-input-right-button-send').first().click().catch((e) => console.log('send2 err', e.message))
  await page.waitForTimeout(30000)
  await snapshot('qwen3-after-send')
} finally {
  await context.close()
}
