import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const profile = path.join(root, '.probe-profile')
const outDir = path.join(root, 'probe')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(profile, { recursive: true })

const sites = [
  { id: 'chatgpt', url: 'https://chatgpt.com/' },
  { id: 'qwen', url: 'https://chat.qwen.ai/' },
  { id: 'deepseek', url: 'https://chat.deepseek.com/' }
]

const context = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--start-maximized'],
  acceptDownloads: false
})

const report = {}

for (const site of sites) {
  const page = await context.newPage()
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(10000)
    const data = await page.evaluate(() => {
      const describe = (el, index) => {
        const attrs = {}
        for (const a of el.attributes) attrs[a.name] = a.value.slice(0, 200)
        const text = (el.innerText || el.textContent || '').trim().slice(0, 200)
        return {
          index,
          tag: el.tagName.toLowerCase(),
          attrs,
          text: text.slice(0, 160),
          disabled: el.disabled ?? null
        }
      }
      const queries = {
        textareas: [...document.querySelectorAll('textarea')].map(describe),
        contenteditables: [...document.querySelectorAll('[contenteditable="true"]')].map(describe),
        buttons: [...document.querySelectorAll('button, [role="button"]')].filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }).slice(0, 80).map(describe),
        loginLinks: [...document.querySelectorAll('a')].filter((el) => /log\s*in|sign\s*in|войти|登录/i.test((el.innerText || '') + ' ' + (el.getAttribute('href') || ''))).slice(0, 20).map(describe),
        messageLike: [...document.querySelectorAll('[class*="markdown"], [class*="prose"], [class*="message"], [data-message-author-role], [class*="chat-message"]')].slice(0, 60).map((el) => {
          const r = el.getBoundingClientRect()
          return { ...describe(el, 0), visible: r.width > 0 && r.height > 0 }
        }),
        headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 20).map((el) => (el.innerText || '').trim())
      }
      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || '').slice(0, 3000),
        language: document.documentElement.lang,
        queries
      }
    })
    report[site.id] = data
    await page.screenshot({ path: path.join(outDir, `${site.id}.png`), fullPage: true })
  } catch (err) {
    report[site.id] = { error: String(err) }
  }
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
await context.close()
