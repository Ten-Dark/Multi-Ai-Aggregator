'use strict'

const statusDot = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const statusDetail = document.getElementById('status-detail')
const pairingInput = document.getElementById('pairing')
const saveButton = document.getElementById('save')
const clearButton = document.getElementById('clear')
const message = document.getElementById('message')
const version = document.getElementById('version')

function setMessage(text, tone) {
  message.textContent = text
  message.className = tone ? `message ${tone}` : 'message'
}

function toneForState(state) {
  if (state === 'connected') return 'ok'
  if (state === 'connecting' || state === 'disconnected') return 'warn'
  if (state === 'error') return 'bad'
  return ''
}

async function refresh() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'mai:get-status' })
    if (!response?.ok) return
    const { status, extensionVersion, hasPairing } = response
    version.textContent = extensionVersion || '0.1.0'
    statusText.textContent =
      status.state === 'connected'
        ? 'Подключено к приложению'
        : status.state === 'connecting'
          ? 'Подключение…'
          : status.state === 'disconnected'
            ? 'Нет соединения'
            : status.state === 'error'
              ? 'Ошибка подключения'
              : 'Не подключено'
    statusDetail.textContent = status.message || ''
    statusDot.className = `dot ${toneForState(status.state)}`
    if (!hasPairing) setMessage('Сначала вставьте код подключения ниже.', 'error')
  } catch (error) {
    statusText.textContent = 'Фоновая страница недоступна'
    statusDetail.textContent = error instanceof Error ? error.message : String(error)
    statusDot.className = 'dot bad'
  }
}

saveButton.addEventListener('click', async () => {
  const code = pairingInput.value.trim()
  if (!code) {
    setMessage('Вставьте код подключения.', 'error')
    return
  }
  saveButton.disabled = true
  try {
    const response = await browser.runtime.sendMessage({ type: 'mai:set-pairing', code })
    if (response?.ok) {
      setMessage('Код сохранён, подключаюсь…', 'ok')
      await refresh()
    } else {
      setMessage(response?.error || 'Не удалось сохранить код.', 'error')
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    saveButton.disabled = false
  }
})

clearButton.addEventListener('click', async () => {
  try {
    await browser.runtime.sendMessage({ type: 'mai:clear-pairing' })
    pairingInput.value = ''
    setMessage('Код подключения удалён.', 'ok')
    await refresh()
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), 'error')
  }
})

window.addEventListener('unload', () => {
  clearInterval(refreshTimer)
})

const refreshTimer = setInterval(() => {
  void refresh()
}, 1000)

void refresh()

const updateStatus = document.getElementById('update-status')
const checkUpdateButton = document.getElementById('check-update')
const downloadUpdateButton = document.getElementById('download-update')
const RELEASE_API = 'https://api.github.com/repos/Ten-Dark/Multi-Ai-Aggregator/releases/latest'
const EXTENSION_DOWNLOAD_URL = 'https://github.com/Ten-Dark/Multi-Ai-Aggregator/releases/latest/download/multi-ai-aggregator-zen.xpi'

function compareVersions(left, right) {
  const parse = (value) => value.replace(/^v/i, '').split(/[+-]/)[0].split('.').map(Number)
  const a = parse(left), b = parse(right)
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((part) => !Number.isInteger(part))) return null
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  return 0
}

async function checkExtensionUpdate() {
  checkUpdateButton.disabled = true
  downloadUpdateButton.hidden = true
  updateStatus.textContent = 'Проверяю последнюю опубликованную версию…'
  try {
    const response = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
    if (response.status === 404) throw new Error('Пока нет опубликованных релизов.')
    if (!response.ok) throw new Error('GitHub вернул ошибку ' + response.status + '.')
    const release = await response.json()
    if (release.draft || release.prerelease || !Array.isArray(release.assets)) throw new Error('Стабильный релиз пока недоступен.')
    const versionAsset = release.assets.find((asset) => asset.name === 'zen-extension-version.txt')
    const xpiAsset = release.assets.find((asset) => asset.name === 'multi-ai-aggregator-zen.xpi')
    if (!versionAsset || !xpiAsset) throw new Error('В релизе отсутствует пакет расширения.')
    const versionResponse = await fetch(versionAsset.browser_download_url, { cache: 'no-store' })
    if (!versionResponse.ok) throw new Error('Не удалось прочитать версию расширения из релиза.')
    const latestVersion = (await versionResponse.text()).trim()
    const currentVersion = browser.runtime.getManifest().version
    const comparison = compareVersions(latestVersion, currentVersion)
    if (comparison === null) throw new Error('Не удалось сравнить версии расширения.')
    if (comparison <= 0) { updateStatus.textContent = 'Установлена актуальная версия ' + currentVersion + '.'; return }
    updateStatus.textContent = 'Доступна версия ' + latestVersion + ' (установлена ' + currentVersion + '). Нажми «Скачать XPI», затем подтверди установку в Zen.'
    downloadUpdateButton.hidden = false
  } catch (error) { updateStatus.textContent = error instanceof Error ? error.message : String(error) }
  finally { checkUpdateButton.disabled = false }
}

checkUpdateButton.addEventListener('click', () => void checkExtensionUpdate())
downloadUpdateButton.addEventListener('click', async () => {
  try {
    await browser.tabs.create({ url: EXTENSION_DOWNLOAD_URL })
    updateStatus.textContent = 'Открыл загрузку XPI. Заверши установку расширения в Zen.'
  } catch (error) { updateStatus.textContent = error instanceof Error ? error.message : String(error) }
})