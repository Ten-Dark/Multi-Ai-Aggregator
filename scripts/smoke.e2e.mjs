import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

if (process.env.MAI_ALLOW_USER_PROFILE_SMOKE !== '1') {
  throw new Error('Refusing to launch against the normal user profile. Set MAI_ALLOW_USER_PROFILE_SMOKE=1 explicitly.')
}

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
})

app.process().stdout?.on('data', (chunk) => process.stdout.write(`[app] ${chunk}`))
app.process().stderr?.on('data', (chunk) => process.stderr.write(`[app:err] ${chunk}`))

const window = await app.firstWindow()
window.on('console', (message) => console.log(`[console:${message.type()}] ${message.text()}`))
window.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))

await window.waitForSelector('h1', { timeout: 30_000 })
console.log('title:', await window.title())

const deadline = Date.now() + 45_000
let sessionTexts = []
while (Date.now() < deadline) {
  sessionTexts = await window.locator('.session-chip').allInnerTexts()
  if (sessionTexts.length === 3 && !sessionTexts.some((text) => text.includes('Проверка'))) break
  await window.waitForTimeout(1000)
}

console.log('sessions:', JSON.stringify(sessionTexts, null, 2))
console.log(
  'session details:',
  JSON.stringify(await window.locator('.session-chip').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title'))), null, 2),
)
console.log('browser badge:', await window.locator('.browser-badge').innerText())
console.log('send button disabled:', await window.locator('.query-actions .button.primary').isDisabled())
console.log('synthesis button disabled:', await window.locator('.synthesis-controls .button.primary').isDisabled())

await window.locator('.pairing-code').evaluate((element) => { element.textContent = '[REDACTED]' }).catch(() => {})
const diagnosticsDirectory = path.join(process.cwd(), 'artifacts', 'diagnostics', 'smoke')
fs.mkdirSync(diagnosticsDirectory, { recursive: true })
const shotPath = path.join(diagnosticsDirectory, 'smoke-main.png')
await window.screenshot({ path: shotPath, fullPage: true })
console.log('screenshot:', shotPath)

await app.close()
