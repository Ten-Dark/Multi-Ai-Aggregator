import { chromium, type BrowserContext, type Page } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import {
  MODEL_IDS,
  MODEL_LABELS,
  type AggregatorEvent,
  type BrowserInfo,
  type ModelId,
  type ModelResult,
  type SessionInfo,
  type SynthesisRequest,
  type SynthesisResult,
  type TaskErrorCode,
} from '../../shared/types.js'
import {
  ADAPTERS,
  AGE_PATTERNS,
  CHALLENGE_PATTERNS,
  LOGIN_DIALOG_PATTERNS,
  RATE_LIMIT_PATTERNS,
  type SiteAdapter,
} from './adapters.js'
import { buildSynthesisPrompt } from './synthesis-prompt.js'

const NAV_TIMEOUT_MS = 60_000
const COMPOSER_TIMEOUT_MS = 45_000
const RESPONSE_TIMEOUT_MS = 240_000
const SYNTHESIS_TIMEOUT_MS = 300_000
const SESSION_CHECK_TIMEOUT_MS = 20_000
const SEND_EVIDENCE_TIMEOUT_MS = 6_000
const POLL_MS = 500

type EmitFn = (event: AggregatorEvent) => void

interface PageInspection {
  url: string
  title: string
  bodySnippet: string
  dialogTexts: string[]
  composerVisible: boolean
  loginFormVisible: boolean
  loggedOutVisible: boolean
}

interface AnswerState {
  url: string
  assistantCount: number
  text: string
  streaming: boolean
  completeAttr: boolean | null
  composerText: string
}

type BlockerKind = 'challenge' | 'age' | 'login-dialog' | 'login-page' | 'error-page'

interface Blocker {
  kind: BlockerKind
  text?: string
}

class AutomationError extends Error {
  code: TaskErrorCode
  partial?: string

  constructor(code: TaskErrorCode, message: string, partial?: string) {
    super(message)
    this.name = 'AutomationError'
    this.code = code
    this.partial = partial
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sleepUntil(deadline: number, step = POLL_MS): Promise<void> {
  return delay(Math.max(0, Math.min(step, deadline - Date.now())))
}

function normalizeResponseText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Execution context was destroyed|most likely because of a navigation|Cannot find context|Target page, context or browser has been closed/i.test(
    message,
  )
}

function browserNameForChannel(channel: string | undefined): string {
  if (channel === 'chrome') return 'Google Chrome'
  if (channel === 'msedge') return 'Microsoft Edge'
  return 'Chromium (Playwright)'
}

function windowsBrowserPaths(): string[] {
  if (process.platform !== 'win32') return []
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env['LOCALAPPDATA'] || ''
  return [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(localAppData ? [path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
}

function detectBrowserChannels(): Array<string | undefined> {
  const preferred = process.env.AGGREGATOR_BROWSER_CHANNEL?.trim()
  if (preferred) return [preferred === 'chromium' ? undefined : preferred]

  const paths = windowsBrowserPaths()
  const chromeInstalled = paths.slice(0, 3).some((candidate) => {
    try {
      return fs.existsSync(candidate)
    } catch {
      return false
    }
  })
  const edgeInstalled = paths.slice(3).some((candidate) => {
    try {
      return fs.existsSync(candidate)
    } catch {
      return false
    }
  })

  const channels: Array<string | undefined> = []
  if (chromeInstalled) channels.push('chrome')
  if (edgeInstalled) channels.push('msedge')
  try {
    if (fs.existsSync(chromium.executablePath())) channels.push(undefined)
  } catch {
    // Playwright browser is not installed. System Chrome/Edge is still usable.
  }
  if (channels.length === 0) channels.push(undefined)
  return channels
}

function resultError(model: ModelId, error: unknown): ModelResult {
  const label = MODEL_LABELS[model]
  if (error instanceof AutomationError) {
    return {
      model,
      status: 'error',
      error: error.message,
      errorCode: error.code,
      partial: Boolean(error.partial),
      text: error.partial,
      updatedAt: Date.now(),
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  if (/Target page, context or browser has been closed|Browser has been closed|context has been closed/i.test(message)) {
    return {
      model,
      status: 'error',
      error: 'Браузер автоматизации закрыт. Откройте его снова и повторите запрос.',
      errorCode: 'browser',
      updatedAt: Date.now(),
    }
  }
  if (/Timeout .* exceeded/i.test(message)) {
    return {
      model,
      status: 'error',
      error: `Не удалось завершить запрос к ${label}: превышено время ожидания.`,
      errorCode: 'timeout',
      updatedAt: Date.now(),
    }
  }
  console.error(`[aggregator] ${label} error:`, error)
  return {
    model,
    status: 'error',
    error: `Ошибка при работе с ${label}: ${message}`,
    errorCode: 'site',
    updatedAt: Date.now(),
  }
}

export class AggregatorBrowser {
  private context: BrowserContext | null = null
  private pages = new Map<ModelId, Page>()
  private launchPromise: Promise<BrowserInfo> | null = null
  private info: BrowserInfo = { status: 'stopped' }
  private running = new Set<ModelId>()
  private batchActive = false
  private synthesisActive = false

  constructor(
    private readonly profileDir: string,
    private readonly emit: EmitFn,
  ) {}

  getBrowserInfo(): BrowserInfo {
    return { ...this.info }
  }

  async launch(): Promise<BrowserInfo> {
    if (this.context) return this.getBrowserInfo()
    if (this.launchPromise) return this.launchPromise
    this.launchPromise = this.doLaunch()
    try {
      return await this.launchPromise
    } finally {
      this.launchPromise = null
    }
  }

  private setInfo(info: BrowserInfo): void {
    this.info = info
    this.emit({ type: 'browser', browser: this.getBrowserInfo() })
  }

  private async doLaunch(): Promise<BrowserInfo> {
    if (this.context) return this.getBrowserInfo()

    this.setInfo({ status: 'starting', message: 'Запуск браузера автоматизации…' })
    fs.mkdirSync(this.profileDir, { recursive: true })

    const channels = detectBrowserChannels()
    const failures: string[] = []
    let context: BrowserContext | null = null
    let chosenChannel: string | undefined

    for (const channel of channels) {
      try {
        context = await chromium.launchPersistentContext(this.profileDir, {
          channel,
          headless: false,
          viewport: { width: 1440, height: 1000 },
          acceptDownloads: false,
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
          ],
        })
        chosenChannel = channel
        break
      } catch (error) {
        failures.push(
          `${browserNameForChannel(channel)}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        )
      }
    }

    if (!context) {
      const detail = failures.length > 0 ? failures.join(' | ') : 'браузер не найден'
      const message = `Не удалось запустить браузер автоматизации. Установите Microsoft Edge или Google Chrome. Детали: ${detail}`
      this.setInfo({ status: 'error', message })
      throw new AutomationError('browser', message)
    }

    this.context = context
    this.setInfo({
      status: 'running',
      browserName: browserNameForChannel(chosenChannel),
      message: 'Браузер открыт. Авторизация сохраняется между запусками.',
    })

    context.on('close', () => {
      if (this.context !== context) return
      this.context = null
      this.pages.clear()
      this.running.clear()
      this.setInfo({ status: 'stopped', message: 'Браузер закрыт.' })
    })

    const initialPages = context.pages()
    const pages: Page[] = []
    if (initialPages.length > 0) pages.push(initialPages[0])
    while (pages.length < MODEL_IDS.length) {
      pages.push(await context.newPage())
    }

    await Promise.all(
      MODEL_IDS.map(async (model, index) => {
        const page = pages[index]
        this.pages.set(model, page)
        page.on('close', () => {
          if (this.pages.get(model) === page) this.pages.delete(model)
        })
        page.on('crash', () => {
          if (this.pages.get(model) === page) this.pages.delete(model)
        })
        await page
          .goto(ADAPTERS[model].url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
          .catch((error: unknown) => {
            console.error(`[aggregator] Failed to preload ${MODEL_LABELS[model]}:`, error)
          })
      }),
    )

    return this.getBrowserInfo()
  }

  async openBrowser(): Promise<BrowserInfo> {
    const info = await this.launch()
    const page = this.pages.get('chatgpt')
    if (page && !page.isClosed()) {
      await page.bringToFront().catch(() => {})
    }
    return info
  }

  async focusModel(model: ModelId): Promise<void> {
    const page = await this.ensureModelPage(model)
    await page.bringToFront()
  }

  private async ensureModelPage(model: ModelId): Promise<Page> {
    let page = this.pages.get(model)
    if (page && !page.isClosed()) return page
    if (!this.context) await this.launch()
    if (!this.context) throw new AutomationError('browser', 'Браузер автоматизации не запущен.')

    page = await this.context.newPage()
    this.pages.set(model, page)
    const adapter = ADAPTERS[model]
    page.on('close', () => {
      if (this.pages.get(model) === page) this.pages.delete(model)
    })
    page.on('crash', () => {
      if (this.pages.get(model) === page) this.pages.delete(model)
    })
    await page
      .goto(adapter.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      .catch((error: unknown) => {
        console.error(`[aggregator] Failed to open ${adapter.label}:`, error)
      })
    return page
  }

  private async retryOnNavigation<T>(action: () => Promise<T>, attempts = 4): Promise<T> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await action()
      } catch (error) {
        lastError = error
        if (!isNavigationRace(error) || attempt === attempts - 1) throw error
        await delay(400 + attempt * 300)
      }
    }
    throw lastError
  }

  private async inspectPage(page: Page, adapter: SiteAdapter): Promise<PageInspection> {
    return this.retryOnNavigation(() =>
      page.evaluate(
      ({ composerSelectors, loginFormSelectors, loggedOutSelectors }) => {
        const isVisible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const style = getComputedStyle(element)
          return style.visibility !== 'hidden' && style.display !== 'none'
        }
        const anyVisible = (selectors: string[]): boolean => {
          for (const selector of selectors) {
            try {
              const elements = document.querySelectorAll(selector)
              for (const element of elements) {
                if (isVisible(element)) return true
              }
            } catch {
              // Ignore invalid selector from a site update.
            }
          }
          return false
        }
        const modalCandidates = document.querySelectorAll(
          '[role="dialog"], dialog, .ant-modal, [class*="modal"]',
        )
        const dialogTexts: string[] = []
        for (const element of modalCandidates) {
          if (!isVisible(element)) continue
          const text = ((element as HTMLElement).innerText || '').trim()
          if (text) dialogTexts.push(text.slice(0, 2000))
        }
        return {
          url: location.href,
          title: document.title,
          bodySnippet: (document.body?.innerText || '').slice(0, 6000),
          dialogTexts,
          composerVisible: anyVisible(composerSelectors),
          loginFormVisible: anyVisible(loginFormSelectors),
          loggedOutVisible: anyVisible(loggedOutSelectors),
        }
      },
      {
        composerSelectors: adapter.composerSelectors,
        loginFormSelectors: adapter.loginFormSelectors,
        loggedOutSelectors: adapter.loggedOutSelectors,
      },
    ))
  }

  private detectBlocker(inspection: PageInspection, adapter: SiteAdapter): Blocker | null {
    const dialogs = inspection.dialogTexts.join('\n')
    const pageCorpus = `${inspection.title}\n${inspection.bodySnippet}`

    if (
      matchesAny(CHALLENGE_PATTERNS, dialogs) ||
      (!inspection.composerVisible && matchesAny(CHALLENGE_PATTERNS, pageCorpus))
    ) {
      return { kind: 'challenge' }
    }
    if (
      matchesAny(AGE_PATTERNS, dialogs) ||
      (!inspection.composerVisible && matchesAny(AGE_PATTERNS, inspection.bodySnippet))
    ) {
      return { kind: 'age', text: dialogs }
    }
    if (matchesAny(LOGIN_DIALOG_PATTERNS, dialogs)) {
      return { kind: 'login-dialog', text: dialogs }
    }
    if (
      adapter.loginPageUrlPatterns.some((pattern) => pattern.test(inspection.url)) ||
      inspection.loginFormVisible
    ) {
      return { kind: 'login-page' }
    }
    if (
      /This site can.t be reached|Не удается получить доступ к сайту|ERR_(?:CONNECTION|NAME|INTERNET|NETWORK)/i.test(
        pageCorpus,
      )
    ) {
      return { kind: 'error-page' }
    }
    return null
  }

  private blockerError(blocker: Blocker, model: ModelId): AutomationError {
    const label = MODEL_LABELS[model]
    switch (blocker.kind) {
      case 'challenge':
        return new AutomationError(
          'blocked',
          `${label} показывает проверку безопасности (CAPTCHA / Cloudflare). Пройдите её вручную в открытом браузере, затем нажмите «Повторить».`,
        )
      case 'age':
        return new AutomationError(
          'manual',
          `${label} просит подтвердить возраст. Подтвердите это вручную в открытом браузере, затем нажмите «Повторить».`,
        )
      case 'login-dialog':
        return new AutomationError(
          'manual',
          `Завершите вход в ${label} в открытом браузере, затем нажмите «Повторить».`,
        )
      case 'login-page':
        return new AutomationError(
          'login',
          `Требуется вход в ${label}. Войдите в открытом браузере, затем нажмите «Повторить».`,
        )
      case 'error-page':
        return new AutomationError(
          'site',
          `Страница ${label} не загрузилась. Проверьте интернет в браузере автоматизации и повторите.`,
        )
      default:
        return new AutomationError('site', `Сервис ${label} недоступен.`)
    }
  }

  async checkSessions(): Promise<SessionInfo[]> {
    try {
      await this.launch()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Не удалось запустить браузер автоматизации.'
      return MODEL_IDS.map((model) => ({
        model,
        status: 'error' as const,
        message,
      }))
    }

    const results = await Promise.all(MODEL_IDS.map((model) => this.checkModelSession(model)))
    return results
  }

  private emitSession(session: SessionInfo): SessionInfo {
    this.emit({ type: 'session', session })
    return session
  }

  private async checkModelSession(model: ModelId): Promise<SessionInfo> {
    const adapter = ADAPTERS[model]
    try {
      const page = await this.ensureModelPage(model)
      const deadline = Date.now() + SESSION_CHECK_TIMEOUT_MS
      let inspection = await this.inspectPage(page, adapter)
      let blocker = this.detectBlocker(inspection, adapter)

      while (
        Date.now() < deadline &&
        !inspection.composerVisible &&
        !inspection.loginFormVisible &&
        !blocker
      ) {
        await delay(POLL_MS)
        if (page.isClosed()) throw new AutomationError('browser', 'Вкладка браузера закрыта.')
        inspection = await this.inspectPage(page, adapter)
        blocker = this.detectBlocker(inspection, adapter)
      }

      let session: SessionInfo
      if (blocker) {
        session = this.sessionForBlocker(model, blocker, adapter, inspection)
      } else if (inspection.composerVisible) {
        if (inspection.loggedOutVisible) {
          session = {
            model,
            status: 'guest',
            message: adapter.guestAllowed
              ? 'Гость — отправка доступна. Для стабильной работы войдите в аккаунт.'
              : 'Вход не выполнен.',
            url: inspection.url,
          }
        } else {
          session = {
            model,
            status: 'logged-in',
            message: 'Вход выполнен.',
            url: inspection.url,
          }
        }
      } else if (inspection.loginFormVisible) {
        session = {
          model,
          status: 'login-required',
          message: 'Требуется вход в аккаунт.',
          url: inspection.url,
        }
      } else {
        session = {
          model,
          status: 'error',
          message: `Форма ввода ${adapter.label} не найдена. Откройте вкладку и проверьте состояние страницы.`,
          url: inspection.url,
        }
      }

      return this.emitSession(session)
    } catch (error) {
      const session: SessionInfo = {
        model,
        status: 'error',
        message: error instanceof Error ? error.message : `Не удалось проверить ${adapter.label}.`,
      }
      return this.emitSession(session)
    }
  }

  private sessionForBlocker(
    model: ModelId,
    blocker: Blocker,
    adapter: SiteAdapter,
    inspection: PageInspection,
  ): SessionInfo {
    switch (blocker.kind) {
      case 'challenge':
        return {
          model,
          status: 'blocked',
          message: 'Пройдите проверку безопасности вручную в браузере.',
          url: inspection.url,
        }
      case 'age':
        return {
          model,
          status: 'manual-action',
          message: 'Подтвердите возраст вручную в браузере.',
          url: inspection.url,
        }
      case 'login-dialog':
        return {
          model,
          status: 'manual-action',
          message: 'Завершите вход в браузере.',
          url: inspection.url,
        }
      case 'login-page':
        return {
          model,
          status: 'login-required',
          message: adapter.guestAllowed
            ? 'Открыта страница входа. Завершите вход в браузере.'
            : 'Требуется вход в аккаунт.',
          url: inspection.url,
        }
      case 'error-page':
        return {
          model,
          status: 'error',
          message: 'Страница сервиса не загрузилась.',
          url: inspection.url,
        }
      default:
        return {
          model,
          status: 'error',
          message: `Не удалось определить состояние ${adapter.label}.`,
          url: inspection.url,
        }
    }
  }

  private async readAnswerState(page: Page, adapter: SiteAdapter): Promise<AnswerState> {
    return this.retryOnNavigation(() =>
      page.evaluate(
      ({ assistantSelectors, contentSelectors, stopSelectors, composerSelectors, completeAttribute }) => {
        const isVisible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const style = getComputedStyle(element)
          return style.visibility !== 'hidden' && style.display !== 'none'
        }
        const pickVisibleGroup = (selectors: string[]): Element[] => {
          for (const selector of selectors) {
            try {
              const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible)
              if (elements.length > 0) return elements
            } catch {
              // Ignore selectors that are no longer supported by the browser.
            }
          }
          return []
        }
        const anyVisible = (selectors: string[]): boolean => {
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

        let nodes = pickVisibleGroup(assistantSelectors)
        if (nodes.length === 0 && contentSelectors.length > 0) {
          nodes = pickVisibleGroup(contentSelectors)
        }
        nodes = nodes.filter(
          (element) => !nodes.some((other) => other !== element && other.contains(element)),
        )
        const last = nodes[nodes.length - 1] as HTMLElement | undefined

        let text = ''
        if (last) {
          let content: HTMLElement = last
          for (const selector of contentSelectors) {
            try {
              const elements = Array.from(last.querySelectorAll(selector)).filter(isVisible) as HTMLElement[]
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
        for (const selector of composerSelectors) {
          try {
            const composer = Array.from(document.querySelectorAll(selector)).find(isVisible) as
              | HTMLTextAreaElement
              | HTMLElement
              | undefined
            if (composer) {
              composerText =
                composer instanceof HTMLTextAreaElement
                  ? composer.value
                  : (composer.innerText || composer.textContent || '').toString()
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
          streaming: anyVisible(stopSelectors),
          completeAttr:
            completeAttribute && last ? last.hasAttribute(completeAttribute) : null,
          composerText,
        }
      },
      {
        assistantSelectors: adapter.assistantSelectors,
        contentSelectors: adapter.contentSelectors,
        stopSelectors: adapter.stopSelectors,
        composerSelectors: adapter.composerSelectors,
        completeAttribute: adapter.completeAttribute,
      },
    ))
  }

  private async dismissConsent(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        const isVisible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const style = getComputedStyle(element)
          return style.visibility !== 'hidden' && style.display !== 'none'
        }
        const necessaryOnly =
          /use necessary|necessary only|only necessary|necessary cookies only|только необходим|сохранять только обязательн|только обязательн/i
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[]
        const target = buttons.find(
          (button) => isVisible(button) && necessaryOnly.test(button.innerText || ''),
        )
        if (target) target.click()
      })
      await delay(300)
    } catch {
      // Consent banners are optional; ignore failures.
    }
  }

  private async waitForComposer(page: Page, adapter: SiteAdapter): Promise<void> {
    const deadline = Date.now() + COMPOSER_TIMEOUT_MS
    let lastInspection: PageInspection | null = null

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new AutomationError('browser', 'Вкладка браузера закрыта. Откройте браузер снова.')
      }
      lastInspection = await this.inspectPage(page, adapter)
      const blocker = this.detectBlocker(lastInspection, adapter)
      if (blocker) throw this.blockerError(blocker, adapter.id)
      if (lastInspection.composerVisible) return
      await delay(POLL_MS)
    }

    if (lastInspection?.loginFormVisible) {
      throw this.blockerError({ kind: 'login-page' }, adapter.id)
    }
    throw new AutomationError(
      'site',
      `${adapter.label}: не найдено поле ввода за ${Math.round(COMPOSER_TIMEOUT_MS / 1000)} с. Откройте вкладку сервиса и проверьте её состояние.`,
    )
  }

  private async fillComposer(page: Page, adapter: SiteAdapter, prompt: string): Promise<void> {
    let composer = null as ReturnType<Page['locator']> | null
    for (const selector of adapter.composerSelectors) {
      try {
        const locator = page.locator(selector).first()
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          composer = locator
          break
        }
      } catch {
        // Ignore.
      }
    }
    if (!composer) {
      throw new AutomationError('site', `${adapter.label}: поле ввода не найдено.`)
    }

    await composer.click({ timeout: 5000 }).catch(() => {})
    await composer.fill(prompt, { timeout: 20_000 })

    const value = await composer.evaluate((element) => {
      if (element instanceof HTMLTextAreaElement) return element.value
      return (element as HTMLElement).innerText || element.textContent || ''
    })
    if (!value.trim()) {
      throw new AutomationError('site', `${adapter.label}: не удалось заполнить поле ввода.`)
    }
    await delay(400)
  }

  private async markSendCandidate(page: Page, adapter: SiteAdapter): Promise<boolean> {
    return page.evaluate(
      ({ composerSelectors, sendSelectors }) => {
        const isVisible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          const style = getComputedStyle(element)
          return style.visibility !== 'hidden' && style.display !== 'none'
        }
        const isEnabled = (element: Element): boolean => {
          if (element instanceof HTMLButtonElement && element.disabled) return false
          if (element.getAttribute('aria-disabled') === 'true') return false
          if (element.classList.contains('disabled')) return false
          return true
        }
        const firstVisible = (selectors: string[]): HTMLElement | null => {
          for (const selector of selectors) {
            try {
              const element = Array.from(document.querySelectorAll(selector)).find(isVisible) as
                | HTMLElement
                | undefined
              if (element) return element
            } catch {
              // Ignore.
            }
          }
          return null
        }

        const composer = firstVisible(composerSelectors)
        if (!composer) return false

        const bad = /attach|file|upload|voice|microphone|dictat|model|mode|login|войти|settings|настрой|plus|плюс/i
        const good = /send|submit|отправ|发送/i
        const seen = new Set<Element>()
        const scored: Array<{ element: HTMLElement; score: number }> = []
        const composerRect = composer.getBoundingClientRect()

        sendSelectors.forEach((selector, selectorIndex) => {
          let elements: Element[] = []
          try {
            elements = Array.from(document.querySelectorAll(selector))
          } catch {
            return
          }
          for (const element of elements) {
            if (seen.has(element) || !isVisible(element) || !isEnabled(element)) continue
            seen.add(element)
            const aria = element.getAttribute('aria-label') || ''
            const className = typeof element.className === 'string' ? element.className : ''
            if (bad.test(aria) || bad.test(className)) continue

            let score = Math.max(0, 20 - selectorIndex * 2)
            if (good.test(aria) || good.test(className)) score += 80
            const rect = element.getBoundingClientRect()
            const verticalGap = Math.abs(
              rect.top + rect.height / 2 - (composerRect.top + composerRect.height / 2),
            )
            const horizontalGap = Math.abs(rect.left - composerRect.right)
            if (verticalGap < 220 && rect.left >= composerRect.left - 40) score += 45
            score -= Math.min(40, verticalGap / 12 + horizontalGap / 30)
            scored.push({ element: element as HTMLElement, score })
          }
        })

        if (scored.length === 0) {
          let container: HTMLElement | null = composer
          for (let depth = 0; depth < 8 && container?.parentElement; depth += 1) {
            container = container.parentElement
          }
          if (container) {
            const candidates = Array.from(
              container.querySelectorAll('button, [role="button"]'),
            ) as HTMLElement[]
            for (const element of candidates) {
              if (!isVisible(element) || !isEnabled(element)) continue
              const aria = element.getAttribute('aria-label') || ''
              const className = typeof element.className === 'string' ? element.className : ''
              if (bad.test(aria) || bad.test(className)) continue
              if (!good.test(aria) && !good.test(className)) continue
              scored.push({ element, score: 10 })
            }
          }
        }

        if (scored.length === 0) return false
        scored.sort((a, b) => b.score - a.score)
        document.querySelectorAll('[data-mai-send-target]').forEach((element) => {
          element.removeAttribute('data-mai-send-target')
        })
        scored[0].element.setAttribute('data-mai-send-target', '1')
        return true
      },
      {
        composerSelectors: adapter.composerSelectors,
        sendSelectors: adapter.sendSelectors,
      },
    )
  }

  private async waitForSendEvidence(
    page: Page,
    adapter: SiteAdapter,
    before: AnswerState,
  ): Promise<boolean> {
    const deadline = Date.now() + SEND_EVIDENCE_TIMEOUT_MS
    let lastInspectionAt = 0
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new AutomationError('browser', 'Браузер закрыт во время отправки запроса.')
      }
      if (Date.now() - lastInspectionAt > 1200) {
        const inspection = await this.inspectPage(page, adapter)
        const blocker = this.detectBlocker(inspection, adapter)
        if (blocker) throw this.blockerError(blocker, adapter.id)
        lastInspectionAt = Date.now()
      }
      const state = await this.readAnswerState(page, adapter)
      if (state.assistantCount > before.assistantCount) return true
      if (state.streaming) return true
      if (state.url !== before.url) return true
      if (before.composerText.trim() && !state.composerText.trim()) return true
      await delay(350)
    }
    return false
  }

  private async sendPrompt(
    page: Page,
    adapter: SiteAdapter,
    before: AnswerState,
  ): Promise<void> {
    const marked = await this.markSendCandidate(page, adapter)
    if (marked) {
      const target = page.locator('[data-mai-send-target]').first()
      await target.click({ timeout: 5000 }).catch(() => {})
      if (await this.waitForSendEvidence(page, adapter, before)) return
    }

    let composer = null as ReturnType<Page['locator']> | null
    for (const selector of adapter.composerSelectors) {
      try {
        const locator = page.locator(selector).first()
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          composer = locator
          break
        }
      } catch {
        // Ignore.
      }
    }

    if (composer) {
      await composer.press('Enter', { timeout: 5000 }).catch(() => {})
      if (await this.waitForSendEvidence(page, adapter, before)) return
      await composer.press('Control+Enter', { timeout: 5000 }).catch(() => {})
      if (await this.waitForSendEvidence(page, adapter, before)) return
    }

    throw new AutomationError(
      'site',
      `${adapter.label}: не удалось отправить запрос. Возможно, изменился интерфейс сервиса или требуется действие в браузере.`,
    )
  }

  private async waitForAnswer(
    page: Page,
    adapter: SiteAdapter,
    beforeCount: number,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let lastText = ''
    let stableSince = Date.now()
    let lastInspectionAt = 0

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new AutomationError('browser', 'Браузер закрыт во время ожидания ответа.')
      }
      if (Date.now() - lastInspectionAt > 2500) {
        const inspection = await this.inspectPage(page, adapter)
        const blocker = this.detectBlocker(inspection, adapter)
        if (blocker) throw this.blockerError(blocker, adapter.id)
        lastInspectionAt = Date.now()
      }

      const state = await this.readAnswerState(page, adapter)
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
              stableFor >=
                (adapter.completion === 'attribute' ? Math.max(8000, adapter.stableMs) : adapter.stableMs))

          if (completed) {
            await delay(250)
            const finalState = await this.readAnswerState(page, adapter)
            const finalText = normalizeResponseText(finalState.text || text)
            if (finalText.length < 500 && matchesAny(RATE_LIMIT_PATTERNS, finalText)) {
              throw new AutomationError('site', `${adapter.label}: ${finalText}`)
            }
            if (!finalText) {
              throw new AutomationError('site', `${adapter.label}: сервис вернул пустой ответ.`)
            }
            return finalText
          }
        }
      }
      await sleepUntil(deadline, 600)
    }

    const finalState = await this.readAnswerState(page, adapter).catch(() => null)
    const partial = normalizeResponseText(finalState?.text || '')
    if (partial) {
      throw new AutomationError(
        'timeout',
        `${adapter.label}: ответ не завершился за ${Math.round(timeoutMs / 1000)} с. Получен неполный ответ.`,
        partial,
      )
    }
    throw new AutomationError(
      'timeout',
      `${adapter.label}: ответ не получен за ${Math.round(timeoutMs / 1000)} с.`,
    )
  }

  private async executePrompt(
    model: ModelId,
    prompt: string,
    onStatus: (result: ModelResult) => void,
    timeoutMs: number,
  ): Promise<string> {
    const adapter = ADAPTERS[model]
    const label = adapter.label

    onStatus({ model, status: 'opening', updatedAt: Date.now() })
    const page = await this.ensureModelPage(model)

    try {
      await page.goto(adapter.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    } catch {
      throw new AutomationError(
        'site',
        `Не удалось открыть ${label}. Проверьте интернет и повторите.`,
      )
    }

    await this.waitForComposer(page, adapter)
    await this.dismissConsent(page)

    const before = await this.readAnswerState(page, adapter)

    onStatus({ model, status: 'sending', updatedAt: Date.now() })
    await this.fillComposer(page, adapter, prompt)

    const afterFill = await this.readAnswerState(page, adapter)
    await this.sendPrompt(page, adapter, {
      ...afterFill,
      assistantCount: before.assistantCount,
    })

    onStatus({ model, status: 'waiting', updatedAt: Date.now() })
    return this.waitForAnswer(page, adapter, before.assistantCount, timeoutMs)
  }

  async sendAll(prompt: string): Promise<ModelResult[]> {
    if (this.batchActive || this.synthesisActive) {
      throw new Error('Запрос уже выполняется. Дождитесь завершения.')
    }
    if (MODEL_IDS.some((model) => this.running.has(model))) {
      throw new Error('Одна из моделей ещё выполняет запрос. Дождитесь завершения.')
    }
    if (!prompt.trim()) throw new Error('Запрос пуст.')

    this.batchActive = true
    try {
      await this.launch()
      for (const model of MODEL_IDS) {
        this.emit({ type: 'model', result: { model, status: 'queued', updatedAt: Date.now() } })
      }
      return await Promise.all(MODEL_IDS.map((model) => this.sendOneInternal(model, prompt)))
    } finally {
      this.batchActive = false
    }
  }

  async sendOne(model: ModelId, prompt: string): Promise<ModelResult> {
    if (this.batchActive || this.synthesisActive) {
      throw new Error('Запрос уже выполняется. Дождитесь завершения.')
    }
    if (this.running.has(model)) {
      throw new Error(`${MODEL_LABELS[model]} уже выполняет запрос. Дождитесь завершения.`)
    }
    if (!prompt.trim()) throw new Error('Запрос пуст.')

    await this.launch()
    return this.sendOneInternal(model, prompt)
  }

  private async sendOneInternal(model: ModelId, prompt: string): Promise<ModelResult> {
    if (this.running.has(model)) {
      return {
        model,
        status: 'error',
        error: `${MODEL_LABELS[model]} уже выполняет запрос.`,
        errorCode: 'busy',
        updatedAt: Date.now(),
      }
    }

    this.running.add(model)
    const emitResult = (result: ModelResult): void => {
      this.emit({ type: 'model', result })
    }

    try {
      const text = await this.executePrompt(
        model,
        prompt,
        emitResult,
        RESPONSE_TIMEOUT_MS,
      )
      const result: ModelResult = {
        model,
        status: 'done',
        text,
        updatedAt: Date.now(),
      }
      emitResult(result)
      return result
    } catch (error) {
      const result = resultError(model, error)
      emitResult(result)
      return result
    } finally {
      this.running.delete(model)
    }
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    if (this.batchActive || this.synthesisActive || this.running.size > 0) {
      throw new Error('Другая операция уже выполняется. Дождитесь завершения.')
    }
    if (!MODEL_IDS.includes(request.model)) throw new Error('Неизвестная модель синтеза.')
    if (!request.prompt.trim()) throw new Error('Исходный запрос пуст.')

    const answers = (request.answers || []).filter((answer) =>
      MODEL_IDS.includes(answer.model),
    )
    if (!answers.some((answer) => answer.text?.trim())) {
      throw new Error('Нет ни одного полученного ответа для синтеза.')
    }

    this.synthesisActive = true
    this.running.add(request.model)
    try {
      await this.launch()
      const synthesisPrompt = buildSynthesisPrompt(request.prompt, answers)
      const text = await this.executePrompt(
        request.model,
        synthesisPrompt,
        () => {},
        SYNTHESIS_TIMEOUT_MS,
      )
      return { model: request.model, text }
    } catch (error) {
      if (error instanceof AutomationError) throw error
      throw new Error(
        error instanceof Error ? error.message : 'Не удалось собрать итоговый ответ.',
      )
    } finally {
      this.running.delete(request.model)
      this.synthesisActive = false
    }
  }

  async close(): Promise<void> {
    const context = this.context
    this.context = null
    this.pages.clear()
    if (context) {
      await context.close().catch(() => {})
    }
  }
}
