import { _electron as electron } from 'playwright'
import path from 'node:path'

const app = await electron.launch({
  executablePath: path.resolve('release/win-unpacked/Multi-AI Aggregator.exe'),
})
app.process().stderr?.on('data', (chunk) => process.stderr.write(`[app:err] ${chunk}`))

const window = await app.firstWindow()
window.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))
await window.waitForSelector('h1', { timeout: 30_000 })
console.log('title:', await window.title())
console.log('app path:', await app.evaluate(({ app }) => app.getAppPath()))

const deadline = Date.now() + 60_000
let sessions = []
while (Date.now() < deadline) {
  sessions = await window.locator('.session-chip').allInnerTexts()
  if (sessions.length === 3 && !sessions.some((text) => text.includes('Проверк'))) break
  await window.waitForTimeout(1000)
}
console.log('sessions:', JSON.stringify(sessions, null, 2))
console.log('api available:', await window.evaluate(() => typeof window.aggregator === 'object'))
await window.screenshot({ path: 'smoke-packaged.png', fullPage: true })
await app.close()
