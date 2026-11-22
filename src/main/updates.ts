import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, createReadStream, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getMainWindow } from './window.js'
import { isTrustedIpcSender } from './ipc-security.js'

const RELEASE_API = 'https://api.github.com/repos/Ten-Dark/Multi-Ai-Aggregator/releases/latest'
const MAX_INSTALLER_BYTES = 1_500_000_000
const INSTALLER_PATTERN = /^Multi-AI-Aggregator-Setup-\d+\.\d+\.\d+\.exe$/

interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

interface GitHubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  body?: string
  assets: ReleaseAsset[]
}

export interface AppUpdateCheck {
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  message: string
  releaseUrl?: string
  releaseNotes?: string
}

function parseVersion(value: string): number[] | null {
  const match = value.replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  return match ? match.slice(1, 4).map(Number) : null
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error('Сервер обновлений вернул некорректную версию.')
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const window = getMainWindow()
  const frame = event.senderFrame
  if (
    !window || window.isDestroyed() ||
    !isTrustedIpcSender({
      senderMatchesWindow: event.sender === window.webContents,
      frameExists: Boolean(frame),
      isMainFrame: Boolean(frame && frame.parent === null),
      frameUrl: frame?.url ?? '',
      currentUrl: window.webContents.getURL(),
      isPackaged: app.isPackaged,
    })
  ) throw new Error('Недоверенный источник IPC-вызова.')
}

async function getLatestRelease(): Promise<GitHubRelease> {
  const response = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Multi-AI-Aggregator-Updater' },
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404) throw new Error('Пока нет опубликованных обновлений.')
  if (!response.ok) throw new Error(`GitHub вернул ошибку проверки обновлений (${response.status}).`)
  const release = await response.json() as GitHubRelease
  if (release.draft || release.prerelease || !Array.isArray(release.assets)) {
    throw new Error('Последний релиз не является стабильным или не содержит файлов.')
  }
  return release
}

function getInstallerAsset(release: GitHubRelease): ReleaseAsset {
  const asset = release.assets.find((candidate) => INSTALLER_PATTERN.test(candidate.name))
  if (!asset || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) {
    throw new Error('В последнем релизе не найден корректный установщик Windows.')
  }
  const url = new URL(asset.browser_download_url)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      !url.pathname.startsWith('/Ten-Dark/Multi-Ai-Aggregator/releases/download/')) {
    throw new Error('Ссылка на установщик не прошла проверку безопасности.')
  }
  return asset
}

async function inspectLatestUpdate(): Promise<{ release: GitHubRelease; asset: ReleaseAsset; result: AppUpdateCheck }> {
  const currentVersion = app.getVersion()
  const release = await getLatestRelease()
  const latestVersion = release.tag_name.replace(/^v/i, '')
  const asset = getInstallerAsset(release)
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0
  return {
    release,
    asset,
    result: {
      currentVersion,
      latestVersion,
      updateAvailable,
      message: updateAvailable ? `Доступна версия ${latestVersion}.` : 'Установлена последняя версия.',
      releaseUrl: release.html_url,
      releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 12_000) : undefined,
    },
  }
}

async function downloadText(url: string): Promise<string> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('Ссылка на контрольную сумму не прошла проверку безопасности.')
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error('Не удалось получить контрольную сумму установщика.')
  return response.text()
}

async function calculateSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadAndOpenInstaller(): Promise<{ success: boolean; message: string }> {
  const { release, asset, result } = await inspectLatestUpdate()
  if (!result.updateAvailable) return { success: false, message: 'Обновление не требуется.' }

  const sidecar = release.assets.find((candidate) => candidate.name === `${asset.name}.sha256`)
  let expectedHash = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase()
  if (!expectedHash && sidecar) {
    const sidecarText = await downloadText(sidecar.browser_download_url)
    expectedHash = sidecarText.match(/\b([a-f0-9]{64})\b/i)?.[1]?.toLowerCase()
  }
  if (!expectedHash) throw new Error('В релизе отсутствует SHA-256 контрольная сумма установщика.')

  const directory = path.join(app.getPath('temp'), 'multi-ai-aggregator-updates')
  mkdirSync(directory, { recursive: true })
  const installerPath = path.join(directory, asset.name)
  rmSync(installerPath, { force: true })

  try {
    const response = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'Multi-AI-Aggregator-Updater' },
      signal: AbortSignal.timeout(10 * 60_000),
    })
    if (!response.ok || !response.body) throw new Error(`Не удалось скачать установщик (${response.status}).`)
    const finalUrl = new URL(response.url)
    if (finalUrl.protocol !== 'https:' ||
        !(finalUrl.hostname === 'github.com' || finalUrl.hostname.endsWith('.githubusercontent.com'))) {
      throw new Error('Сервер загрузки установщика не прошёл проверку безопасности.')
    }
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_INSTALLER_BYTES) throw new Error('Размер установщика превышает допустимый лимит.')
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(installerPath, { flags: 'wx' }))
    const downloadedSize = statSync(installerPath).size
    if (downloadedSize <= 0 || downloadedSize > MAX_INSTALLER_BYTES) throw new Error('Загружен некорректный файл установщика.')
    const actualHash = await calculateSha256(installerPath)
    if (actualHash !== expectedHash) throw new Error('SHA-256 установщика не совпадает. Запуск отменён.')
    const openError = await shell.openPath(installerPath)
    if (openError) throw new Error(`Не удалось открыть установщик: ${openError}`)
    return { success: true, message: `Установщик ${result.latestVersion} загружен и проверен. Следуй инструкциям установщика.` }
  } catch (error) {
    rmSync(installerPath, { force: true })
    throw error
  }
}

export function registerUpdateIpc(): void {
  ipcMain.handle('app:checkUpdate', async (event) => {
    assertTrustedSender(event)
    try {
      return (await inspectLatestUpdate()).result
    } catch (error) {
      return {
        currentVersion: app.getVersion(),
        updateAvailable: false,
        message: error instanceof Error ? error.message : 'Не удалось проверить обновления.',
      } satisfies AppUpdateCheck
    }
  })

  ipcMain.handle('app:downloadUpdate', async (event) => {
    assertTrustedSender(event)
    try {
      return await downloadAndOpenInstaller()
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Не удалось загрузить обновление.' }
    }
  })
}