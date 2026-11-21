import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { securePrivateDirectory, securePrivateFile } = require('../dist-electron/main/zen/secure-storage.js')
const { ZenBridge } = require('../dist-electron/main/zen/bridge.js')

test('private storage applies and verifies restrictive filesystem permissions', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-secure-storage-'))
  const directory = path.join(root, 'private')
  const file = path.join(directory, 'token')

  try {
    securePrivateDirectory(directory)
    fs.writeFileSync(file, 'test-only-token', { encoding: 'utf8', mode: 0o600 })
    securePrivateFile(file, directory)
    assert.equal(fs.readFileSync(file, 'utf8'), 'test-only-token')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bridge rotates the legacy userData token into the protected directory', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-bridge-token-migration-'))
  const legacyTokenFile = path.join(root, 'zen-bridge-token')
  const secureTokenFile = path.join(root, 'zen-secure', 'zen-bridge-token')
  const legacyToken = 'legacy-token-that-must-be-rotated'

  try {
    fs.writeFileSync(legacyTokenFile, legacyToken, { encoding: 'utf8' })
    const bridge = new ZenBridge(root, () => {})
    const currentToken = bridge.getZenConnection().pairingCode.split('|').at(-1)

    assert.notEqual(currentToken, legacyToken)
    assert.equal(fs.existsSync(legacyTokenFile), false)
    assert.equal(fs.existsSync(secureTokenFile), true)
    assert.equal(fs.existsSync(path.join(root, 'zen-secure')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
