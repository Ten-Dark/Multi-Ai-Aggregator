import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { BrowserDiscoverySnapshot, BrowserFamily, BrowserProcessDescriptor } from '../../shared/types.js'
import { LinuxBrowserDiscoveryProvider, MacOSBrowserDiscoveryProvider } from './unix-browser-discovery.js'

const execFileAsync = promisify(execFile)
const PROCESS_TIMEOUT_MS = 12_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const POWERSHELL_DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$known = '^(zen|firefox|librewolf|floorp|waterfox|chrome|msedge|brave|vivaldi|opera|chromium|thorium|arc|sidekick)\\.exe$'",
  "$profileArgs = '(?i)(-profile\\s|--profile\\s|--user-data-dir(?:=|\\s)|--profile-directory(?:=|\\s)|\\s-P\\s)'",
  "$windows = @{}; Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $windows[[int]$_.Id] = $_.MainWindowTitle }",
  "$processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -match $known -or ($_.ExecutablePath -and ($windows.ContainsKey([int]$_.ProcessId) -or $_.CommandLine -match $profileArgs)) } | ForEach-Object { $windowTitle = $windows[[int]$_.ProcessId]; $version = $null; if ($_.ExecutablePath) { try { $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath) } catch {} }; [PSCustomObject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; Name=$_.Name; ExecutablePath=$_.ExecutablePath; CommandLine=$_.CommandLine; CreationDate=$_.CreationDate; WindowTitle=$windowTitle; HasVisibleWindow=[bool]$windowTitle; FileDescription=if ($version) { $version.FileDescription } else { $null }; ProductName=if ($version) { $version.ProductName } else { $null }; CompanyName=if ($version) { $version.CompanyName } else { $null } } }",
  '$processes | ConvertTo-Json -Compress',
].join('; ')

export interface BrowserDiscoveryProvider {
  readonly id: string
  readonly supportedPlatforms: readonly string[]
  discover(): Promise<BrowserDiscoverySnapshot>
}

export class BrowserDiscoveryRegistry {
  constructor(private readonly providers: readonly BrowserDiscoveryProvider[]) {}

  async discover(platform = process.platform): Promise<BrowserDiscoverySnapshot> {
    const provider = this.providers.find((candidate) => candidate.supportedPlatforms.includes(platform))
    if (!provider) {
      return {
        platform,
        scannedAt: Date.now(),
        status: 'unsupported',
        processes: [],
        message: 'Для платформы ' + platform + ' пока нет провайдера обнаружения браузеров.',
      }
    }
    return provider.discover()
  }
}

interface RawWindowsProcess {
  ProcessId?: number
  ParentProcessId?: number
  Name?: string
  ExecutablePath?: string | null
  CommandLine?: string | null
  CreationDate?: string | null
  WindowTitle?: string | null
  HasVisibleWindow?: boolean
  FileDescription?: string | null
  ProductName?: string | null
  CompanyName?: string | null
}

const FIREFOX_PRODUCTS: Record<string, string> = {
  'zen.exe': 'Zen Browser',
  'firefox.exe': 'Firefox',
  'librewolf.exe': 'LibreWolf',
  'floorp.exe': 'Floorp',
  'waterfox.exe': 'Waterfox',
}

const CHROMIUM_PRODUCTS: Record<string, string> = {
  'chrome.exe': 'Google Chrome',
  'msedge.exe': 'Microsoft Edge',
  'brave.exe': 'Brave',
  'vivaldi.exe': 'Vivaldi',
  'opera.exe': 'Opera',
  'chromium.exe': 'Chromium',
  'thorium.exe': 'Thorium',
  'arc.exe': 'Arc',
  'sidekick.exe': 'Sidekick',
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

function classifyBrowser(
  executableName: string,
  args: string[],
  metadata: Pick<RawWindowsProcess, 'FileDescription' | 'ProductName' | 'CompanyName'> = {},
): { family: BrowserFamily; product: string } | null {
  const name = executableName.toLowerCase()
  if (FIREFOX_PRODUCTS[name]) return { family: 'firefox', product: FIREFOX_PRODUCTS[name] }
  if (CHROMIUM_PRODUCTS[name]) return { family: 'chromium', product: CHROMIUM_PRODUCTS[name] }

  const productName = metadata.ProductName?.trim() || ''
  const description = metadata.FileDescription?.trim() || ''
  const company = metadata.CompanyName?.trim() || ''
  const identity = [productName, description].filter(Boolean).join(' ')

  const companyLower = company.toLowerCase()

  if (/zen browser|librewolf|floorp|waterfox|mozilla firefox|firefox/i.test(identity)) {
    const product = /zen browser/i.test(identity) ? 'Zen Browser'
      : /librewolf/i.test(identity) ? 'LibreWolf'
        : /floorp/i.test(identity) ? 'Floorp'
          : /waterfox/i.test(identity) ? 'Waterfox' : 'Firefox'
    return { family: 'firefox', product }
  }

  if (/google chrome|microsoft edge|brave|vivaldi|\bopera\b|chromium|thorium|arc browser|sidekick/i.test(identity)) {
    const product = /google chrome/i.test(identity) ? 'Google Chrome'
      : /microsoft edge/i.test(identity) ? 'Microsoft Edge'
        : /brave/i.test(identity) ? 'Brave'
          : /vivaldi/i.test(identity) ? 'Vivaldi'
            : /thorium/i.test(identity) ? 'Thorium'
              : /arc browser/i.test(identity) ? 'Arc'
                : /sidekick/i.test(identity) ? 'Sidekick'
                  : /\bopera\b/i.test(identity) ? 'Opera' : 'Chromium'
    return { family: 'chromium', product }
  }
  const hasProfileFlag = args.some((arg) => /^(--user-data-dir=|--profile-directory=|-profile$|--profile$)/i.test(arg))
  const hasFirefoxProfileFlag = args.some((arg) => arg.toLowerCase() === '-profile')
  const browserLikeCompany = /mozilla|zen|brave|vivaldi|opera|google|microsoft|arc browser/i.test(companyLower)
  if (!name.endsWith('.exe') || !hasProfileFlag || (!name.includes('browser') && !hasFirefoxProfileFlag && !browserLikeCompany)) return null
  return { family: 'unknown', product: productName || description || path.basename(executableName, '.exe') }
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
    const classification = classifyBrowser(row.Name, args, row)
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
    descriptors.push({
      id: 'windows-process:' + row.ProcessId,
      processId: row.ProcessId,
      parentProcessId: row.ParentProcessId,
      executableName: row.Name,
      executablePath: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : undefined,
      family: classification.family,
      product: classification.product,
      startedAt: typeof row.CreationDate === 'string' ? row.CreationDate : undefined,
      windowTitle: typeof row.WindowTitle === 'string' && row.WindowTitle ? row.WindowTitle : undefined,
      hasVisibleWindow: row.HasVisibleWindow === true,
      profilePath,
      profileName,
      profileSource,
      confidence: classification.family === 'unknown' ? 'low' : profilePath ? 'high' : 'medium',
    })
  }
  const browserProcessIds = new Set(descriptors.map((descriptor) => descriptor.processId))
  const roots = descriptors.filter((descriptor) => !browserProcessIds.has(descriptor.parentProcessId))
  return roots.sort((left, right) => left.product.localeCompare(right.product) || left.processId - right.processId)
}

export class WindowsBrowserDiscoveryProvider implements BrowserDiscoveryProvider {
  readonly id = 'windows-process-discovery'
  readonly supportedPlatforms = ['win32'] as const

  async discover(): Promise<BrowserDiscoverySnapshot> {
    const scannedAt = Date.now()
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_DISCOVERY_SCRIPT],
        { windowsHide: true, timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      )
      const parsed = stdout.trim() ? JSON.parse(stdout) as unknown : []
      const processes = parseWindowsBrowserProcesses(parsed)
      return {
        platform: 'win32',
        scannedAt,
        status: 'available',
        processes,
        message: processes.length
          ? 'Обнаружено корневых процессов браузеров: ' + processes.length + '. Это не подтверждает подключение расширения или авторизацию.'
          : 'Запущенные поддерживаемые браузерные процессы не обнаружены.',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка обнаружения.'
      return {
        platform: 'win32',
        scannedAt,
        status: 'error',
        processes: [],
        message: 'Не удалось получить список процессов браузеров: ' + message.slice(0, 300),
      }
    }
  }
}

export class BrowserDiscoveryService {
  private readonly registry: BrowserDiscoveryRegistry

  constructor(providers: readonly BrowserDiscoveryProvider[] = [
    new WindowsBrowserDiscoveryProvider(),
    new MacOSBrowserDiscoveryProvider(),
    new LinuxBrowserDiscoveryProvider(),
  ]) {
    this.registry = new BrowserDiscoveryRegistry(providers)
  }

  discover(): Promise<BrowserDiscoverySnapshot> {
    return this.registry.discover()
  }
}
