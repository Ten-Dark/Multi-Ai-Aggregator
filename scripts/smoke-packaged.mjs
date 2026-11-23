import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

if (process.env.MAI_ALLOW_USER_PROFILE_SMOKE !== '1') {
  throw new Error('Refusing to launch against the normal user profile. Set MAI_ALLOW_USER_PROFILE_SMOKE=1 explicitly.')
}

const app = await electron.launch({
  executablePath: path.resolve('artifacts/build/windows/win-unpacked/Multi-AI Aggregator.exe'),
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
await window.locator('.pairing-code').evaluate((element) => { element.textContent = '[REDACTED]' }).catch(() => {})
const diagnosticsDirectory = path.resolve('artifacts/diagnostics/smoke')
fs.mkdirSync(diagnosticsDirectory, { recursive: true })
await window.screenshot({ path: path.join(diagnosticsDirectory, 'smoke-packaged.png'), fullPage: true })
await app.close()
