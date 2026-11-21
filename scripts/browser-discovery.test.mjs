import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserDiscoveryRegistry, parseWindowsBrowserProcesses } from '../dist-electron/main/browser/browser-discovery.js'
import { parseUnixBrowserProcesses } from '../dist-electron/main/browser/unix-browser-discovery.js'

test('discovers Zen portable profile from a quoted Firefox-family command line', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 4120,
    ParentProcessId: 900,
    Name: 'zen.exe',
    ExecutablePath: 'X:\\BrowserPortal\\App\\zen.exe',
    CommandLine: '"X:\\BrowserPortal\\App\\zen.exe" -profile "X:\\BrowserPortal\\ZenProfile"',
    CreationDate: '2026-11-21T10:00:00.000Z',
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].product, 'Zen Browser')
  assert.equal(result[0].family, 'firefox')
  assert.equal(result[0].profilePath, 'X:\\BrowserPortal\\ZenProfile')
  assert.equal(result[0].profileSource, 'firefox-profile-argument')
  assert.equal(result[0].confidence, 'high')
})

test('parses Chromium user data and profile directory arguments with spaces', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 200,
    ParentProcessId: 1,
    Name: 'chrome.exe',
    ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    CommandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="D:\\Browser Data\\Chrome" --profile-directory="Profile 2"',
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].family, 'chromium')
  assert.equal(result[0].profilePath, 'D:\\Browser Data\\Chrome')
  assert.equal(result[0].profileName, 'Profile 2')
  assert.equal(result[0].confidence, 'high')
})

test('supports split profile flags and Unicode portable paths', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 201,
    ParentProcessId: 1,
    Name: 'firefox.exe',
    CommandLine: '"C:\\Apps\\Firefox\\firefox.exe" -profile "X:\\Браузеры\\Рабочий профиль"',
  })

  assert.equal(result[0].profilePath, 'X:\\Браузеры\\Рабочий профиль')
})

test('keeps default profile inference explicit and lower confidence', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 202,
    ParentProcessId: 1,
    Name: 'msedge.exe',
    CommandLine: '"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" --type=renderer',
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].profilePath, undefined)
  assert.equal(result[0].profileSource, 'default-or-unknown')
  assert.equal(result[0].confidence, 'medium')
})

test('retains custom browser executables as unknown candidates only with profile flags', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 203,
    ParentProcessId: 1,
    Name: 'CustomBrowser.exe',
    CommandLine: '"X:\\Portable\\CustomPortable.exe" --user-data-dir="X:\\Profiles\\Custom"',
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].family, 'unknown')
  assert.equal(result[0].product, 'CustomBrowser')
  assert.equal(result[0].profilePath, 'X:\\Profiles\\Custom')
  assert.equal(result[0].confidence, 'low')
})

test('ignores malformed process rows and unrelated processes', () => {
  const result = parseWindowsBrowserProcesses([
    null,
    { ProcessId: '123', ParentProcessId: 1, Name: 'chrome.exe' },
    { ProcessId: 1, ParentProcessId: 0, Name: 'notepad.exe', CommandLine: 'notepad.exe' },
    { ProcessId: 2, ParentProcessId: 0, Name: 'chrome.exe', CommandLine: 'chrome.exe' },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].processId, 2)
})

test('collapses browser child processes into the owning browser process', () => {
  const result = parseWindowsBrowserProcesses([
    { ProcessId: 10, ParentProcessId: 1, Name: 'zen.exe', CommandLine: 'zen.exe -profile "X:\\ZenProfile"' },
    { ProcessId: 11, ParentProcessId: 10, Name: 'zen.exe', CommandLine: 'zen.exe -contentproc' },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0].processId, 10)
  assert.equal(result[0].profilePath, 'X:\\ZenProfile')
})

test('keeps separate browser profile roots as independent candidates', () => {
  const result = parseWindowsBrowserProcesses([
    { ProcessId: 20, ParentProcessId: 1, Name: 'zen.exe', CommandLine: 'zen.exe -profile "X:\\Profile One"' },
    { ProcessId: 30, ParentProcessId: 1, Name: 'zen.exe', CommandLine: 'zen.exe -profile "Y:\\Profile Two"' },
  ])

  assert.equal(result.length, 2)
  assert.deepEqual(result.map((item) => item.profilePath), ['X:\\Profile One', 'Y:\\Profile Two'])
})

test('assigns stable distinct instance identifiers to separate browser profiles', () => {
  const makeProcess = (processId, profilePath) => parseWindowsBrowserProcesses({
    ProcessId: processId,
    ParentProcessId: 1,
    Name: 'zen.exe',
    ExecutablePath: 'X:\\BrowserPortal\\App\\zen.exe',
    CommandLine: 'zen.exe -profile "' + profilePath + '"',
  })[0]

  const first = makeProcess(21, 'X:\\Profile One')
  const second = makeProcess(31, 'Y:\\Profile Two')
  const relaunched = makeProcess(99, 'X:\\Profile One')

  assert.ok(first.instanceId)
  assert.notEqual(first.instanceId, second.instanceId)
  assert.equal(first.instanceId, relaunched.instanceId)
})

test('includes visible window metadata when supplied by the OS provider', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 40,
    ParentProcessId: 1,
    Name: 'zen.exe',
    CommandLine: 'zen.exe -profile "X:\\ZenProfile"',
    WindowTitle: 'ChatGPT — Zen Browser',
    HasVisibleWindow: true,
  })

  assert.equal(result[0].hasVisibleWindow, true)
  assert.equal(result[0].windowTitle, 'ChatGPT — Zen Browser')
})

test('registry selects a matching provider and reports unsupported platforms explicitly', async () => {
  let calls = 0
  const provider = {
    id: 'fake-linux-provider',
    supportedPlatforms: ['linux'],
    async discover() {
      calls += 1
      return { platform: 'linux', scannedAt: 123, status: 'available', processes: [], message: 'ok' }
    },
  }
  const registry = new BrowserDiscoveryRegistry([provider])
  const supported = await registry.discover('linux')
  const unsupported = await registry.discover('darwin')

  assert.equal(supported.status, 'available')
  assert.equal(calls, 1)
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupported.platform, 'darwin')
  assert.equal(calls, 1)
})

test('identifies renamed browser executables from executable version metadata', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 501,
    ParentProcessId: 1,
    Name: 'browser-shell.exe',
    ExecutablePath: 'D:\\Portable\\browser-shell.exe',
    CommandLine: 'browser-shell.exe --profile-directory=Default',
    FileDescription: 'Zen Browser',
    ProductName: 'Zen Browser',
    CompanyName: 'Zen-Team',
    HasVisibleWindow: true,
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].family, 'firefox')
  assert.equal(result[0].product, 'Zen Browser')
})

test('identifies Chromium browsers from product metadata without known executable names', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 502,
    ParentProcessId: 1,
    Name: 'app.exe',
    ProductName: 'Google Chrome',
    FileDescription: 'Google Chrome',
    CompanyName: 'Google LLC',
    HasVisibleWindow: true,
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].family, 'chromium')
  assert.equal(result[0].product, 'Google Chrome')
})

test('does not classify unrelated Electron apps from generic browser-like metadata', () => {
  const result = parseWindowsBrowserProcesses({
    ProcessId: 503,
    ParentProcessId: 1,
    Name: 'dashboard.exe',
    CommandLine: 'dashboard.exe --user-data-dir="D:\\Profiles\\Dashboard"',
    ProductName: 'Acme Desktop',
    FileDescription: 'Electron application browser dashboard',
    CompanyName: 'Acme Corporation',
    HasVisibleWindow: true,
  })

  assert.equal(result.length, 0)
})

test('discovers Firefox and Chromium processes on Unix-like systems with distinct profiles', () => {
  const result = parseUnixBrowserProcesses([
    '  100  1 firefox /usr/lib/firefox/firefox -profile "/home/user/Profiles/Work"',
    '  101  1 chromium /usr/bin/chromium --user-data-dir="/home/user/.config/chromium" --profile-directory="Profile 2"',
    '  102  101 chromium /usr/lib/chromium/chromium --type=renderer',
  ].join('\n'))

  assert.equal(result.length, 2)
  assert.equal(result[0].product, 'Chromium')
  assert.equal(result[0].profilePath, '/home/user/.config/chromium')
  assert.equal(result[0].profileName, 'Profile 2')
  assert.equal(result[1].product, 'Firefox')
  assert.equal(result[1].profilePath, '/home/user/Profiles/Work')
})

test('recognizes common macOS browser executable names and ignores unrelated processes', () => {
  const result = parseUnixBrowserProcesses([
    '  200  1 zen /Applications/Zen\\ Browser.app/Contents/MacOS/zen -profile "/Users/user/Library/Application Support/Zen"',
    '  201  1 Brave Browser /Applications/Brave\\ Browser.app/Contents/MacOS/Brave\\ Browser',
    '  202  1 slack /Applications/Slack.app/Contents/MacOS/Slack',
  ].join('\n'))

  assert.equal(result.length, 2)
  assert.equal(result[0].product, 'Brave')
  assert.equal(result[1].product, 'Zen Browser')
  assert.equal(result[1].profilePath, '/Users/user/Library/Application Support/Zen')
})
