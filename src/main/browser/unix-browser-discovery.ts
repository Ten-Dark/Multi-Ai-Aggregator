import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { BrowserDiscoverySnapshot, BrowserFamily, BrowserProcessDescriptor } from '../../shared/types.js'

const execFileAsync = promisify(execFile)
const PROCESS_TIMEOUT_MS = 12_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

interface UnixProcessRow {
  processId: number
  parentProcessId: number
  executable: string
  arguments: string
}

const FIREFOX_NAMES: Record<string, string> = {
  firefox: 'Firefox',
  'firefox-esr': 'Firefox ESR',
  zen: 'Zen Browser',
  'zen-browser': 'Zen Browser',
  librewolf: 'LibreWolf',
  floorp: 'Floorp',
  waterfox: 'Waterfox',
}

const CHROMIUM_NAMES: Record<string, string> = {
  chromium: 'Chromium',
  'chromium-browser': 'Chromium',
  chrome: 'Google Chrome',
  'google-chrome': 'Google Chrome',
  'google-chrome-stable': 'Google Chrome',
  'google chrome': 'Google Chrome',
  'microsoft-edge': 'Microsoft Edge',
  'microsoft-edge-stable': 'Microsoft Edge',
  'microsoft edge': 'Microsoft Edge',
  msedge: 'Microsoft Edge',
  brave: 'Brave',
  'brave-browser': 'Brave',
  'brave browser': 'Brave',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  'thorium-browser': 'Thorium',
  arc: 'Arc',
  'arc browser': 'Arc',
  sidekick: 'Sidekick',
}

function parseProcessRows(output: string): UnixProcessRow[] {
  const rows: UnixProcessRow[] = []
  const knownNames = [...Object.keys(FIREFOX_NAMES), ...Object.keys(CHROMIUM_NAMES)]
    .sort((left, right) => right.length - left.length)

  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const processId = Number(match[1])
    const parentProcessId = Number(match[2])
    if (!Number.isSafeInteger(processId) || !Number.isSafeInteger(parentProcessId)) continue

    const command = match[3].trim()
    const knownName = knownNames.find((name) =>
      command.toLowerCase() === name || command.toLowerCase().startsWith(name + ' '),
    )
    const executable = knownName || command.split(/\s+/, 1)[0]
    const args = knownName ? command.slice(knownName.length).trim() : command.slice(executable.length).trim()
    rows.push({ processId, parentProcessId, executable, arguments: args })
  }
  return rows
}

function readArgument(args: string[], names: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]
    for (const name of names) {
      if (current.toLowerCase().startsWith(name.toLowerCase() + '=')) {
        const value = current.slice(name.length + 1).trim()
        if (value) return value
      }
      if (current.toLowerCase() === name.toLowerCase()) {
        const value = args[index + 1]?.trim()
        if (value && !value.startsWith('-')) return value
      }
    }
  }
  return undefined
}

function tokenizeArguments(input: string): string[] {
  const result: string[] = []
  let current = ''
  let quote = ''
  let escaped = false
  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\' && quote !== "'") {
      escaped = true
    } else if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char
    } else if (/\s/.test(char) && !quote) {
      if (current) result.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (escaped) current += '\\'
  if (current) result.push(current)
  return result
}

function classifyUnixBrowser(executable: string): { family: BrowserFamily; product: string } | null {
  const name = path.basename(executable).toLowerCase()
  if (FIREFOX_NAMES[name]) return { family: 'firefox', product: FIREFOX_NAMES[name] }
  if (CHROMIUM_NAMES[name]) return { family: 'chromium', product: CHROMIUM_NAMES[name] }
  return null
}

export function parseUnixBrowserProcesses(output: string): BrowserProcessDescriptor[] {
  const rows = parseProcessRows(output)
  const descriptors: BrowserProcessDescriptor[] = []
  for (const row of rows) {
    const args = tokenizeArguments(row.arguments)
    const classification = classifyUnixBrowser(row.executable)
    if (!classification) continue

    const firefoxProfile = classification.family === 'firefox'
      ? readArgument(args, ['-profile', '--profile'])
      : undefined
    const chromiumUserData = classification.family === 'chromium'
      ? readArgument(args, ['--user-data-dir'])
      : undefined
    const chromiumProfile = classification.family === 'chromium'
      ? readArgument(args, ['--profile-directory'])
      : undefined
    const profilePath = firefoxProfile || chromiumUserData
    const profileSource: BrowserProcessDescriptor['profileSource'] = firefoxProfile
      ? 'firefox-profile-argument'
      : chromiumUserData ? 'chromium-user-data-dir' : 'default-or-unknown'

    descriptors.push({
      id: 'unix-process:' + row.processId,
      processId: row.processId,
      parentProcessId: row.parentProcessId,
      executableName: path.basename(row.executable),
      executablePath: row.executable.includes('/') ? row.executable : undefined,
      family: classification.family,
      product: classification.product,
      hasVisibleWindow: false,
      profilePath,
      profileName: chromiumProfile || undefined,
      profileSource,
      confidence: profilePath ? 'high' : 'medium',
    })
  }

  const browserProcessIds = new Set(descriptors.map((descriptor) => descriptor.processId))
  return descriptors
    .filter((descriptor) => !browserProcessIds.has(descriptor.parentProcessId))
    .sort((left, right) => left.product.localeCompare(right.product) || left.processId - right.processId)
}

abstract class UnixBrowserDiscoveryProvider {
  abstract readonly id: string
  abstract readonly platform: 'darwin' | 'linux'
  abstract readonly supportedPlatforms: readonly string[]

  async discover(): Promise<BrowserDiscoverySnapshot> {
    const scannedAt = Date.now()
    try {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,comm=,args='], {
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      })
      const processes = parseUnixBrowserProcesses(stdout)
      return {
        platform: this.platform,
        scannedAt,
        status: 'available',
        processes,
        message: processes.length
          ? 'Обнаружено корневых процессов браузеров: ' + processes.length + '. Подключение расширения и авторизация отдельно не подтверждаются.'
          : 'Запущенные поддерживаемые браузерные процессы не обнаружены.',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка обнаружения.'
      return {
        platform: this.platform,
        scannedAt,
        status: 'error',
        processes: [],
        message: 'Не удалось получить список процессов браузеров: ' + message.slice(0, 300),
      }
    }
  }
}

export class MacOSBrowserDiscoveryProvider extends UnixBrowserDiscoveryProvider {
  readonly id = 'macos-process-discovery'
  readonly platform = 'darwin' as const
  readonly supportedPlatforms = ['darwin'] as const
}

export class LinuxBrowserDiscoveryProvider extends UnixBrowserDiscoveryProvider {
  readonly id = 'linux-process-discovery'
  readonly platform = 'linux' as const
  readonly supportedPlatforms = ['linux'] as const
}
