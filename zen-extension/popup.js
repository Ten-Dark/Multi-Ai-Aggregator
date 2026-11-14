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
