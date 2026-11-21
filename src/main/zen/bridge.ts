import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
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
  type ZenConnectionInfo,
} from '../../shared/types.js'
import { buildSynthesisPrompt } from '../automation/synthesis-prompt.js'

const DEFAULT_PORT = 45123
const PORT_ATTEMPTS = 12
const AUTH_TIMEOUT_MS = 5000
const HEARTBEAT_MS = 25_000
const CHECK_SESSIONS_TIMEOUT_MS = 90_000
const RESPONSE_TIMEOUT_MS = 240_000
const SYNTHESIS_TIMEOUT_MS = 300_000
const COMMAND_GRACE_MS = 30_000
const VALID_ERROR_CODES: TaskErrorCode[] = [
  'login',
  'manual',
  'blocked',
  'timeout',
  'busy',
  'browser',
  'site',
  'unknown',
]
const VALID_PROGRESS_PHASES = ['opening', 'sending', 'waiting'] as const

type EmitFn = (event: AggregatorEvent) => void
type ProgressPhase = (typeof VALID_PROGRESS_PHASES)[number]

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class BridgeError extends Error {
  code: TaskErrorCode
  partial?: string

  constructor(code: TaskErrorCode, message: string, partial?: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.partial = partial
  }
}

function isTaskErrorCode(value: unknown): value is TaskErrorCode {
  return typeof value === 'string' && VALID_ERROR_CODES.includes(value as TaskErrorCode)
}

function isProgressPhase(value: unknown): value is ProgressPhase {
  return typeof value === 'string' && VALID_PROGRESS_PHASES.includes(value as ProgressPhase)
}

function parseMessage(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString())
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function tokensEqual(expected: string, received: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export class ZenBridge {
  private readonly token: string
  private readonly tokenFile: string
  private server: WebSocketServer | null = null
  private httpServer: http.Server | null = null
  private socket: WebSocket | null = null
  private authenticated = false
  private extensionVersion: string | undefined
  private port = 0
  private started = false
  private info: BrowserInfo = { status: 'stopped', browserName: 'Zen Browser' }
  private running = new Set<ModelId>()
  private progressModels = new Set<ModelId>()
  private pending = new Map<string, PendingCommand>()
  private heartbeat: NodeJS.Timeout | null = null
  private alive = new WeakMap<WebSocket, boolean>()
  private commandSeq = 0
  private batchActive = false
  private synthesisActive = false
  private sessionCheck: Promise<SessionInfo[]> | null = null

  constructor(
    private readonly dataDir: string,
    private readonly emit: EmitFn,
  ) {
    this.tokenFile = path.join(dataDir, 'zen-bridge-token')
    this.token = this.loadOrCreateToken()
  }

  private loadOrCreateToken(): string {
    try {
      const existing = fs.readFileSync(this.tokenFile, 'utf8').trim()
      if (existing.length >= 24) return existing
    } catch {
      // The token does not exist yet.
    }
    const token = randomBytes(32).toString('base64url')
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this.tokenFile, token, { encoding: 'utf8', mode: 0o600 })
    return token
  }

  private setInfo(info: BrowserInfo): void {
    this.info = info
    this.emit({ type: 'browser', browser: this.getBrowserInfo() })
  }

  getBrowserInfo(): BrowserInfo {
    return { ...this.info }
  }

  getZenConnection(): ZenConnectionInfo {
    const port = this.port || Number(process.env.AGGREGATOR_ZEN_PORT) || DEFAULT_PORT
    const wsUrl = `ws://127.0.0.1:${port}`
    return {
      wsUrl,
      pairingCode: `${wsUrl}|${this.token}`,
      connected: Boolean(this.socket && this.authenticated),
      extensionVersion: this.extensionVersion,
    }
  }

  async start(): Promise<BrowserInfo> {
    if (this.started) return this.getBrowserInfo()
    this.started = true
    this.setInfo({
      status: 'starting',
      browserName: 'Zen Browser',
      message: 'Запуск локального моста для расширения Zen…',
    })

    const preferred = Number(process.env.AGGREGATOR_ZEN_PORT) || DEFAULT_PORT

    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
      const port = preferred + attempt
      const httpServer = http.createServer((request, response) => {
        this.handleHttp(request, response)
      })
      const server = new WebSocketServer({ server: httpServer })
      try {
        await new Promise<void>((resolve, reject) => {
          const onListening = (): void => {
            httpServer.off('error', onError)
            resolve()
          }
          const onError = (error: Error): void => {
            httpServer.off('listening', onListening)
            reject(error)
          }
          httpServer.once('listening', onListening)
          httpServer.once('error', onError)
          httpServer.listen(port, '127.0.0.1')
        })
        this.server = server
        this.httpServer = httpServer
        this.port = port
        break
      } catch {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve())
        })
      }
    }

    if (!this.server) {
      const message =
        'Не удалось открыть локальный порт для расширения Zen. Закройте программу, которая занимает порты 45123–45134, и перезапустите приложение.'
      this.setInfo({ status: 'error', browserName: 'Zen Browser', message })
      throw new Error(message)
    }

    this.server.on('connection', (socket, request) => {
      this.handleConnection(socket, request)
    })
    this.server.on('error', (error) => {
      console.error('[zen-bridge] WebSocket server error:', error)
    })

    this.heartbeat = setInterval(() => {
      for (const socket of this.server?.clients ?? []) {
        if (this.alive.get(socket) === false) {
          socket.terminate()
          continue
        }
        this.alive.set(socket, false)
        try {
          socket.ping()
        } catch {
          // The close handler will update the state.
        }
      }
    }, HEARTBEAT_MS)

    this.setInfo({
      status: 'starting',
      browserName: 'Zen Browser',
      message:
        'Мост запущен. Откройте расширение Multi-AI Aggregator Bridge в Zen и вставьте код подключения из приложения.',
    })
    return this.getBrowserInfo()
  }

  private handleHttp(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(404, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(JSON.stringify({ error: 'not-found' }))
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const origin = request.headers.origin || ''
    if (!origin.startsWith('moz-extension://')) {
      socket.close(1008, 'Origin is not allowed')
      return
    }

    this.alive.set(socket, true)
    let authenticated = false

    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(1001, 'Authentication timeout')
    }, AUTH_TIMEOUT_MS)

    socket.on('message', (raw) => {
      this.alive.set(socket, true)
      const message = parseMessage(raw)
      if (!message || typeof message.type !== 'string') return

      if (!authenticated) {
        if (message.type !== 'auth') {
          socket.close(1008, 'Authentication required')
          return
        }
        const received = typeof message.token === 'string' ? message.token : ''
        if (!tokensEqual(this.token, received)) {
          socket.send(JSON.stringify({ type: 'auth-error', message: 'Неверный код подключения.' }))
          socket.close(1008, 'Invalid token')
          return
        }
        authenticated = true
        clearTimeout(authTimer)
        this.adoptSocket(socket, message.extensionVersion)
        return
      }

      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }))
        return
      }
      if (message.type === 'pong') return
      if (message.type === 'progress') {
        this.handleProgress(message)
        return
      }
      if (message.type === 'response') {
        this.handleResponse(message)
      }
    })

    socket.on('pong', () => {
      this.alive.set(socket, true)
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
      this.alive.delete(socket)
      if (this.socket === socket) {
        this.socket = null
        this.authenticated = false
        this.extensionVersion = undefined
        const message = 'Расширение Zen отключилось. Ожидание повторного подключения…'
        this.setInfo({ status: 'starting', browserName: 'Zen Browser', message })
        this.rejectPending(new BridgeError('browser', message))
      }
    })

    socket.on('error', () => {
      // The close handler updates the application state.
    })
  }

  private adoptSocket(socket: WebSocket, extensionVersion: unknown): void {
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.close(1008, 'Replaced by a new connection')
      } catch {
        // Ignore.
      }
    }
    this.socket = socket
    this.authenticated = true
    this.extensionVersion = typeof extensionVersion === 'string' ? extensionVersion : undefined
    socket.send(JSON.stringify({ type: 'auth-ok', serverVersion: '0.1.0' }))
    this.setInfo({
      status: 'running',
      browserName: 'Zen Browser',
      message: 'Расширение Zen подключено. Сессии проверились автоматически.',
    })
    // Give the freshly created tabs time to load before the first check,
    // otherwise the UI would briefly show false errors for every model.
    setTimeout(() => {
      void this.checkSessions().catch((error: unknown) => {
        console.error('[zen-bridge] Automatic session check failed:', error)
      })
    }, 3500)
  }

  private handleProgress(message: Record<string, unknown>): void {
    if (this.synthesisActive) return
    const rawModel = message.model
    if (!MODEL_IDS.includes(rawModel as ModelId)) return
    const model = rawModel as ModelId
    if (!this.progressModels.has(model)) return
    if (!isProgressPhase(message.phase)) return
    this.emit({
      type: 'model',
      result: { model, status: message.phase, updatedAt: Date.now() },
    })
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = typeof message.id === 'string' ? message.id : ''
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)

    if (message.ok === true) {
      pending.resolve(message.data)
      return
    }

    const error =
      message.error && typeof message.error === 'object'
        ? (message.error as Record<string, unknown>)
        : {}
    const code = isTaskErrorCode(error.code) ? error.code : 'unknown'
    const text = typeof error.message === 'string' ? error.message : 'Расширение вернуло ошибку.'
    const partial = typeof error.partial === 'string' ? error.partial : undefined
    pending.reject(new BridgeError(code, text, partial))
  }

  private sendCommand(action: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.socket || !this.authenticated || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BridgeError(
          'browser',
          'Расширение Zen не подключено. Откройте расширение Multi-AI Aggregator Bridge в Zen и вставьте код подключения из приложения.',
        ),
      )
    }

    const socket = this.socket
    const id = `${Date.now()}-${++this.commandSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('timeout', 'Расширение Zen не ответило вовремя.'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ type: 'command', id, action, payload }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(
          new BridgeError(
            'browser',
            error instanceof Error ? error.message : 'Не удалось отправить команду в Zen.',
          ),
        )
      }
    })
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async openBrowser(): Promise<BrowserInfo> {
    await this.sendCommand('open', {}, 20_000)
    return this.getBrowserInfo()
  }

  async focusModel(model: ModelId): Promise<void> {
    await this.sendCommand('focus', { model }, 20_000)
  }

  async checkSessions(): Promise<SessionInfo[]> {
    if (!this.sessionCheck) {
      this.sessionCheck = this.runSessionCheck().finally(() => {
        this.sessionCheck = null
      })
    }
    return this.sessionCheck
  }

  private async runSessionCheck(): Promise<SessionInfo[]> {
    if (!this.socket || !this.authenticated) {
      const message =
        'Расширение Zen не подключено. Откройте расширение Multi-AI Aggregator Bridge в Zen и вставьте код подключения из приложения.'
      return MODEL_IDS.map((model) => ({ model, status: 'error' as const, message }))
    }

    try {
      const data = await this.sendCommand('checkSessions', {}, CHECK_SESSIONS_TIMEOUT_MS)
      const sessions = this.normalizeSessions(data)
      for (const session of sessions) this.emit({ type: 'session', session })
      return sessions
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Расширение Zen не смогло проверить сессии.'
      return MODEL_IDS.map((model) => {
        const session: SessionInfo = { model, status: 'error', message }
        this.emit({ type: 'session', session })
        return session
      })
    }
  }

  private normalizeSessions(data: unknown): SessionInfo[] {
    const source = Array.isArray(data) ? data : []
    const sessions: SessionInfo[] = []
    for (const model of MODEL_IDS) {
      const found = source.find(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && (item as Record<string, unknown>).model === model,
      )
      if (!found) {
        sessions.push({
          model,
          status: 'error',
          message: 'Расширение Zen не вернуло состояние этой модели.',
        })
        continue
      }
      const status =
        typeof found.status === 'string' &&
        [
          'unknown',
          'checking',
          'logged-in',
          'guest',
          'login-required',
          'manual-action',
          'blocked',
          'error',
        ].includes(found.status)
          ? (found.status as SessionInfo['status'])
          : 'error'
      sessions.push({
        model,
        status,
        message:
          typeof found.message === 'string' ? found.message : 'Состояние сессии не указано.',
        url: typeof found.url === 'string' ? found.url : undefined,
      })
    }
    return sessions
  }

  async sendAll(prompt: string): Promise<ModelResult[]> {
    if (this.batchActive || this.synthesisActive) {
      throw new Error('Запрос уже выполняется. Дождитесь завершения.')
    }
    if (this.running.size > 0) {
      throw new Error('Одна из моделей ещё выполняет запрос. Дождитесь завершения.')
    }
    if (!prompt.trim()) throw new Error('Запрос пуст.')

    this.batchActive = true
    try {
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
    this.progressModels.add(model)
    this.emit({ type: 'model', result: { model, status: 'opening', updatedAt: Date.now() } })

    try {
      const data = await this.sendCommand(
        'send',
        {
          model,
          prompt,
          timeoutMs: RESPONSE_TIMEOUT_MS,
          purpose: 'answer',
        },
        RESPONSE_TIMEOUT_MS + COMMAND_GRACE_MS,
      )
      const text =
        data && typeof data === 'object' && typeof (data as Record<string, unknown>).text === 'string'
          ? ((data as Record<string, unknown>).text as string).trim()
          : ''
      if (!text) {
        throw new BridgeError('site', `${MODEL_LABELS[model]}: сервис вернул пустой ответ.`)
      }
      const result: ModelResult = { model, status: 'done', text, updatedAt: Date.now() }
      this.emit({ type: 'model', result })
      return result
    } catch (error) {
      const result = this.errorResult(model, error)
      this.emit({ type: 'model', result })
      return result
    } finally {
      this.running.delete(model)
      this.progressModels.delete(model)
    }
  }

  private errorResult(model: ModelId, error: unknown): ModelResult {
    if (error instanceof BridgeError) {
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
    console.error(`[zen-bridge] ${MODEL_LABELS[model]} error:`, error)
    return {
      model,
      status: 'error',
      error: error instanceof Error ? error.message : `Ошибка при работе с ${MODEL_LABELS[model]}.`,
      errorCode: 'unknown',
      updatedAt: Date.now(),
    }
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    if (this.batchActive || this.synthesisActive || this.running.size > 0) {
      throw new Error('Другая операция уже выполняется. Дождитесь завершения.')
    }
    if (!MODEL_IDS.includes(request.model)) throw new Error('Неизвестная модель синтеза.')
    if (!request.prompt.trim()) throw new Error('Исходный запрос пуст.')

    const answers = (request.answers || []).filter((answer) => MODEL_IDS.includes(answer.model))
    if (!answers.some((answer) => answer.text?.trim())) {
      throw new Error('Нет ни одного полученного ответа для синтеза.')
    }

    this.synthesisActive = true
    this.running.add(request.model)
    try {
      const synthesisPrompt = buildSynthesisPrompt(request.prompt, answers)
      const data = await this.sendCommand(
        'send',
        {
          model: request.model,
          prompt: synthesisPrompt,
          timeoutMs: SYNTHESIS_TIMEOUT_MS,
          purpose: 'synthesis',
        },
        SYNTHESIS_TIMEOUT_MS + COMMAND_GRACE_MS,
      )
      const text =
        data && typeof data === 'object' && typeof (data as Record<string, unknown>).text === 'string'
          ? ((data as Record<string, unknown>).text as string).trim()
          : ''
      if (!text) throw new Error('Сервис вернул пустой итоговый ответ.')
      return { model: request.model, text }
    } finally {
      this.running.delete(request.model)
      this.synthesisActive = false
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    this.rejectPending(new BridgeError('browser', 'Приложение закрывается.'))
    this.authenticated = false
    this.socket = null
    const server = this.server
    this.server = null
    if (server) {
      for (const client of server.clients) {
        try {
          client.close(1001, 'Application is closing')
        } catch {
          // Ignore.
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    const httpServer = this.httpServer
    this.httpServer = null
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    this.info = { status: 'stopped', browserName: 'Zen Browser' }
  }
}
