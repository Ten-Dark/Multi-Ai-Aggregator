(() => {
  'use strict'

  const host = location.hostname
  const MODEL = host === 'chatgpt.com' ? 'chatgpt' : host === 'chat.qwen.ai' ? 'qwen' : host === 'chat.deepseek.com' ? 'deepseek' : null
  if (!MODEL) return
  if (window.__maiAutomationLoaded) return
  window.__maiAutomationLoaded = true

  const ADAPTERS = {
    chatgpt: {
      id: 'chatgpt',
      label: 'ChatGPT',
      composerSelectors: [
        '#prompt-textarea',
        'textarea#mobile-composer-prompt',
        'textarea[name="prompt"]',
        'div.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"][data-lexical-editor="true"]',
      ],
      sendSelectors: [
        'button[aria-label*="Отправить" i]',
        'button[aria-label*="Send" i]',
        'button[data-testid="send-button"]',
        'button[data-testid="composer-send-button"]',
        'button[type="submit"]',
      ],
      assistantSelectors: ['li[data-message-role="assistant"]', '[data-message-author-role="assistant"]'],
      contentSelectors: ['[data-assistant-markdown]', '.markdown.prose', '.markdown'],
      stopSelectors: [
        'button[aria-label*="Перестать" i]',
        'button[aria-label*="Stop" i]',
        'button[data-testid="stop-button"]',
      ],
      loggedOutSelectors: ['button[data-login-button]', 'button[data-testid="login-button"]'],
      loginPageUrlPatterns: [/\/auth\/login/i, /\/auth\/signup/i, /auth\.openai\.com/i],
      loginFormSelectors: ['input[type="password"]'],
      completion: 'attribute',
      completeAttribute: 'data-message-complete',
      stableMs: 2500,
      guestAllowed: true,
    },
    qwen: {
      id: 'qwen',
      label: 'Qwen',
      composerSelectors: [
        'textarea.message-input-textarea',
        'textarea[placeholder="Ask Qwen"]',
        'textarea[placeholder*="Qwen"]',
        'textarea',
        '[contenteditable="true"][role="textbox"]',
      ],
      sendSelectors: [
        'button.send-button[aria-label="Send"]',
        'button.send-button',
        '.message-input-right-button-send',
        '.chat-prompt-send-button',
        'button[aria-label*="Send" i]',
      ],
      assistantSelectors: ['.response-message-content.phase-answer', '.response-message-content', '.custom-qwen-markdown', '.qwen-markdown'],
      contentSelectors: ['.custom-qwen-markdown', '.qwen-markdown'],
      stopSelectors: ['button.stop-button', '.stop-button', '[class*="stop-button"]', 'button[aria-label*="Stop" i]'],
      loggedOutSelectors: ['button.header-right-auth-button'],
      loginPageUrlPatterns: [/\/login/i, /\/signin/i, /\/sign-in/i],
      loginFormSelectors: ['input[type="password"]'],
      completion: 'stable',
      stableMs: 2800,
      guestAllowed: true,
    },
    deepseek: {
      id: 'deepseek',
      label: 'DeepSeek',
      composerSelectors: [
        'textarea#chat-input',
        'textarea[name="search"]',
        'textarea[placeholder*="DeepSeek"]',
        'textarea[placeholder*="Message"]',
        'textarea[placeholder*="Сообщение"]',
        'textarea',
        'div[contenteditable="true"][role="textbox"]',
      ],
      sendSelectors: [
        'button[aria-label*="Send" i]',
        'button[aria-label*="Отправить" i]',
        '[role="button"][aria-label*="Send" i]',
        '[role="button"][aria-label*="Отправить" i]',
        '.ds-button.ds-button--primary',
        'button[type="submit"]',
        '[role="button"].ds-icon-button',
      ],
      assistantSelectors: [
        '.ds-markdown.ds-assistant-message-main-content',
        '.ds-markdown.ds-markdown--block',
        '.ds-message .ds-markdown',
        '.ds-markdown:not(.ds-think-content .ds-markdown)',
      ],
      contentSelectors: [],
      stopSelectors: [
        'button[aria-label*="Stop" i]',
        '[role="button"][aria-label*="Stop" i]',
        '.ds-stop-button',
        '[class*="stop-button"]',
        '.ds-message-loading',
      ],
      loggedOutSelectors: [],
      loginPageUrlPatterns: [/\/sign_in/i, /\/login/i, /\/signin/i],
      loginFormSelectors: ['input[type="password"]'],
      completion: 'stable',
      stableMs: 3500,
      guestAllowed: false,
    },
  }

  const AGE_PATTERNS = [
    /confirm your age/i,
    /what year were you born/i,
    /подтвердите[^.\n]{0,30}возраст/i,
    /укажите[^.\n]{0,30}год рождения/i,
    /确认[^.\n]{0,10}年龄/i,
  ]

  const CHALLENGE_PATTERNS = [
    /(?:confirm|verify|check)(?:ing)? (?:that )?you(?:'re| are|.re)? (?:a )?human/i,
    /human verification/i,
    /security check before continuing/i,
    /verif(?:y|ies) that you are not a bot/i,
    /checking your browser/i,
    /just a moment/i,
    /cf-chl/i,
    /turnstile/i,
    /captcha/i,
    /подтвердите,? что вы (?:человек|робот)/i,
    /проверка браузера/i,
    /проверьте,? что вы человек/i,
    /人机验证/i,
  ]

  const LOGIN_DIALOG_PATTERNS = [
    /log\s?in to continue/i,
    /sign\s?in to continue/i,
    /log\s?in to keep/i,
    /войдите[^.\n]{0,40}(?:продолж|использ)/i,
    /войдите в (?:систему|аккаунт)/i,
    /guest (?:mode )?limit/i,
    /лимит[^.\n]{0,40}гост/i,
    /登录以继续/i,
  ]

  const RATE_LIMIT_PATTERNS = [
    /the server is busy[^.\n]*please try again later/i,
    /something went wrong[^.\n]*try again/i,
    /too many requests/i,
    /you(?:'|’)ve reached[^.\n]{0,80}limit/i,
    /rate limit[^.\n]{0,80}(?:reached|exceeded)/i,
    /слишком много запросов/i,
    /попробуйте (?:ещё|снова) (?:раз )?позже/i,
    /服务器繁忙/i,
    /请稍后再试/i,
  ]

  const adapter = ADAPTERS[MODEL]

  class MaiError extends Error {
    constructor(code, message, partial) {
      super(message)
      this.name = 'MaiError'
      this.code = code
      if (partial) this.partial = partial
    }
  }

  function errorPayload(error) {
    return {
      code: error instanceof MaiError ? error.code : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      partial: error instanceof MaiError ? error.partial : undefined,
    }
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw new MaiError('cancelled', 'Операция отменена.')
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
        reject(new MaiError('cancelled', 'Операция отменена.'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function matchesAny(patterns, text) {
    return patterns.some((pattern) => pattern.test(text))
  }

  function isVisible(element) {
    if (!element) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }

  function isEnabled(element) {
    if (element instanceof HTMLButtonElement && element.disabled) return false
    if (element.getAttribute('aria-disabled') === 'true') return false
    if (element.classList.contains('disabled')) return false
    return true
  }

  function visibleElements(selectors) {
    for (const selector of selectors) {
      try {
        const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible)
        if (elements.length > 0) return elements
      } catch {
        // Ignore selectors that a site no longer supports.
      }
    }
    return []
  }

  function anyVisible(selectors) {
    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          if (isVisible(element)) return true
        }
      } catch {
        // Ignore.
      }
    }
    return false
  }

  function normalizeResponseText(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function dialogTexts() {
    const texts = []
    const candidates = document.querySelectorAll('[role="dialog"], dialog, .ant-modal, [class*="modal"]')
    for (const element of candidates) {
      if (!isVisible(element)) continue
      const text = (element.innerText || '').trim()
      if (text) texts.push(text.slice(0, 2000))
    }
    return texts
  }

  function inspectPage() {
    return {
      url: location.href,
      title: document.title,
      bodySnippet: (document.body?.innerText || '').slice(0, 6000),
      dialogTexts: dialogTexts(),
      composerVisible: anyVisible(adapter.composerSelectors),
      loginFormVisible: anyVisible(adapter.loginFormSelectors),
      loggedOutVisible: anyVisible(adapter.loggedOutSelectors),
    }
  }

  function detectBlocker(page) {
    const dialogs = page.dialogTexts.join('\n')
    const corpus = `${page.title}\n${page.bodySnippet}`
    if (
      matchesAny(CHALLENGE_PATTERNS, dialogs) ||
      (!page.composerVisible && matchesAny(CHALLENGE_PATTERNS, corpus))
    ) {
      return { kind: 'challenge' }
    }
    if (
      matchesAny(AGE_PATTERNS, dialogs) ||
      (!page.composerVisible && matchesAny(AGE_PATTERNS, page.bodySnippet))
    ) {
      return { kind: 'age' }
    }
    if (matchesAny(LOGIN_DIALOG_PATTERNS, dialogs)) return { kind: 'login-dialog' }
    if (adapter.loginPageUrlPatterns.some((pattern) => pattern.test(page.url)) || page.loginFormVisible) {
      return { kind: 'login-page' }
    }
    if (/This site can.t be reached|Не удается получить доступ к сайту|ERR_(?:CONNECTION|NAME|INTERNET|NETWORK)/i.test(corpus)) {
      return { kind: 'error-page' }
    }
    return null
  }

  function blockerError(blocker) {
    switch (blocker.kind) {
      case 'challenge':
        return new MaiError(
          'blocked',
          `${adapter.label} показывает проверку безопасности. Пройдите её вручную в этой вкладке, затем нажмите «Повторить».`,
        )
      case 'age':
        return new MaiError(
          'manual',
          `${adapter.label} просит подтвердить возраст. Подтвердите это вручную в этой вкладке, затем нажмите «Повторить».`,
        )
      case 'login-dialog':
        return new MaiError(
          'manual',
          `Завершите вход в ${adapter.label} в этой вкладке, затем нажмите «Повторить».`,
        )
      case 'login-page':
        return new MaiError(
          'login',
          `Требуется вход в ${adapter.label}. Войдите в этой вкладке, затем нажмите «Повторить».`,
        )
      case 'error-page':
        return new MaiError('site', `Страница ${adapter.label} не загрузилась. Проверьте интернет и повторите.`)
      default:
        return new MaiError('site', `Сервис ${adapter.label} недоступен.`)
    }
  }

  function sessionForBlocker(blocker, page) {
    switch (blocker.kind) {
      case 'challenge':
        return { status: 'blocked', message: 'Пройдите проверку безопасности вручную в этой вкладке.', url: page.url }
      case 'age':
        return { status: 'manual-action', message: 'Подтвердите возраст вручную в этой вкладке.', url: page.url }
      case 'login-dialog':
        return { status: 'manual-action', message: 'Завершите вход в этой вкладке.', url: page.url }
      case 'login-page':
        return {
          status: 'login-required',
          message: adapter.guestAllowed ? 'Открыта страница входа. Завершите вход в этой вкладке.' : 'Требуется вход в аккаунт.',
          url: page.url,
        }
      case 'error-page':
        return { status: 'error', message: 'Страница сервиса не загрузилась.', url: page.url }
      default:
        return { status: 'error', message: `Не удалось определить состояние ${adapter.label}.`, url: page.url }
    }
  }

  async function inspectSession(timeoutMs = 20_000) {
    const deadline = Date.now() + Math.max(1000, Math.min(30_000, timeoutMs))
    let page = inspectPage()
    while (Date.now() < deadline) {
      page = inspectPage()
      const blocker = detectBlocker(page)
      if (blocker) return sessionForBlocker(blocker, page)
      if (page.composerVisible) {
        if (page.loggedOutVisible) {
          return {
            status: 'guest',
            message: adapter.guestAllowed
              ? 'Гость — отправка доступна. Для стабильной работы войдите в аккаунт.'
              : 'Вход не выполнен.',
            url: page.url,
          }
        }
        return { status: 'logged-in', message: 'Вход выполнен.', url: page.url }
      }
      if (page.loginFormVisible) {
        return { status: 'login-required', message: 'Требуется вход в аккаунт.', url: page.url }
      }
      await delay(300)
    }

    return {
      status: 'error',
      message: `Форма ввода ${adapter.label} не найдена. Откройте вкладку и проверьте состояние страницы.`,
      url: page.url,
    }
  }

  function readAnswerState() {
    let nodes = visibleElements(adapter.assistantSelectors)
    if (nodes.length === 0 && adapter.contentSelectors.length > 0) {
      nodes = visibleElements(adapter.contentSelectors)
    }
    nodes = nodes.filter((element) => !nodes.some((other) => other !== element && other.contains(element)))
    const last = nodes[nodes.length - 1]

    let text = ''
    if (last) {
      let content = last
      for (const selector of adapter.contentSelectors) {
        try {
          const elements = Array.from(last.querySelectorAll(selector)).filter(isVisible)
          if (elements.length > 0) {
            content = elements[elements.length - 1]
            break
          }
        } catch {
          // Ignore.
        }
      }
      text = (content.innerText || content.textContent || '').trim()
    }

    let composerText = ''
    for (const selector of adapter.composerSelectors) {
      try {
        const composer = Array.from(document.querySelectorAll(selector)).find(isVisible)
        if (composer) {
          composerText =
            composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
              ? composer.value
              : composer.innerText || composer.textContent || ''
          break
        }
      } catch {
        // Ignore.
      }
    }

    return {
      url: location.href,
      assistantCount: nodes.length,
      text,
      streaming: anyVisible(adapter.stopSelectors),
      completeAttr: adapter.completeAttribute && last ? last.hasAttribute(adapter.completeAttribute) : null,
      composerText,
    }
  }

  function setNativeValue(element, value) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null
    if (prototype) {
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      if (setter) setter.call(element, value)
      else element.value = value
    } else {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.execCommand('insertText', false, value)
      if (!(element.innerText || element.textContent || '').trim()) {
        element.textContent = value
      }
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function fillComposer(composer, prompt) {
    composer.focus()
    setNativeValue(composer, prompt)
  }

  function findSendButton(composer) {
    const bad = /attach|file|upload|voice|microphone|dictat|model|mode|login|войти|settings|настрой|plus|плюс/i
    const good = /send|submit|отправ|发送/i
    const seen = new Set()
    const scored = []
    const composerRect = composer.getBoundingClientRect()

    const addCandidate = (element, baseScore) => {
      if (!element || seen.has(element) || !isVisible(element) || !isEnabled(element)) return
      const aria = element.getAttribute('aria-label') || ''
      const title = element.getAttribute('title') || ''
      const className = typeof element.className === 'string' ? element.className : ''
      if (bad.test(aria) || bad.test(title) || bad.test(className)) return
      seen.add(element)
      let score = baseScore
      if (good.test(aria) || good.test(title) || good.test(className) || good.test(element.innerText || '')) {
        score += 80
      }
      const rect = element.getBoundingClientRect()
      const verticalGap = Math.abs(rect.top + rect.height / 2 - (composerRect.top + composerRect.height / 2))
      const horizontalGap = Math.abs(rect.left - composerRect.right)
      if (verticalGap < 260 && rect.left >= composerRect.left - 60) score += 45
      score -= Math.min(40, verticalGap / 12 + horizontalGap / 30)
      scored.push({ element, score })
    }

    adapter.sendSelectors.forEach((selector, index) => {
      let elements = []
      try {
        elements = Array.from(document.querySelectorAll(selector))
      } catch {
        return
      }
      for (const element of elements) addCandidate(element, Math.max(0, 20 - index * 2))
    })

    if (scored.length === 0) {
      let container = composer
      for (let depth = 0; depth < 8 && container?.parentElement; depth += 1) {
        container = container.parentElement
      }
      if (container) {
        for (const element of container.querySelectorAll('button, [role="button"]')) {
          addCandidate(element, 10)
        }
      }
    }

    if (scored.length === 0) return null
    scored.sort((a, b) => b.score - a.score)
    return scored[0].element
  }

  function clickElement(element) {
    element.scrollIntoView({ block: 'center', inline: 'center' })
    element.click()
  }

  async function waitForSendButton(composer, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const button = findSendButton(composer)
      if (button) return button
      await delay(200, signal)
    }
    return null
  }

  async function waitForSendEvidence(before, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    let lastInspectionAt = 0
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (Date.now() - lastInspectionAt > 1200) {
        const page = inspectPage()
        const blocker = detectBlocker(page)
        if (blocker) throw blockerError(blocker)
        lastInspectionAt = Date.now()
      }
      const state = readAnswerState()
      if (state.assistantCount > before.assistantCount) return true
      if (state.streaming) return true
      if (state.url !== before.url) return true
      if (before.composerText.trim() && !state.composerText.trim()) return true
      await delay(350, signal)
    }
    return false
  }

  function sendProgress(phase, purpose, taskId) {
    try {
      void browser.runtime.sendMessage({ type: 'mai:progress', taskId, model: MODEL, phase, purpose })
    } catch {
      // The background page may be restarting; progress is best-effort.
    }
  }

  async function waitForComposer(timeoutMs, signal) {
    throwIfAborted(signal)
    const deadline = Date.now() + timeoutMs
    let page = inspectPage()
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      page = inspectPage()
      const blocker = detectBlocker(page)
      if (blocker) throw blockerError(blocker)
      if (page.composerVisible) {
        for (const selector of adapter.composerSelectors) {
          try {
            const composer = Array.from(document.querySelectorAll(selector)).find(isVisible)
            if (composer) return composer
          } catch {
            // Ignore.
          }
        }
      }
      await delay(300, signal)
    }
    throw new MaiError('site', `${adapter.label}: не найдено поле ввода. Откройте вкладку и проверьте страницу.`)
  }

  async function dismissConsent(signal) {
    throwIfAborted(signal)
    const necessaryOnly =
      /use necessary|necessary only|only necessary|necessary cookies only|только необходим|сохранять только обязательн|только обязательн/i
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    const target = buttons.find((button) => isVisible(button) && necessaryOnly.test(button.innerText || ''))
    if (target) {
      target.click()
      await delay(300, signal)
    }
  }

  async function waitForAnswer(beforeCount, timeoutMs, signal) {
    throwIfAborted(signal)
    const deadline = Date.now() + timeoutMs
    let lastText = ''
    let stableSince = Date.now()
    let lastInspectionAt = 0

    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (Date.now() - lastInspectionAt > 2500) {
        const page = inspectPage()
        const blocker = detectBlocker(page)
        if (blocker) throw blockerError(blocker)
        lastInspectionAt = Date.now()
      }

      const state = readAnswerState()
      if (state.assistantCount > beforeCount) {
        const text = normalizeResponseText(state.text)
        if (text) {
          if (text !== lastText) {
            lastText = text
            stableSince = Date.now()
          }
          const stableFor = Date.now() - stableSince
          const completed =
            (adapter.completion === 'attribute' && state.completeAttr === true) ||
            (!state.streaming &&
              stableFor >= (adapter.completion === 'attribute' ? Math.max(8000, adapter.stableMs) : adapter.stableMs))

          if (completed) {
            await delay(250, signal)
            throwIfAborted(signal)
            const finalState = readAnswerState()
            const finalText = normalizeResponseText(finalState.text || text)
            if (finalText.length < 500 && matchesAny(RATE_LIMIT_PATTERNS, finalText)) {
              throw new MaiError('site', `${adapter.label}: ${finalText}`)
            }
            if (!finalText) {
              throw new MaiError('site', `${adapter.label}: сервис вернул пустой ответ.`)
            }
            return finalText
          }
        }
      }
      await delay(500, signal)
    }

    const finalState = readAnswerState()
    const partial = normalizeResponseText(finalState.text)
    if (partial) {
      throw new MaiError(
        'timeout',
        `${adapter.label}: ответ не завершился за ${Math.round(timeoutMs / 1000)} с. Получен неполный ответ.`,
        partial,
      )
    }
    throw new MaiError('timeout', `${adapter.label}: ответ не получен за ${Math.round(timeoutMs / 1000)} с.`)
  }

  async function runSend(prompt, timeoutMs, purpose, taskId, signal) {
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    const composer = await waitForComposer(Math.min(45_000, timeoutMs), signal)
    throwIfAborted(signal)
    await dismissConsent(signal)

    throwIfAborted(signal)
    const before = readAnswerState()
    fillComposer(composer, prompt)
    await delay(400, signal)
    throwIfAborted(signal)
    const afterFill = readAnswerState()
    if (!afterFill.composerText.trim()) {
      throw new MaiError('site', `${adapter.label}: не удалось заполнить поле ввода.`)
    }

    sendProgress('sending', purpose, taskId)
    const button = await waitForSendButton(composer, 5000, signal)
    throwIfAborted(signal)
    if (button) {
      clickElement(button)
    } else if (composer.form) {
      composer.form.requestSubmit()
    } else {
      throw new MaiError('site', `${adapter.label}: не найдена кнопка отправки.`)
    }

    const evidenceState = { ...afterFill, assistantCount: before.assistantCount, url: before.url }
    let sent = await waitForSendEvidence(evidenceState, 5000, signal)

    if (!sent) {
      throwIfAborted(signal)
      const form = composer.form
      if (form) form.requestSubmit()
      sent = await waitForSendEvidence(evidenceState, 5000, signal)
    }

    if (!sent) {
      throw new MaiError(
        'site',
        `${adapter.label}: не удалось отправить запрос. Возможно, изменился интерфейс сервиса или требуется действие в браузере.`,
      )
    }

    sendProgress('waiting', purpose, taskId)
    return waitForAnswer(before.assistantCount, Math.max(5000, deadline - Date.now()), signal)
  }

  const activeRuns = new Map()
  const finishedRuns = new Map()
  const cancelledBeforeStart = new Map()
  const RUN_HISTORY_LIMIT = 128
  const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

  function rememberRun(map, taskId, status) {
    map.delete(taskId)
    map.set(taskId, status)
    while (map.size > RUN_HISTORY_LIMIT) map.delete(map.keys().next().value)
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return undefined

    if (message.type === 'mai:ping') {
      return Promise.resolve({ ok: true, model: MODEL })
    }

    if (message.type === 'mai:inspect') {
      return inspectSession(message.timeoutMs)
        .then((session) => ({ ok: true, session }))
        .catch((error) => ({ ok: false, error: errorPayload(error) }))
    }

    if (message.type === 'mai:send') {
      const taskId = message.taskId
      if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
        return Promise.resolve({ ok: false, error: errorPayload(new MaiError('unknown', 'Некорректный идентификатор задачи.')) })
      }
      if (finishedRuns.has(taskId)) {
        return Promise.resolve({ ok: false, taskId, error: errorPayload(new MaiError('busy', 'Задача с таким идентификатором уже завершена.')) })
      }
      if (cancelledBeforeStart.has(taskId)) {
        cancelledBeforeStart.delete(taskId)
        rememberRun(finishedRuns, taskId, 'cancelled')
        return Promise.resolve({ ok: false, taskId, error: errorPayload(new MaiError('cancelled', 'Операция отменена до запуска.')) })
      }
      if (activeRuns.has(taskId)) {
        return Promise.resolve({ ok: false, error: errorPayload(new MaiError('busy', 'Задача с таким идентификатором уже выполняется.')) })
      }
      const prompt = typeof message.prompt === 'string' ? message.prompt : ''
      const timeoutMs = Number.isFinite(message.timeoutMs) ? message.timeoutMs : 240_000
      const purpose = message.purpose === 'synthesis' ? 'synthesis' : 'answer'
      const controller = new AbortController()
      const run = {
        controller,
        promise: null,
      }
      run.promise = runSend(prompt, timeoutMs, purpose, taskId, controller.signal)
        .then((text) => {
          run.status = 'finished'
          return { ok: true, text, taskId }
        })
        .catch((error) => {
          run.status = error?.code === 'cancelled' ? 'cancelled' : 'finished'
          return { ok: false, error: errorPayload(error), taskId }
        })
        .finally(() => {
          if (activeRuns.get(taskId) === run) activeRuns.delete(taskId)
          rememberRun(finishedRuns, taskId, run.status || 'finished')
        })
      activeRuns.set(taskId, run)
      return run.promise
    }

    if (message.type === 'mai:cancel') {
      const taskId = message.taskId
      if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
        return Promise.resolve({ ok: false, cancelled: false, error: 'Некорректный идентификатор задачи.' })
      }
      const run = activeRuns.get(taskId)
      if (!run) {
        const finishedStatus = finishedRuns.get(taskId)
        if (finishedStatus) {
          return Promise.resolve({
            ok: true,
            cancelled: finishedStatus === 'cancelled',
            taskId,
            alreadyFinished: finishedStatus !== 'cancelled',
          })
        }
        rememberRun(cancelledBeforeStart, taskId, 'cancelled')
        return Promise.resolve({ ok: true, cancelled: true, taskId, pendingStart: true })
      }
      run.controller.abort()
      return run.promise.then(() => ({ ok: true, cancelled: true, taskId }))
    }

    return undefined
  })
})()
