import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionSource = path.join(projectRoot, 'zen-extension')
const manifestPath = path.join(extensionSource, 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

if (process.platform !== 'win32') {
  throw new Error('The XPI packaging script currently requires Windows PowerShell (Compress-Archive).')
}
if (!manifest.version || !Array.isArray(manifest.content_scripts)) {
  throw new Error('The Zen extension manifest is missing required packaging metadata.')
}

const outputDirectory = path.join(projectRoot, 'release', 'zen-extension')
const outputZip = path.join(outputDirectory, `multi-ai-aggregator-zen-${manifest.version}.zip`)
const outputXpi = path.join(outputDirectory, `multi-ai-aggregator-zen-${manifest.version}.xpi`)
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-zen-xpi-'))
const verificationDirectory = path.join(temporaryDirectory, 'verify')
const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

try {
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.mkdirSync(verificationDirectory, { recursive: true })
  fs.rmSync(outputZip, { force: true })

  const script = String.raw`
$ErrorActionPreference = 'Stop'
Compress-Archive -Path (Join-Path $env:MAI_EXTENSION_SOURCE '*') -DestinationPath $env:MAI_EXTENSION_ZIP -Force
Expand-Archive -LiteralPath $env:MAI_EXTENSION_ZIP -DestinationPath $env:MAI_EXTENSION_VERIFY -Force
`
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MAI_EXTENSION_SOURCE: extensionSource,
      MAI_EXTENSION_ZIP: outputZip,
      MAI_EXTENSION_VERIFY: verificationDirectory,
    },
  })

  const packagedManifestPath = path.join(verificationDirectory, 'manifest.json')
  const packagedManifest = JSON.parse(fs.readFileSync(packagedManifestPath, 'utf8'))
  if (packagedManifest.version !== manifest.version || packagedManifest.name !== manifest.name) {
    throw new Error('The packaged XPI manifest does not match the source manifest.')
  }

  const requiredFiles = [
    'background.js',
    'popup.html',
    'popup.js',
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ]
  for (const relativePath of requiredFiles) {
    if (!fs.existsSync(path.join(verificationDirectory, relativePath))) {
      throw new Error(`The packaged XPI is missing ${relativePath}.`)
    }
  }

  fs.rmSync(outputXpi, { force: true })
  fs.renameSync(outputZip, outputXpi)
  console.log(`Built and verified Zen extension ${manifest.version}: ${path.relative(projectRoot, outputXpi)}`)
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  fs.rmSync(outputZip, { force: true })
}
