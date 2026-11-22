import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'zen-extension', 'manifest.json'), 'utf8'))
const gecko = manifest.browser_specific_settings?.gecko
if (!gecko?.id || !manifest.version) throw new Error('Extension update metadata is incomplete.')

const output = path.join(root, 'release')
fs.mkdirSync(output, { recursive: true })
const updateManifest = {
  addons: {
    [gecko.id]: {
      updates: [{
        version: manifest.version,
        update_link: 'https://github.com/Ten-Dark/Multi-Ai-Aggregator/releases/latest/download/multi-ai-aggregator-zen.xpi',
        applications: { gecko: { strict_min_version: gecko.strict_min_version || '128.0' } },
      }],
    },
  },
}
fs.writeFileSync(path.join(output, 'updates.json'), JSON.stringify(updateManifest, null, 2) + '\n')
fs.writeFileSync(path.join(output, 'zen-extension-version.txt'), manifest.version + '\n')
console.log('Generated Firefox-compatible update metadata for extension ' + manifest.version)