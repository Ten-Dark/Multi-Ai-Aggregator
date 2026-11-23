import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

if (process.env.MAI_ALLOW_USER_PROFILE_SMOKE !== '1') {
  throw new Error('Refusing to launch the app against the normal user profile. Set MAI_ALLOW_USER_PROFILE_SMOKE=1 explicitly.')
}
if (process.env.MAI_ALLOW_LIVE_PROVIDER_TESTS !== '1') {
  throw new Error('Refusing to submit a real provider prompt. Set MAI_ALLOW_LIVE_PROVIDER_TESTS=1 explicitly.')
}

const zenExecutable = process.env.MAI_ZEN_EXECUTABLE_PATH
if (!zenExecutable || !path.isAbsolute(zenExecutable) || !fs.existsSync(zenExecutable)) {
  throw new Error('Set MAI_ZEN_EXECUTABLE_PATH to the absolute path of the Zen executable used for the isolated test profile.')
}

const project = process.cwd()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-ai-aggregator-zen-integration-'))
const profile = path.join(root, 'profile')
const stage = path.join(root, 'stage')
const xpiZip = path.join(root, 'extension.zip')
const xpi = path.join(root, 'multi-ai-aggregator-zen.xpi')
const logPath = path.join(root, 'zen.log')
const zipScript = path.join(root, 'create-extension.ps1')

let app
let zen
let logFd
let sendResult = null

const logResult = (label, result) => {
  console.log(label, JSON.stringify({
    status: result?.status,
    errorCode: result?.errorCode,
    hasText: Boolean(result?.text),
    textLength: result?.text?.length ?? 0,
  }))
}

async function waitForText(page, selector, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  while (Date.now() < deadline) {
    lastText = await page.locator(selector).allInnerTexts().then((texts) => texts.join('\n'))
    if (predicate(lastText)) return lastText
    await page.waitForTimeout(1000)
  }
  throw new Error(`Timeout waiting for ${label}.`)
}

try {
  app = await electron.launch({ args: ['.'], cwd: project })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('APP_PAGE_ERROR', error.name))
  await page.waitForSelector('h1', { timeout: 30_000 })

  const codeLocator = page.locator('.pairing-code')
  await codeLocator.waitFor({ timeout: 20_000 })
  const pairingCode = (await codeLocator.innerText()).trim()
  const pairingCodeValid = pairingCode.startsWith('ws://127.0.0.1:') && pairingCode.includes('|')
  console.log('PAIRING_CODE_READY', pairingCodeValid)
  if (!pairingCodeValid) throw new Error('Pairing code is not ready.')

  fs.cpSync(path.join(project, 'zen-extension'), stage, { recursive: true })
  const manifestPath = path.join(stage, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.name = 'Multi-AI Aggregator Bridge [Integration Test]'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  fs.writeFileSync(
    path.join(stage, 'dev-pairing.json'),
    JSON.stringify({ code: pairingCode }),
    { mode: 0o600 },
  )

  fs.writeFileSync(zipScript, [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$SourcePath,',
    '  [Parameter(Mandatory=$true)][string]$DestinationPath,',
    '  [Parameter(Mandatory=$true)][string]$FinalPath',
    ')',
    '$ErrorActionPreference = "Stop"',
    'Compress-Archive -Path (Join-Path $SourcePath "*") -DestinationPath $DestinationPath -Force',
    'Copy-Item -LiteralPath $DestinationPath -Destination $FinalPath -Force',
  ].join('\n'))

  execFileSync('powershell.exe', [
    '-NoProfile',
    '-File',
    zipScript,
    '-SourcePath',
    stage,
    '-DestinationPath',
    xpiZip,
    '-FinalPath',
    xpi,
  ], { stdio: 'ignore' })

  fs.mkdirSync(path.join(profile, 'extensions'), { recursive: true })
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
  fs.copyFileSync(xpi, path.join(profile, 'extensions', 'multi-ai-aggregator@local.xpi'))

  logFd = fs.openSync(logPath, 'w')
  zen = spawn(
    zenExecutable,
    ['-no-remote', '-new-instance', '-headless', '-profile', profile],
    { stdio: ['ignore', logFd, logFd] },
  )
  zen.once('error', (error) => console.error('ZEN_SPAWN_FAILED', error.name))
  console.log('ZEN_STARTED', Boolean(zen.pid))

  const badge = await waitForText(
    page,
    '.browser-badge',
    (value) => value.includes('подключён'),
    90_000,
    'Zen connection',
  )
  console.log('BRIDGE_CONNECTED', Boolean(badge))

  const panels = await waitForText(
    page,
    '.session-chip',
    (value) => {
      const lines = value.split('\n').filter(Boolean)
      return lines.length >= 6 && !value.includes('Проверка')
    },
    90_000,
    'provider session check',
  )
  console.log('SESSION_CHECK_COMPLETED', Boolean(panels))

  const connection = await page.evaluate(() => window.aggregator.getZenConnection())
  console.log('CONNECTION', JSON.stringify({
    connected: connection.connected,
    extensionVersion: connection.extensionVersion,
    pairingCodePresent: Boolean(connection.pairingCode),
  }))

  sendResult = await page.evaluate(() =>
    window.aggregator.sendOne('chatgpt', 'Ответь ровно одним словом: ОК'),
  )
  logResult('SEND_RESULT', sendResult)
  await page.waitForTimeout(1000)
} catch (error) {
  console.error('INTEGRATION_FAILED', error instanceof Error ? error.name : 'UnknownError')
  process.exitCode = 1
} finally {
  if (zen?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(zen.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      zen.kill()
    }
  }
  await app?.close().catch(() => {})
  if (logFd !== undefined) fs.closeSync(logFd)
  fs.rmSync(root, { recursive: true, force: true })
}

if (sendResult?.status !== 'done') process.exitCode = 1
