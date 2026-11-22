'use strict'

const MODELS = ['chatgpt', 'qwen', 'deepseek']
const ADAPTERS = {
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com'] },
  qwen: { label: 'Qwen', url: 'https://chat.qwen.ai/', hosts: ['chat.qwen.ai'] },
  deepseek: { label: 'DeepSeek', url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'] },
}

const PAIRING_KEY = 'maiPairing'
const TABS_KEY = 'maiTabs'
const STATUS_KEY = 'maiStatus'
const RECONNECT_MS = 5000
const CLIENT_HEARTBEAT_MS = 15_000
const CLIENT_INSTANCE_KEY = 'maiClientInstanceId'
const EXTENSION_VERSION = browser.runtime.getManifest().version

let socket = null
let reconnectTimer = null
let clientHeartbeatTimer = null
let clientIdentityPromise = null
let authenticated = false
let lastAuthError = ''
let currentStatus = { state: 'idle', message: 'Код подключения не задан.' }
const activeTasks = new Map()
const finishedTasks = new Map()
const FINISHED_TASK_LIMIT = 256
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function setStatus(state, message) {
  currentStatus = { state, message, updatedAt: Date.now() }
  void browser.storage.local.set({ [STATUS_KEY]: currentStatus })
  updateBadge(state)
}

function updateBadge(state) {
  const text = state === 'connected' ? '' : state === 'idle' ? '?' : '!'
  const color = state === 'connected' ? '#15803d' : state === 'idle' ? '#a16207' : '#b91c1c'
  void browser.browserAction.setBadgeText({ text })
  void browser.browserAction.setBadgeBackgroundColor({ color })
  void browser.browserAction.setTitle({
    title: text ? `Multi-AI Aggregator: ${currentStatus.message}` : 'Multi-AI Aggregator: подключено к Electron',
  })
}

function sendRaw(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

async function getPairing() {
  const data = await browser.storage.local.get(PAIRING_KEY)
  return typeof data[PAIRING_KEY] === 'string' ? data[PAIRING_KEY] : ''
}

async function setPairing(code) {
  await browser.storage.local.set({ [PAIRING_KEY]: code })
}
async function getClientIdentity() {
  if (!clientIdentityPromise) {
    clientIdentityPromise = (async () => {
      const stored = await browser.storage.local.get(CLIENT_INSTANCE_KEY)
      let instanceId = stored[CLIENT_INSTANCE_KEY]
      if (typeof instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
        instanceId = crypto.randomUUID()
        await browser.storage.local.set({ [CLIENT_INSTANCE_KEY]: instanceId })
      }
      let browserInfo = null
      try {
        browserInfo = await browser.runtime.getBrowserInfo()
      } catch {
        // Browser metadata is diagnostic only; identity remains stable without it.
      }
      return {
        instanceId,
        browserName: typeof browserInfo?.name === 'string' && browserInfo.name.trim() ? browserInfo.name.slice(0, 80) : 'Unknown browser',
        browserVersion: typeof browserInfo?.version === 'string' ? browserInfo.version.slice(0, 80) : 'unknown',
      }
    })().catch((error) => {
      clientIdentityPromise = null
      throw error
    })
  }
  return clientIdentityPromise
}

function stopClientHeartbeat() {
  if (clientHeartbeatTimer) clearInterval(clientHeartbeatTimer)
  clientHeartbeatTimer = null
}

async function announceClientIdentity() {
  const identity = await getClientIdentity()
  if (!authenticated || !sendRaw({ type: 'client-info', ...identity, extensionVersion: EXTENSION_VERSION })) return
  stopClientHeartbeat()
  clientHeartbeatTimer = setInterval(() => {
    if (!authenticated || !sendRaw({ type: 'client-heartbeat', instanceId: identity.instanceId })) stopClientHeartbeat()
  }, CLIENT_HEARTBEAT_MS)
  setStatus('connected', `Подключено: ${identity.browserName} ${identity.browserVersion}.`)
}


async function applyIntegrationPairing() {
  const manifest = browser.runtime.getManifest()
  if (manifest.name !== 'Multi-AI Aggregator Bridge [Integration Test]') return

  try {
    const response = await fetch(browser.runtime.getURL('dev-pairing.json'), { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    if (data && typeof data.code === 'string' && data.code.trim()) {
      await setPairing(data.code.trim())
    }
  } catch {
    // Integration-only pairing data is absent.
  }
}

function parsePairing(code) {
  const trimmed = String(code || '').trim()
  const separator = trimmed.lastIndexOf('|')
  if (separator <= 0) {
    throw new Error('Неверный формат кода. Ожидается ws://127.0.0.1:ПОРТ|ТОКЕН')
  }
  const rawUrl = trimmed.slice(0, separator).trim()
  const token = trimmed.slice(separator + 1).trim()
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Неверный адрес WebSocket в коде подключения.')
  }
  if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('Код должен содержать локальный адрес ws://127.0.0.1.')
  }
  if (!token) throw new Error('В коде подключения отсутствует токен.')
  return { url: parsed.toString(), token }
}



async function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return
  }

  const code = await getPairing()
  if (!code) {
    setStatus('idle', 'Вставьте код подключения из раздела «Подключение к Zen» в приложении.')
    return
  }

  let target
  try {
    target = parsePairing(code)
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : String(error))
    return
  }

  setStatus('connecting', 'Подключение к Multi-AI Aggregator…')
  let nextSocket
  try {
    nextSocket = new WebSocket(target.url)
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : String(error))
    scheduleReconnect()
    return
  }
  socket = nextSocket
  let socketAuthTimer = null

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) return
    socketAuthTimer = setTimeout(() => {
      try {
        nextSocket.close()
      } catch {
        // Ignore.
      }
    }, 5000)
    sendRaw({ type: 'auth', token: target.token, extensionVersion: EXTENSION_VERSION })
  })

  nextSocket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (socket !== nextSocket) return
    handleServerMessage(message, nextSocket, () => {
      if (socketAuthTimer) {
        clearTimeout(socketAuthTimer)
        socketAuthTimer = null
      }
    })
  })

  nextSocket.addEventListener('close', (event) => {
    if (socket !== nextSocket) return
    authenticated = false
    stopClientHeartbeat()
    abortActiveTasksOnDisconnect()
    if (socketAuthTimer) {
      clearTimeout(socketAuthTimer)
      socketAuthTimer = null
    }
    if (event && event.code === 1008 && String(event.reason || '').includes('Client identity handshake timeout')) {
      setStatus('error', 'Расширение устарело или не поддерживает идентификацию браузера. Установите версию 0.3.4 или новее.')
      return
    }
    if (event && event.code === 1008 && String(event.reason || '').includes('Replaced')) {
      setStatus('idle', 'Подключение заменено другим окном Zen. Перезагрузите расширение.')
      return
    }
    if (socket === nextSocket) socket = null
    if (lastAuthError) {
      setStatus('error', lastAuthError)
      lastAuthError = ''
      // The app may have rotated its token; forget the old code and rediscover.
      void browser.storage.local.remove(PAIRING_KEY).then(() => {
        scheduleReconnect()
      })
      return
    }
    setStatus('disconnected', 'Нет соединения с Multi-AI Aggregator. Повторное подключение…')
    scheduleReconnect()
  })

  nextSocket.addEventListener('error', () => {
    // The close handler reports the state and schedules a retry.
  })
}

function abortActiveTasksOnDisconnect() {
  for (const task of activeTasks.values()) {
    task.cancelled = true
    if (task.tabId !== null) {
      try {
        const cancellation = browser.tabs.sendMessage(task.tabId, {
          type: 'mai:cancel',
          taskId: task.taskId,
        })
        if (cancellation && typeof cancellation.catch === 'function') {
          void cancellation.catch(() => {})
        }
      } catch {
        // The tab may already be closed; local orchestration is still aborted below.
      }
    }
    task.controller.abort()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect()
  }, RECONNECT_MS)
}

function handleServerMessage(message, sourceSocket, clearSourceAuthTimer) {
  if (socket !== sourceSocket) return
  if (!message || typeof message.type !== 'string') return
  if (message.type === 'auth-ok') {
    authenticated = true
    lastAuthError = ''
    clearSourceAuthTimer?.()
    setStatus('connecting', 'Авторизация подтверждена. Определение экземпляра браузера…')
    void announceClientIdentity().catch((error) => {
      setStatus('error', `Не удалось определить экземпляр браузера: ${error instanceof Error ? error.message : String(error)}`)
      if (socket === sourceSocket) sourceSocket.close()
    })
    return
  }
  if (message.type === 'auth-error') {
    lastAuthError = typeof message.message === 'string' ? message.message : 'Неверный код подключения.'
    void browser.storage.local.remove(PAIRING_KEY)
    if (socket) {
      try {
        socket.close()
      } catch {
        // Ignore.
      }
    }
    return
  }
  if (message.type === 'ping') {
    sendRaw({ type: 'pong' })
    return
  }
  if (message.type === 'command') {
    void runCommand(message)
  }
}

function errorPayload(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'unknown',
    message: error instanceof Error ? error.message : String(error),
    partial: typeof error?.partial === 'string' ? error.partial : undefined,
  }
}

function makeError(code, message, partial) {
  const error = new Error(message)
  error.code = code
  if (partial) error.partial = partial
  return error
}

function sendResponse(id, ok, data, error) {
  sendRaw({ type: 'response', id, ok, data, error })
}

async function runCommand(message) {
  const { id, action, payload } = message
  try {
    const data = await executeAction(action, payload)
    sendResponse(id, true, data)
  } catch (error) {
    sendResponse(id, false, undefined, errorPayload(error))
  }
}

function assertModel(value) {
  if (!MODELS.includes(value)) throw makeError('unknown', 'Неизвестная модель.')
  return value
}

function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim()) throw makeError('unknown', 'Запрос пуст.')
  if (value.length > 300_000) throw makeError('unknown', 'Запрос слишком длинный.')
  return value
}

function clampTimeout(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(330_000, Math.max(30_000, Math.floor(value)))
}

async function executeAction(action, payload) {
  if (action === 'open') {
    const tabs = await discoverProviderTabs()
    const existingId = tabs.chatgpt || tabs.qwen || tabs.deepseek
    let windowId = null
    if (existingId) {
      const existingTab = await browser.tabs.get(existingId).catch(() => null)
      windowId = existingTab?.windowId ?? null
    }

    if (!existingId) {
      const createdWindow = await browser.windows.create({ focused: false })
      windowId = createdWindow.id
    }

    for (const model of MODELS) {
      if (tabs[model]) continue
      const createdTab = await browser.tabs.create({
        ...(windowId !== null ? { windowId } : {}),
        url: ADAPTERS[model].url,
        active: false,
      })
      tabs[model] = createdTab.id
      if (windowId === null) windowId = createdTab.windowId
    }

    await saveTabsState({ ...(await getTabsState()), windowId, tabs })
    const targetId = tabs.chatgpt || tabs.qwen || tabs.deepseek
    const targetTab = await browser.tabs.get(targetId).catch(() => null)
    if (targetTab) {
      await focusWindow(targetTab.windowId)
      await activateTab(targetId)
    }
    return { opened: true, tabs }
  }

  if (action === 'focus') {

    const model = assertModel(payload?.model)
    const tabs = await discoverProviderTabs()
    const tabId = tabs[model]
    if (!tabId) throw makeError('browser', `Вкладка ${ADAPTERS[model].label} не найдена.`)
    const tab = await browser.tabs.get(tabId)
    await focusWindow(tab.windowId)
    await activateTab(tabId)
    return { focused: true }
  }

  if (action === 'checkSessions') {
    const tabs = await discoverProviderTabs()
    await saveTabsState({ ...(await getTabsState()), tabs })

    return Promise.all(MODELS.map(async (model) => {
      const tabId = tabs[model]
      if (!tabId) {
        return {
          model,
          status: 'unknown',
          message: `Вкладка ${ADAPTERS[model].label} не найдена. Откройте сайт в Zen или используйте «Открыть сайты».`,
        }
      }
      try {
        const tab = await browser.tabs.get(tabId).catch(() => null)
        if (!tab || !isProviderUrl(model, tab.url || '')) {
          return {
            model,
            status: 'unknown',
            message: 'Вкладка сервиса больше недоступна. Повторите проверку.',
          }
        }
        const info = await inspectModelSession(model, tabId)
        return { model, ...info }
      } catch (error) {
        return {
          model,
          status: 'error',
          message: error instanceof Error ? error.message : `Не удалось проверить ${ADAPTERS[model].label}.`,
        }
      }
    }))
  }

  if (action === 'send') {
    return runTask(payload)
  }

  if (action === 'cancelTask') {
    return cancelTask(payload)
  }

  throw makeError('unknown', `Неизвестное действие: ${String(action)}`)
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeError('cancelled', 'Операция отменена.')
}

function delay(ms, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(makeError('cancelled', 'Операция отменена.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function rememberFinishedTask(taskId, status) {
  finishedTasks.delete(taskId)
  finishedTasks.set(taskId, status)
  while (finishedTasks.size > FINISHED_TASK_LIMIT) {
    finishedTasks.delete(finishedTasks.keys().next().value)
  }
}

function runTask(payload) {
  const taskId = payload?.taskId
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw makeError('unknown', 'Некорректный идентификатор задачи.')
  }
  if (activeTasks.has(taskId) || finishedTasks.has(taskId)) {
    throw makeError('busy', 'Задача с таким идентификатором уже использовалась.')
  }

  const model = assertModel(payload?.model)
  const prompt = validatePrompt(payload?.prompt)
  const timeoutMs = clampTimeout(payload?.timeoutMs, 240_000)
  const purpose = payload?.purpose === 'synthesis' ? 'synthesis' : 'answer'
  const batchId = payload?.batchId
  if (batchId !== undefined && (typeof batchId !== 'string' || !TASK_ID_PATTERN.test(batchId))) {
    throw makeError('unknown', 'Некорректный идентификатор группы задач.')
  }

  const task = {
    taskId,
    batchId,
    model,
    controller: new AbortController(),
    tabId: null,
    cancelled: false,
    completion: null,
    cancelPromise: null,
  }
  activeTasks.set(taskId, task)
  task.completion = (async () => {
    try {
      const text = await runModelPrompt(model, prompt, timeoutMs, purpose, task)
      throwIfAborted(task.controller.signal)
      return { taskId, text }
    } finally {
      if (activeTasks.get(taskId) === task) activeTasks.delete(taskId)
      rememberFinishedTask(taskId, task.cancelled ? 'cancelled' : 'finished')
    }
  })()
  return task.completion
}

async function cancelTask(payload) {
  const taskId = payload?.taskId
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw makeError('unknown', 'Некорректный идентификатор задачи.')
  }

  const task = activeTasks.get(taskId)
  if (!task) {
    const finishedStatus = finishedTasks.get(taskId)
    if (finishedStatus === 'cancelled') return { taskId, cancelled: true }
    return finishedTasks.has(taskId)
      ? { taskId, cancelled: false, reason: 'already-finished' }
      : { taskId, cancelled: true }
  }
  if (task.cancelPromise) return task.cancelPromise

  task.cancelPromise = (async () => {
    try {
      if (task.tabId !== null) {
        let acknowledgement
        try {
          acknowledgement = await withTimeout(
            browser.tabs.sendMessage(task.tabId, { type: 'mai:cancel', taskId }),
            8_000,
            'Страница не подтвердила отмену автоматизации.',
          )
        } catch {
          throw makeError('browser', 'Страница не подтвердила отмену автоматизации.')
        }
        if (acknowledgement?.alreadyFinished === true || acknowledgement?.cancelled === false) {
          throw makeError('busy', 'Задача уже завершилась до обработки отмены.')
        }
        if (!acknowledgement?.ok || acknowledgement.taskId !== taskId || acknowledgement.cancelled !== true) {
          throw makeError('browser', 'Страница вернула некорректное подтверждение отмены.')
        }
      }

      task.cancelled = true
      task.controller.abort()
      try {
        await withTimeout(task.completion, 8_000, 'Автоматизация не завершилась после подтверждения отмены.')
      } catch (error) {
        if (error?.code !== 'cancelled') throw error
      }
      return { taskId, cancelled: true }
    } catch (error) {
      if (error?.code !== 'busy') {
        task.cancelled = true
        task.controller.abort()
      }
      throw error
    }
  })()
  return task.cancelPromise
}

async function getTabsState() {
  const data = await browser.storage.local.get(TABS_KEY)
  return data[TABS_KEY] && typeof data[TABS_KEY] === 'object' ? data[TABS_KEY] : { tabs: {} }
}

async function saveTabsState(state) {
  await browser.storage.local.set({ [TABS_KEY]: state })
}

function isProviderUrl(model, value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ADAPTERS[model].hosts.includes(url.hostname)
  } catch {
    return false
  }
}

async function discoverProviderTabs() {
  const [saved, allTabs] = await Promise.all([
    getTabsState(),
    browser.tabs.query({}),
  ])
  const discovered = {}
  for (const model of MODELS) {
    const savedId = saved.tabs?.[model]
    const candidates = allTabs.filter((tab) => isProviderUrl(model, tab.url || ''))
    const selected = candidates.sort((a, b) => {
      const active = Number(b.active) - Number(a.active)
      if (active) return active
      const recentlyUsed = Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0)
      if (recentlyUsed) return recentlyUsed
      const readiness = Number(b.status === 'complete') - Number(a.status === 'complete')
      if (readiness) return readiness
      return Number(b.id === savedId) - Number(a.id === savedId)
    })[0]
    if (selected?.id !== undefined) discovered[model] = selected.id
  }
  return discovered
}


async function focusWindow(windowId) {
  await browser.windows.update(windowId, { focused: true }).catch(() => {})
}

async function activateTab(tabId) {
  if (!tabId) return
  await browser.tabs.update(tabId, { active: true }).catch(() => {})
}

async function waitForTabLoaded(tabId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  await delay(300, signal)
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const tab = await browser.tabs.get(tabId).catch(() => null)
    if (!tab) throw makeError('browser', 'Вкладка Zen была закрыта.')
    if (tab.status === 'complete') return
    await delay(300, signal)
  }
  throw makeError('timeout', 'Страница сервиса не загрузилась за отведённое время.')
}

async function waitForContent(tabId, timeoutMs = 45_000, signal) {
  const deadline = Date.now() + timeoutMs
  let injectionAttempted = false
  let injectionError = null
  let lastPingError = null
  let lastTab = null
  let lastUrl = null
  let navigationVersion = 0
  let observedNavigationVersion = 0
  const onTabUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId === tabId && (changeInfo.status === 'loading' || typeof changeInfo.url === 'string')) {
      navigationVersion += 1
    }
  }

  browser.tabs.onUpdated?.addListener(onTabUpdated)
  try {
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const tab = await browser.tabs.get(tabId).catch(() => null)
      if (!tab) throw makeError('browser', 'Вкладка Zen была закрыта.')
      lastTab = tab

      const navigationChanged = navigationVersion !== observedNavigationVersion
        || (lastUrl !== null && tab.url !== lastUrl)
      if (navigationChanged || tab.status === 'loading') {
        injectionAttempted = false
        injectionError = null
        lastPingError = null
        observedNavigationVersion = navigationVersion
      }
      lastUrl = tab.url || lastUrl

      if (tab.status !== 'complete') {
        await delay(300, signal)
        continue
      }

      if (!injectionAttempted) {
        try {
          const ping = await browser.tabs.sendMessage(tabId, { type: 'mai:ping' })
          if (ping?.ok) return
          lastPingError = new Error('Content Script ответил без подтверждения mai:ping.')
        } catch (error) {
          lastPingError = error
        }

        injectionAttempted = true
        try {
          await browser.tabs.executeScript(tabId, { file: 'content/submission.js' })
          await browser.tabs.executeScript(tabId, { file: 'content/automation.js' })
        } catch (error) {
          injectionError = error
        }
      }

      try {
        const response = await browser.tabs.sendMessage(tabId, { type: 'mai:ping' })
        if (response?.ok) return
        lastPingError = new Error('Content Script не подтвердил готовность после внедрения.')
      } catch (error) {
        lastPingError = error
      }

      if (injectionError) {
        throw makeError(
          'site',
          `Не удалось активировать расширение на вкладке ${tab.url}. Проверьте разрешения Zen и перезагрузите эту вкладку вручную.`,
          injectionError instanceof Error ? injectionError.message : String(injectionError),
        )
      }
      await delay(300, signal)
    }

    const detail = injectionError instanceof Error
      ? injectionError.message
      : lastPingError instanceof Error
        ? lastPingError.message
        : 'ответ от Content Script не получен'
    throw makeError(
      'site',
      `Вкладка ${lastTab?.url || 'провайдера'} найдена, но скрипт автоматизации не отвечает. Последняя ошибка: ${detail}`,
      detail,
    )
  } finally {
    browser.tabs.onUpdated?.removeListener(onTabUpdated)
  }

}
async function ensureModelTab(model, options = {}) {
  throwIfAborted(options.signal)
  const tabs = await discoverProviderTabs()
  let tabId = tabs[model]
  if (!tabId) {
    const state = await getTabsState()
    const savedWindow = state.windowId
      ? await browser.windows.get(state.windowId).catch(() => null)
      : null
    const created = await browser.tabs.create({
      ...(savedWindow ? { windowId: savedWindow.id } : {}),
      url: ADAPTERS[model].url,
      active: false,
    })
    tabId = created.id
    tabs[model] = tabId
    await saveTabsState({ ...state, tabs })
    await waitForTabLoaded(tabId, 60_000, options.signal)
  }

  await waitForContent(tabId, 45_000, options.signal)
  return tabId
}

function loginUrlForModel(model, url) {
  const patterns = {
    chatgpt: /auth\.openai\.com|\/auth\/(?:login|signin|signup)|\/log-in/i,
    qwen: /\/login|\/signin|\/sign-in/i,
    deepseek: /\/sign_in|\/login|\/signin/i,
  }
  return patterns[model].test(url)
}

const SESSION_COOKIE_NAME_PATTERNS = {
  chatgpt: [/^__Secure-next-auth\.session-token(?:\.\d+)?$/i, /(?:^|[-_])(?:session|auth)[-_]?token(?:$|[._-])/i],
  qwen: [/^tongyi_sso_ticket$/i, /^login_aliyunid$/i, /(?:^|[-_])(?:session|auth)[-_]?token(?:$|[._-])/i],
  deepseek: [/^ds_session_id$/i, /(?:^|[-_])(?:session|auth)[-_]?token(?:$|[._-])/i],
}

async function getProviderCookieEvidence(model, tabUrl) {
  if (!browser.cookies?.getAll || !SESSION_COOKIE_NAME_PATTERNS[model]) {
    return { available: false, sessionCookiePresent: false }
  }

  try {
    const cookies = await browser.cookies.getAll({ url: tabUrl })
    const now = Date.now() / 1000
    const present = cookies.some((cookie) => {
      if (!cookie || typeof cookie.name !== 'string') return false
      if (!SESSION_COOKIE_NAME_PATTERNS[model].some((pattern) => pattern.test(cookie.name))) return false
      return cookie.session === true || (typeof cookie.expirationDate === 'number' && cookie.expirationDate > now)
    })
    return { available: true, sessionCookiePresent: present }
  } catch {
    return { available: false, sessionCookiePresent: false }
  }
}

async function inspectModelSession(model, tabId) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let tab = await browser.tabs.get(tabId).catch(() => null)
    if (!tab) throw makeError('browser', 'Вкладка сервиса закрыта.')

    if (loginUrlForModel(model, tab.url || '')) {
      return {
        status: 'login-required',
        message: 'Требуется вход в аккаунт.',
        url: tab.url,
      }
    }

    try {
      if (attempt > 0 && tab.status === 'loading') {
        await waitForTabLoaded(tabId, 30_000).catch(() => {})
      }
      await waitForContent(tabId, attempt === 0 ? 30_000 : 20_000)
      const cookieEvidence = await getProviderCookieEvidence(model, tab.url || ADAPTERS[model].url)
      const response = await browser.tabs.sendMessage(tabId, {
        type: 'mai:inspect',
        timeoutMs: 20_000,
        cookieEvidence,
      })
      if (!response?.ok) {
        throw makeError('site', response?.error?.message || 'Страница не ответила на проверку.')
      }

      return response.session
    } catch (error) {
      lastError = error
      tab = await browser.tabs.get(tabId).catch(() => null)
      if (tab && loginUrlForModel(model, tab.url || '')) {
        return { status: 'login-required', message: 'Требуется вход в аккаунт.', url: tab.url }
      }
      if (attempt < 2) await delay(1000 + attempt * 1500)
    }
  }

  throw makeError(
    'site',
    `${ADAPTERS[model].label}: проверка не завершилась. ${lastError instanceof Error ? `Причина: ${lastError.message}` : `Последняя ошибка: ${String(lastError ?? 'неизвестно')}`}.`,
    lastError instanceof Error ? lastError.message : String(lastError ?? ''),
  )
}

async function withTimeout(promise, timeoutMs, message, signal) {
  let timer
  let onAbort
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(makeError('timeout', message)), timeoutMs)
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(makeError('cancelled', 'Операция отменена.'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

async function runModelPrompt(model, prompt, timeoutMs, purpose, task) {
  const signal = task.controller.signal
  throwIfAborted(signal)
  const tabId = await ensureModelTab(model, { signal })
  task.tabId = tabId
  const label = ADAPTERS[model].label
  let response
  try {
    response = await withTimeout(
      browser.tabs.sendMessage(tabId, {
        type: 'mai:send',
        taskId: task.taskId,
        model,
        prompt,
        timeoutMs,
        purpose,
      }),
      timeoutMs + 15_000,
      `${label}: истекло время ожидания ответа.`,
      signal,
    )
  } catch (error) {
    if (signal.aborted) throw makeError('cancelled', 'Операция отменена.')
    if (error?.code) throw error
    throw makeError(
      'browser',
      `${label}: вкладка закрыта или перезагружена во время выполнения запроса.`,
    )
  }

  if (!response?.ok) {
    const info = response?.error || {}
    throw makeError(info.code || 'site', info.message || `${label}: неизвестная ошибка.`, info.partial)
  }
  if (typeof response.text !== 'string' || !response.text.trim()) {
    throw makeError('site', `${label}: сервис вернул пустой ответ.`)
  }
  return response.text
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (!message || typeof message.type !== 'string') return undefined

  if (message.type === 'mai:progress') {
    const task = typeof message.taskId === 'string' ? activeTasks.get(message.taskId) : null
    const validPhase = ['opening', 'sending', 'waiting'].includes(message.phase)
    const validTaskProgress = !message.taskId || (
      task && task.model === message.model && sender?.tab?.id === task.tabId
    )
    if (authenticated && MODELS.includes(message.model) && validPhase && validTaskProgress) {
      sendRaw({
        type: 'progress',
        ...(message.taskId ? { taskId: message.taskId } : {}),
        model: message.model,
        phase: message.phase,
        purpose: message.purpose,
      })
    }
    return undefined
  }

  if (message.type === 'mai:get-status') {
    return {
      ok: true,
      status: currentStatus,
      hasPairing: Boolean(await getPairing()),
      extensionVersion: EXTENSION_VERSION,
    }
  }

  if (message.type === 'mai:set-pairing') {
    const code = String(message.code || '').trim()
    try {
      parsePairing(code)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    await setPairing(code)
    lastAuthError = ''
    if (socket) {
      try {
        socket.close()
      } catch {
        // Ignore.
      }
    }
    await connect()
    return { ok: true }
  }

  if (message.type === 'mai:clear-pairing') {
    await browser.storage.local.remove(PAIRING_KEY)
    lastAuthError = ''
    if (socket) {
      try {
        socket.close()
      } catch {
        // Ignore.
      }
    }
    setStatus('idle', 'Код подключения удалён.')
    return { ok: true }
  }

  return undefined
})

void (async () => {
  await applyIntegrationPairing()
  await connect()
})()
