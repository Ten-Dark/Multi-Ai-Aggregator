import { chromium } from 'playwright'
import path from 'node:path'

const userDataDir = path.join(process.env.APPDATA || '', 'Multi-AI Aggregator', 'browser-profile')
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1440, height: 1000 },
  args: ['--no-first-run', '--no-default-browser-check'],
})

const page = context.pages()[0] || (await context.newPage())
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(8000)

const info = await page.evaluate(() => {
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  const text = (element) => ((element.innerText || element.textContent || '').trim()).slice(0, 300)
  return {
    url: location.href,
    title: document.title,
    body: (document.body?.innerText || '').slice(0, 4000),
    inputs: Array.from(document.querySelectorAll('input')).map((element) => ({
      type: element.type,
      name: element.name,
      placeholder: element.placeholder,
      visible: isVisible(element),
    })),
    textareas: Array.from(document.querySelectorAll('textarea')).map((element) => ({
      id: element.id,
      name: element.name,
      placeholder: element.placeholder,
      visible: isVisible(element),
    })),
    contenteditables: Array.from(document.querySelectorAll('[contenteditable="true"]')).map((element) => ({
      role: element.getAttribute('role'),
      className: element.className,
      visible: isVisible(element),
    })),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter(isVisible).map(text),
    visibleButtons: Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .map(text)
      .filter(Boolean)
      .slice(0, 40),
  }
})

console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: 'probe/deepseek-app-profile.png', fullPage: true })
await context.close()
