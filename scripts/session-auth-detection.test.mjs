import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const background = readFileSync(new URL('../zen-extension/background.js', import.meta.url), 'utf8')
const helperStart = background.indexOf('const SESSION_COOKIE_NAME_PATTERNS =')
const helperEnd = background.indexOf('async function inspectModelSession(', helperStart)
assert.notEqual(helperStart, -1)
assert.notEqual(helperEnd, -1)
const helperSource = background.slice(helperStart, helperEnd)

function createCookieInspector(cookies, available = true) {
  const browser = {
    cookies: available
      ? { getAll: async () => cookies }
      : undefined,
  }
  return runInNewContext(`${helperSource}; getProviderCookieEvidence`, { browser, Date })
}

test('cookie evidence exposes only a boolean and never cookie values', async () => {
  const secret = 'must-never-leave-cookie-storage'
  const inspect = createCookieInspector([
    {
      name: '__Secure-next-auth.session-token',
      value: secret,
      session: false,
      expirationDate: Date.now() / 1000 + 3600,
    },
  ])

  const result = await inspect('chatgpt', 'https://chatgpt.com/')
  assert.deepEqual({ ...result }, { available: true, sessionCookiePresent: true })
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(helperSource.includes('cookie.value'), false)
})

test('expired provider session cookies are not reported as present', async () => {
  const inspect = createCookieInspector([
    {
      name: 'ds_session_id',
      value: 'redacted-test-value',
      session: false,
      expirationDate: Date.now() / 1000 - 60,
    },
  ])

  const result = await inspect('deepseek', 'https://chat.deepseek.com/')
  assert.deepEqual({ ...result }, { available: true, sessionCookiePresent: false })
})

test('cookie API absence degrades safely without breaking session inspection', async () => {
  const inspect = createCookieInspector([], false)
  const result = await inspect('qwen', 'https://chat.qwen.ai/')
  assert.deepEqual({ ...result }, { available: false, sessionCookiePresent: false })
})


test('extension manifest requests cookies permission and session UI distinguishes cookie-only evidence', () => {
  const manifest = JSON.parse(readFileSync(new URL('../zen-extension/manifest.json', import.meta.url), 'utf8'))
  assert.ok(manifest.permissions.includes('cookies'))
  assert.ok(manifest.permissions.includes('http://127.0.0.1/*'))
  const automation = readFileSync(new URL('../zen-extension/content/automation.js', import.meta.url), 'utf8')
  const ui = readFileSync(new URL('../src/renderer/use-aggregator-controller.ts', import.meta.url), 'utf8')


  assert.ok(automation.includes('page.accountMenuLogoutVisible'))
  assert.ok(automation.includes("status: 'session-available'"))
  assert.ok(ui.includes("'session-available': 'Сессия обнаружена'"))
})
