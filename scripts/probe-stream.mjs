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

async function inspect(page, label) {
  const data = await page.evaluate(() => ({
    url: location.href,
    bodyText: (document.body?.innerText || '').slice(0, 1200),
    gptMessages: [...document.querySelectorAll('[data-message-role="assistant"], [data-message-author-role="assistant"]')].map((el) => ({
      complete: el.getAttribute('data-message-complete'),
      started: el.getAttribute('data-assistant-content-started'),
      text: (el.innerText || '').slice(0, 400)
    })),
    gptButtons: [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')].filter((el) => !!(el.offsetWidth || el.offsetHeight)).map((el) => ({
      aria: el.getAttribute('aria-label'),
      testid: el.getAttribute('data-testid'),
      cls: typeof el.className === 'string' ? el.className.slice(0, 100) : ''
    })),
    qwenResponses: [...document.querySelectorAll('.response-message-content, .user-message-content, [class*="thinking"]')].map((el) => ({
      cls: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
      text: (el.innerText || '').slice(0, 500),
      visible: !!(el.offsetWidth || el.offsetHeight)
    })),
    qwenButtons: [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')].filter((el) => !!(el.offsetWidth || el.offsetHeight)).map((el) => ({
      aria: el.getAttribute('aria-label'),
      cls: typeof el.className === 'string' ? el.className.slice(0, 120) : ''
    }))
  }))
  console.log(`== ${label} ==\n${JSON.stringify(data, null, 2).slice(0, 7000)}`)
  fs.writeFileSync(path.join(outDir, `stream-${label}.json`), JSON.stringify(data, null, 2), 'utf8')
  await page.screenshot({ path: path.join(outDir, `stream-${label}.png`), fullPage: true })
}

const gpt = await context.newPage()
try {
  await gpt.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: 90000 })
  await gpt.waitForTimeout(7000)
  const input = gpt.locator('textarea#mobile-composer-prompt, textarea[name="prompt"], #prompt-textarea').first()
  await input.fill('Напиши список из 30 чисел от 1 до 30, каждое на новой строке. Без пояснений.')
  await gpt.waitForTimeout(1000)
  await gpt.locator('button[aria-label*="Отправить"], button[aria-label*="Send"], [data-testid="send-button"]').first().click()
  await gpt.waitForTimeout(1200)
  await inspect(gpt, 'gpt-t1')
  await gpt.waitForTimeout(3000)
  await inspect(gpt, 'gpt-t2')
  await gpt.waitForTimeout(6000)
  await inspect(gpt, 'gpt-t3')
  await gpt.waitForTimeout(15000)
  await inspect(gpt, 'gpt-t4')
} finally {
  await gpt.close()
}

const qwen = await context.newPage()
try {
  await qwen.goto('https://chat.qwen.ai/', { waitUntil: 'commit', timeout: 90000 })
  await qwen.waitForTimeout(11000)
  const input = qwen.locator('textarea.message-input-textarea').first()
  await input.fill('Напиши список из 30 чисел от 1 до 30, каждое на новой строке. Без пояснений.')
  await qwen.waitForTimeout(1000)
  await qwen.locator('button.send-button[aria-label="Send"], .message-input-right-button-send').first().click()
  await qwen.waitForTimeout(1200)
  await inspect(qwen, 'qwen-t1')
  await qwen.waitForTimeout(3000)
  await inspect(qwen, 'qwen-t2')
  await qwen.waitForTimeout(6000)
  await inspect(qwen, 'qwen-t3')
  await qwen.waitForTimeout(15000)
  await inspect(qwen, 'qwen-t4')
} finally {
  await qwen.close()
}

await context.close()
