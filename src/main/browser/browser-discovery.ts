import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { BrowserDiscoverySnapshot, BrowserFamily, BrowserProcessDescriptor, DiscoveryConfidence } from '../../shared/types.js'

const execFileAsync = promisify(execFile)
const PROCESS_TIMEOUT_MS = 12_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const POWERSHELL_DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$known = '^(zen|firefox|librewolf|floorp|waterfox|chrome|msedge|brave|vivaldi|opera|chromium|thorium|arc|sidekick)\\.exe$'",
  "$profileArgs = '(?i)(-profile\\s|--profile\\s|--user-data-dir(?:=|\\s)|--profile-directory(?:=|\\s)|\\s-P\\s)'",
  "$processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -match $known -or ($_.Name -match '(?i)\\.exe$' -and $_.CommandLine -match $profileArgs) } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate",
  '$processes | ConvertTo-Json -Compress',
].join('; ')

interface RawWindowsProcess {
  ProcessId?: number
  ParentProcessId?: number
  Name?: string
  ExecutablePath?: string | null
  CommandLine?: string | null
  CreationDate?: string | null
}

const FIREFOX_PRODUCTS: Record<string, string> = {
  'zen.exe': 'Zen Browser', 'firefox.exe': 'Firefox', 'librewolf.exe': 'LibreWolf',
  'floorp.exe': 'Floorp', 'waterfox.exe': 'Waterfox',
}
const CHROMIUM_PRODUCTS: Record<string, string> = {
  'chrome.exe': 'Google Chrome', 'msedge.exe': 'Microsoft Edge', 'brave.exe': 'Brave',
  'vivaldi.exe': 'Vivaldi', 'opera.exe': 'Opera', 'chromium.exe': 'Chromium',
  'thorium.exe': 'Thorium', 'arc.exe': 'Arc', 'sidekick.exe': 'Sidekick',
}

export function tokenizeWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let backslashes = 0
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]
    if (char === '\\') { backslashes += 1; continue }
    if (char === '"') {
      current += '\\'.repeat(Math.floor(backslashes / 2))
      if (backslashes % 2 === 1) current += '"'
      else quoted = !quoted
      backslashes = 0
      continue
    }
    if (backslashes > 0) { current += '\\'.repeat(backslashes); backslashes = 0 }
    if (/\s/.test(char) && !quoted) {
      if (current) { args.push(current); current = '' }
      continue
    }
    current += char
  }
  if (backslashes > 0) current += '\\'.repeat(backslashes)
  if (current) args.push(current)
  return args
}

function readFlagValue(args: string[], names: string[]): string | undefined {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    for (const name of names) {
      if (arg.toLowerCase().startsWith(name.toLowerCase() + '=')) {
        const value = arg.slice(name.length + 1).trim()
        if (value) return value
      }
      if (arg.toLowerCase() === name.toLowerCase()) {
        const value = args[index + 1]?.trim()
        if (value && !value.startsWith('-')) return value
      }
    }
  }
  return undefined
}

function classifyBrowser(executableName: string, args: string[]): { family: BrowserFamily; product: string; confidence: DiscoveryConfidence } | null {
  const name = executableName.toLowerCase()
  if (FIREFOX_PRODUCTS[name]) return { family: 'firefox', product: FIREFOX_PRODUCTS[name], confidence: 'high' }
  if (CHROMIUM_PRODUCTS[name]) return { family: 'chromium', product: CHROMIUM_PRODUCTS[name], confidence: 'high' }
  const hasProfileFlag = args.some((arg) => /^(--user-data-dir=|--profile-directory=|-profile$|--profile$)/i.test(arg))
  const hasFirefoxProfileFlag = args.some((arg) => arg.toLowerCase() === '-profile')
  if (!name.endsWith('.exe') || !hasProfileFlag || (!name.includes('browser') && !hasFirefoxProfileFlag)) return null
  return { family: 'unknown', product: path.basename(executableName, '.exe'), confidence: 'low' }
}

export function parseWindowsBrowserProcesses(input: unknown): BrowserProcessDescriptor[] {
  const rows = Array.isArray(input) ? input : input ? [input] : []
  const descriptors: BrowserProcessDescriptor[] = []
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue
    const row = value as RawWindowsProcess
    if (typeof row.ProcessId !== 'number' || !Number.isInteger(row.ProcessId)) continue
    if (typeof row.ParentProcessId !== 'number' || !Number.isInteger(row.ParentProcessId)) continue
    if (typeof row.Name !== 'string' || !row.Name.trim()) continue
    const commandLine = typeof row.CommandLine === 'string' ? row.CommandLine : ''
    const args = commandLine ? tokenizeWindowsCommandLine(commandLine) : []
    const classification = classifyBrowser(row.Name, args)
    if (!classification) continue
    const firefoxProfile = classification.family === 'firefox' ? readFlagValue(args, ['-profile', '--profile']) : undefined
    const chromiumUserData = classification.family === 'chromium' ? readFlagValue(args, ['--user-data-dir']) : undefined
    const chromiumProfile = classification.family === 'chromium' ? readFlagValue(args, ['--profile-directory']) : undefined
    const genericProfile = classification.family === 'unknown' ? readFlagValue(args, ['-profile', '--profile', '--user-data-dir']) : undefined
    const profilePath = firefoxProfile || chromiumUserData || genericProfile
    const profileName = chromiumProfile || undefined
    const profileSource: BrowserProcessDescriptor['profileSource'] = firefoxProfile
      ? 'firefox-profile-argument'
      : chromiumUserData ? 'chromium-user-data-dir' : genericProfile ? 'generic-profile-argument' : 'default-or-unknown'
    const confidence: DiscoveryConfidence = classification.family === 'unknown' ? 'low' : profilePath ? 'high' : 'medium'
    descriptors.push({
      id: 'windows-process:' + row.ProcessId,
      processId: row.ProcessId,
      parentProcessId: row.ParentProcessId,
      executableName: row.Name,
      executablePath: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : undefined,
      family: classification.family,
      product: classification.product,
      startedAt: typeof row.CreationDate === 'string' ? row.CreationDate : undefined,
      profilePath,
      profileName,
      profileSource,
      confidence,
    })
  }
  const browserProcessIds = new Set(descriptors.map((descriptor) => descriptor.processId))
  const roots = descriptors.filter((descriptor) => !browserProcessIds.has(descriptor.parentProcessId))
  return roots.sort((left, right) => left.product.localeCompare(right.product) || left.processId - right.processId)
}

export class BrowserDiscoveryService {
  async discover(): Promise<BrowserDiscoverySnapshot> {
    const scannedAt = Date.now()
    if (process.platform !== 'win32') return {
      platform: process.platform, scannedAt, status: 'unsupported', processes: [],
      message: 'Обнаружение процессов пока реализовано только для Windows.',
    }
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_DISCOVERY_SCRIPT],
        { windowsHide: true, timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      )
      const parsed = stdout.trim() ? JSON.parse(stdout) as unknown : []
      const processes = parseWindowsBrowserProcesses(parsed)
      return {
        platform: process.platform, scannedAt, status: 'available', processes,
        message: processes.length
          ? 'Обнаружено процессов браузеров: ' + processes.length + '. Это не подтверждает подключение расширения или авторизацию.'
          : 'Запущенные поддерживаемые браузерные процессы не обнаружены.',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка обнаружения.'
      return {
        platform: process.platform, scannedAt, status: 'error', processes: [],
        message: 'Не удалось получить список процессов браузеров: ' + message.slice(0, 300),
      }
    }
  }
}
