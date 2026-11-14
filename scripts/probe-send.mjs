import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'probe')

const context = await chromium.launchPersistentContext(path.join(root, '.probe-profile'), {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 900 }
})

async function dump(page, name) {
  const data = await page.evaluate(() => {
    const composer = document.querySelector('textarea, [contenteditable="true"]')
    const composerHtml = composer?.parentElement?.parentElement?.outerHTML?.slice(0, 5000) || ''
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 5000),
      composerHtml,
      sendCandidates: [...document.querySelectorAll('[class*="send"], [aria-label*="Send"], [aria-label*="send"], [data-testid*="send"], [data-testid*="stop"]')].map((el) => ({
        tag: el.tagName,
        cls: el.className?.toString().slice(0, 150),
        aria: el.getAttribute('aria-label'),
        testid: el.getAttribute('data-testid'),
        text: (el.innerText || '').slice(0, 60),
        visible: !!(el.offsetWidth || el.offsetHeight)
      })),
      assistantCandidates: [...document.querySelectorAll('[class*="markdown"], [class*="prose"], [data-message-author-role], [class*="assistant"], [class*="response"]')].map((el) => ({
        tag: el.tagName,
        cls: el.className?.toString().slice(0, 150),
        role: el.getAttribute('data-message-author-role'),
        text: (el.innerText || '').slice(0, 200),
        visible: !!(el.offsetWidth || el.offsetHeight)
      })).slice(0, 80),
      messagesHtml: document.querySelector('main, [class*="chat-container"], [class*="conversation"]')?.outerHTML?.slice(0, 12000) || ''
    }
  })
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8')
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true })
  console.log(`=== ${name} ===`)
  console.log(JSON.stringify({ url: data.url, title: data.title, bodyText: data.bodyText.slice(0, 1500), sendCandidates: data.sendCandidates }, null, 2))
}

const qwen = context.pages()[0] || (await context.newPage())
await qwen.goto('https://chat.qwen.ai/', { waitUntil: 'commit', timeout: 90000 })
await qwen.waitForTimeout(10000)
const cookieBtn = qwen.getByRole('button', { name: 'Accept all cookies' })
if (await cookieBtn.count()) await cookieBtn.click().catch(() => {})
await qwen.waitForTimeout(1000)
const qwenInput = qwen.locator('textarea.message-input-textarea').first()
await qwenInput.fill('Reply with exactly: TEST_OK')
await qwen.waitForTimeout(1500)
await dump(qwen, 'qwen-filled')

const qwenSend = qwen.locator('.message-input-right-button-send').first()
console.log('qwen send count', await qwenSend.count(), 'visible', await qwenSend.isVisible().catch(() => false))
if (await qwenSend.count()) {
  await qwenSend.click().catch((e) => console.log('qwen send click err', e.message))
  await qwen.waitForTimeout(15000)
  await dump(qwen, 'qwen-after-send')
}

const gpt = await context.newPage()
await gpt.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: 90000 })
await gpt.waitForTimeout(8000)
await dump(gpt, 'gpt-initial')
const gptInput = gpt.locator('textarea#mobile-composer-prompt, textarea[name="prompt"], #prompt-textarea').first()
console.log('gpt input count', await gptInput.count())
if (await gptInput.count()) {
  await gptInput.fill('Reply with exactly: TEST_OK')
  await gpt.waitForTimeout(1000)
  await dump(gpt, 'gpt-filled')
  const sendBtn = gpt.locator('[data-testid="send-button"], button[aria-label*="Отправить"], button[aria-label*="Send"]').first()
  console.log('gpt send count', await sendBtn.count(), 'visible', await sendBtn.isVisible().catch(() => false))
  if (await sendBtn.count()) {
    await sendBtn.click().catch((e) => console.log('gpt send click err', e.message))
    await gpt.waitForTimeout(5000)
    await dump(gpt, 'gpt-after-send')
  }
}

await context.close()
