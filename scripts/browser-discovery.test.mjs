import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWindowsBrowserProcesses } from '../dist-electron/main/browser/browser-discovery.js'

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
