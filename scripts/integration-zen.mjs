import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const project = process.cwd()
const root = 'C:\\Users\\Sondr\\AppData\\Local\\Temp\\opencode\\zen-ext-test\\app-integration'
const profile = path.join(root, 'profile')
const stage = path.join(root, 'stage')
const xpiZip = path.join(root, 'extension.zip')
const xpi = path.join(root, 'multi-ai-aggregator-zen.xpi')
const logPath = path.join(root, 'zen.log')

fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: project })
app.process().stderr?.on('data', (chunk) => process.stderr.write(`[app:err] ${chunk}`))
const page = await app.firstWindow()
page.on('console', (message) => console.log(`[console:${message.type()}] ${message.text()}`))
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`))
await page.waitForSelector('h1', { timeout: 30_000 })

const codeLocator = page.locator('.pairing-code')
await codeLocator.waitFor({ timeout: 20_000 })
const pairingCode = (await codeLocator.innerText()).trim()
console.log('PAIRING_CODE_READY', pairingCode.startsWith('ws://127.0.0.1:') && pairingCode.includes('|'))
if (!pairingCode.startsWith('ws://127.0.0.1:')) throw new Error('Pairing code is not ready.')

fs.cpSync(path.join(project, 'zen-extension'), stage, { recursive: true })
const manifestPath = path.join(stage, 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.name = 'Multi-AI Aggregator Bridge [Integration Test]'
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
fs.writeFileSync(path.join(stage, 'dev-pairing.json'), JSON.stringify({ code: pairingCode }))
execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${stage}\\*' -DestinationPath '${xpiZip}' -Force; Copy-Item -LiteralPath '${xpiZip}' -Destination '${xpi}' -Force`,
])

fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(
  path.join(profile, 'user.js'),
  [
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("extensions.enabledScopes", 15);',
    'user_pref("extensions.update.enabled", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.startup.homepage", "about:blank");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("datareporting.healthreport.uploadEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
  ].join('\n'),
)
fs.mkdirSync(path.join(profile, 'extensions'), { recursive: true })
fs.copyFileSync(xpi, path.join(profile, 'extensions', 'multi-ai-aggregator@local.xpi'))

const log = fs.openSync(logPath, 'w')
const zen = spawn(
  'D:\\programs\\browsers\\zen.exe',
  ['-no-remote', '-new-instance', '-headless', '-profile', profile],
  { stdio: ['ignore', log, log] },
)
console.log('ZEN_PID', zen.pid)

async function waitForText(selector, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  while (Date.now() < deadline) {
    lastText = await page.locator(selector).allInnerTexts().then((texts) => texts.join('\n'))
    if (predicate(lastText)) return lastText
    await page.waitForTimeout(1000)
  }
  throw new Error(`Timeout waiting for ${label}. Last text: ${lastText}`)
}

let sendResult = null
try {
  const badge = await waitForText('.browser-badge', (text) => text.includes('подключён'), 90_000, 'Zen connection')
  console.log('BADGE', badge)
  const panels = await waitForText(
    '.session-chip',
    (text) => {
      const lines = text.split('\n').filter(Boolean)
      return lines.length >= 6 && !text.includes('Проверка')
    },
    90_000,
    'session check',
  )
  console.log('SESSIONS', panels)

  const connection = await page.evaluate(() => window.aggregator.getZenConnection())
  console.log('CONNECTION', JSON.stringify({
    wsUrl: connection.wsUrl,
    connected: connection.connected,
    extensionVersion: connection.extensionVersion,
    pairingCodePresent: Boolean(connection.pairingCode),
  }))

  sendResult = await page.evaluate(() =>
    window.aggregator.sendOne('chatgpt', 'Ответь ровно одним словом: ОК'),
  )
  console.log('SEND_RESULT', JSON.stringify(sendResult))
  await page.waitForTimeout(1000)
} catch (error) {
  console.error('INTEGRATION_ERROR', error instanceof Error ? error.message : error)
} finally {
  try {
    execFileSync('taskkill', ['/PID', String(zen.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // Ignore.
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await page.screenshot({ path: path.join(project, 'smoke-zen.png'), fullPage: true }).catch(() => {})
  await app.close().catch(() => {})
  fs.closeSync(log)
  fs.rmSync(root, { recursive: true, force: true })
}

console.log('RESULT', JSON.stringify({ sendStatus: sendResult?.status, sendText: sendResult?.text, sendError: sendResult?.error }))
if (sendResult?.status !== 'done') process.exitCode = 1
