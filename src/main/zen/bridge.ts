import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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
  type TaskId,
  type ZenConnectionInfo,
  type ZenConnectorInfo,
} from '../../shared/types.js'
import { buildSynthesisPrompt } from '../synthesis/prompt.js'
import { isAllowedZenExtensionOrigin, isValidZenExtensionOrigin } from './origin.js'
import {
  isZenAuthMessage,
  isZenClientHeartbeatMessage,
  isZenClientInfoMessage,
  isZenProgressMessage,
  isZenResponseMessage,
  type ZenClientInfoMessage,
  type ZenProgressMessage,
  type ZenResponseMessage,
} from './protocol.js'
import { TaskRegistry, type ActiveTask } from './task-registry.js'
import { ZenConnectorRegistry } from './connector-registry.js'
import { securePrivateDirectory, securePrivateFile } from './secure-storage.js'

const DEFAULT_PORT = 45123
const PORT_ATTEMPTS = 12
const AUTH_TIMEOUT_MS = 5000
const HEARTBEAT_MS = 25_000
const CLIENT_HEARTBEAT_TIMEOUT_MS = 45_000
const CHECK_SESSIONS_TIMEOUT_MS = 90_000
const RESPONSE_TIMEOUT_MS = 240_000
const SYNTHESIS_TIMEOUT_MS = 300_000
const COMMAND_GRACE_MS = 30_000
type EmitFn = (event: AggregatorEvent) => void

interface ZenBridgeStorageSecurity {
  secureDirectory: (directory: string) => void
  secureFile: (filePath: string, directory: string) => void
}

interface PendingCommand {
  socket: WebSocket
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
  private readonly secureDir: string
  private readonly tokenFile: string
  private readonly extensionOriginFile: string
  private approvedExtensionOrigin: string | null = null
  private server: WebSocketServer | null = null
  private httpServer: http.Server | null = null
  private socket: WebSocket | null = null
  private authenticated = false
  private extensionVersion: string | undefined
  private port = 0
  private started = false
  private startPromise: Promise<BrowserInfo> | null = null
  private info: BrowserInfo = { status: 'stopped', browserName: 'Zen Browser' }
  private readonly taskRegistry = new TaskRegistry()
  private readonly connectors = new ZenConnectorRegistry<WebSocket>()
  private readonly handshakeTimers = new Map<WebSocket, NodeJS.Timeout>()
  private readonly authenticatedVersions = new Map<WebSocket, string | undefined>()
  private running = new Set<ModelId>()
  private progressModels = new Set<ModelId>()
  private pending = new Map<string, PendingCommand>()
  private heartbeat: NodeJS.Timeout | null = null
  private clientHeartbeatAt = 0

  private clientInfo: Omit<ZenClientInfoMessage, 'type'> | null = null
  private alive = new WeakMap<WebSocket, boolean>()
  private commandSeq = 0
  private batchActive = false
  private synthesisActive = false
  private sessionCheck: Promise<SessionInfo[]> | null = null

  constructor(
    private readonly dataDir: string,
    private readonly emit: EmitFn,
    private readonly storageSecurity: ZenBridgeStorageSecurity = {
      secureDirectory: securePrivateDirectory,
      secureFile: securePrivateFile,
    },
  ) {
    this.secureDir = path.join(dataDir, 'zen-secure')
    this.tokenFile = path.join(this.secureDir, 'zen-bridge-token')
    this.extensionOriginFile = path.join(this.secureDir, 'zen-bridge-origin')
    this.token = this.loadOrCreateToken()
    this.approvedExtensionOrigin = this.loadApprovedExtensionOrigin()
  }

  private loadApprovedExtensionOrigin(): string | null {
    try {
      const origin = fs.readFileSync(this.extensionOriginFile, 'utf8').trim()
      if (!isValidZenExtensionOrigin(origin)) {
        throw new Error('Stored Zen extension origin is invalid.')
      }
      return origin
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  private approveExtensionOrigin(origin: string): boolean {
    if (this.approvedExtensionOrigin) return this.approvedExtensionOrigin === origin
    try {
      fs.mkdirSync(path.dirname(this.extensionOriginFile), { recursive: true })
      fs.writeFileSync(this.extensionOriginFile, origin, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      this.approvedExtensionOrigin = origin
      return true
    } catch (error) {
      // Another connection may have completed first; only accept its exact origin.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        this.approvedExtensionOrigin = this.loadApprovedExtensionOrigin()
        return this.approvedExtensionOrigin === origin
      }
      console.error('[zen-bridge] Could not persist the approved extension origin:', error)
      return false
    }
  }

  private loadOrCreateToken(): string {
    this.storageSecurity.secureDirectory(this.secureDir)
    let existingToken: string | null = null
    try {
      this.storageSecurity.secureFile(this.tokenFile, this.secureDir)
      const existing = fs.readFileSync(this.tokenFile, 'utf8').trim()
      if (existing.length >= 24) existingToken = existing
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const token = existingToken ?? randomBytes(32).toString('base64url')
    if (!existingToken) {
      fs.writeFileSync(this.tokenFile, token, { encoding: 'utf8', mode: 0o600, flag: 'w' })
      this.storageSecurity.secureFile(this.tokenFile, this.secureDir)
    }

    // The legacy token lived directly under userData and inherited its broad DACL.
    // Rotate it only after the replacement is stored and ACL-verified.
    const legacyTokenFile = path.join(this.dataDir, 'zen-bridge-token')
    try {
      fs.unlinkSync(legacyTokenFile)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    return token
  }

  private setInfo(info: BrowserInfo): void {
    this.info = info
    this.emit({ type: 'browser', browser: this.getBrowserInfo() })
    this.emit({ type: 'zen-connection', connection: this.getZenConnection() })
  }

  getBrowserInfo(): BrowserInfo {
    return { ...this.info }
  }

  getZenConnection(): ZenConnectionInfo {
    const port = this.port || Number(process.env.AGGREGATOR_ZEN_PORT) || DEFAULT_PORT
    const wsUrl = `ws://127.0.0.1:${port}`
    const active = this.connectors.getActive()
    const connectors: ZenConnectorInfo[] = this.connectors.list().map((connector) => ({
      instanceId: connector.instanceId,
      browserName: connector.browserName,
      browserVersion: connector.browserVersion,
      extensionVersion: connector.extensionVersion,
      connectedAt: connector.connectedAt,
      lastHeartbeatAt: connector.lastHeartbeatAt,
      active: connector.instanceId === active?.instanceId,
    }))
    return {
      wsUrl,
      pairingCode: `${wsUrl}|${this.token}`,
      connected: Boolean(active && this.connectors.isFresh(active, Date.now(), CLIENT_HEARTBEAT_TIMEOUT_MS)
        && active.transport.readyState === WebSocket.OPEN),
      extensionVersion: active?.extensionVersion,
      extensionInstanceId: active?.instanceId,
      browserName: active?.browserName,
      browserVersion: active?.browserVersion,
      lastHeartbeatAt: active?.lastHeartbeatAt,
      activeConnectorId: active?.instanceId,
      connectors,
    }
  }

  setActiveConnector(instanceId: string): ZenConnectionInfo {
    const target = this.connectors.get(instanceId)
    if (!target || target.transport.readyState !== WebSocket.OPEN
      || !this.connectors.isFresh(target, Date.now(), CLIENT_HEARTBEAT_TIMEOUT_MS)) {
      throw new BridgeError('browser', 'Выбранный профиль браузера больше не подключён или не отвечает.')
    }
    if (this.connectors.getActive()?.instanceId !== instanceId
      && (this.pending.size > 0 || this.running.size > 0 || this.batchActive || this.synthesisActive || this.sessionCheck)) {
      throw new BridgeError('busy', 'Нельзя переключить профиль, пока выполняются команды. Дождитесь завершения текущих операций.')
    }
    if (!this.connectors.setActive(instanceId)) {
      throw new BridgeError('browser', 'Выбранный профиль браузера больше не подключён.')
    }
    this.syncActiveConnector()
    const active = this.connectors.getActive()
    this.setInfo({
      status: 'running',
      browserName: active?.browserName ?? 'Zen Browser',
      message: 'Активный профиль браузера изменён.',
    })
    void this.checkSessions().catch((error: unknown) => {
      console.error('[zen-bridge] Session check after connector selection failed:', error)
    })
    return this.getZenConnection()
  }

  async start(): Promise<BrowserInfo> {
    if (this.started) return this.getBrowserInfo()
    if (this.startPromise) return this.startPromise

    const startPromise = this.startInternal()
    this.startPromise = startPromise
    try {
      return await startPromise
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null
    }
  }

  private async startInternal(): Promise<BrowserInfo> {
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
      const server = new WebSocketServer({
        server: httpServer,
        maxPayload: 1 * 1024 * 1024,
        perMessageDeflate: false,
      })
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

    this.started = true
    this.server.on('connection', (socket, request) => {
      this.handleConnection(socket, request)
    })
    this.server.on('error', (error) => {
      console.error('[zen-bridge] WebSocket server error:', error)
    })

    this.heartbeat = setInterval(() => {
      for (const socket of this.server?.clients ?? []) {
        const connector = this.connectors.getByTransport(socket)
        if (connector && !this.connectors.isFresh(connector, Date.now(), CLIENT_HEARTBEAT_TIMEOUT_MS)) {
          socket.terminate()
          continue
        }

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
    if (!isAllowedZenExtensionOrigin(origin, this.approvedExtensionOrigin)) {
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
      if (!message || typeof message.type !== 'string') {
        socket.close(1007, 'Invalid message payload')
        return
      }

      if (!authenticated) {
        if (message.type !== 'auth') {
          socket.close(1008, 'Authentication required')
          return
        }
        if (!isZenAuthMessage(message)) {
          socket.close(1007, 'Invalid authentication payload')
          return
        }
        const received = message.token
        if (!tokensEqual(this.token, received)) {
          socket.send(JSON.stringify({ type: 'auth-error', message: 'Неверный код подключения.' }))
          socket.close(1008, 'Invalid token')
          return
        }
        if (!this.approveExtensionOrigin(origin)) {
          socket.send(JSON.stringify({
            type: 'auth-error',
            message: 'Не удалось закрепить источник расширения. Проверьте доступ к каталогу данных приложения.',
          }))
          socket.close(1011, 'Could not persist extension origin')
          return
        }
        authenticated = true
        clearTimeout(authTimer)
        this.adoptSocket(socket, message.extensionVersion)
        return
      }

      if (message.type === 'client-info') {
        const expectedVersion = this.authenticatedVersions.get(socket)
        if (!isZenClientInfoMessage(message) || message.extensionVersion !== expectedVersion) {
          socket.close(1007, 'Invalid client identity payload')
          return
        }
        const registration = this.connectors.register({
          instanceId: message.instanceId,
          browserName: message.browserName,
          browserVersion: message.browserVersion,
          extensionVersion: message.extensionVersion,
        }, socket)
        const handshakeTimer = this.handshakeTimers.get(socket)
        if (handshakeTimer) clearTimeout(handshakeTimer)
        this.handshakeTimers.delete(socket)
        this.authenticatedVersions.delete(socket)
        if (registration.replacedTransport && registration.replacedTransport !== socket) {
          registration.replacedTransport.close(1008, 'Reconnected from the same browser profile')
        }
        this.syncActiveConnector()
        if (this.connectors.getActive()?.transport === socket) {
          this.setInfo({
            status: 'running',
            browserName: message.browserName,
            message: `Подключён профиль: ${message.browserName} ${message.browserVersion}.`,
          })
          setTimeout(() => {
            if (this.connectors.getActive()?.transport !== socket) return
            void this.checkSessions().catch((error: unknown) => {
              console.error('[zen-bridge] Automatic session check failed:', error)
            })
          }, 3500)
        } else {
          this.emit({ type: 'zen-connection', connection: this.getZenConnection() })
        }
        return
      }

      const connector = this.connectors.getByTransport(socket)
      if (!connector) {
        socket.close(1008, 'Client identity handshake required')
        return
      }


      if (message.type === 'client-heartbeat') {
        if (!isZenClientHeartbeatMessage(message)
          || !this.connectors.heartbeat(socket, message.instanceId)) {
          socket.close(1008, 'Client heartbeat identity mismatch')
          return
        }
        if (this.connectors.getActive()?.transport === socket) {
          this.clientHeartbeatAt = connector.lastHeartbeatAt
        }
        this.emit({ type: 'zen-connection', connection: this.getZenConnection() })
        return
      }
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }))
        return
      }
      if (message.type === 'pong') return
      if (message.type === 'progress') {
        if (!isZenProgressMessage(message)) {
          socket.close(1007, 'Invalid progress payload')
          return
        }
        this.handleProgress(message, socket)
        return
      }
      if (message.type === 'response') {
        if (!isZenResponseMessage(message)) {
          socket.close(1007, 'Invalid response payload')
          return
        }
        this.handleResponse(message, socket)
        return
      }
      socket.close(1008, 'Unsupported message type')
    })

    socket.on('pong', () => {
      this.alive.set(socket, true)
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
      this.alive.delete(socket)
      const handshakeTimer = this.handshakeTimers.get(socket)
      if (handshakeTimer) clearTimeout(handshakeTimer)
      this.handshakeTimers.delete(socket)
      this.authenticatedVersions.delete(socket)
      const removed = this.connectors.remove(socket)
      this.rejectPending(new BridgeError('browser', 'Профиль браузера отключился.'), socket)
      if (!removed) return
      const wasActive = this.socket === socket
      if (wasActive) {
        this.syncActiveConnector()
        const active = this.connectors.getActive()
        if (active) {
          this.setInfo({
            status: 'running',
            browserName: active.browserName,
            message: 'Переключено на другой подключённый профиль браузера.',
          })
        } else {
          this.setInfo({
            status: 'starting',
            browserName: 'Zen Browser',
            message: 'Все профили браузеров отключены. Ожидание повторного подключения…',
          })
        }

        if (active) {
          setTimeout(() => {
            if (this.connectors.getActive() !== active) return
            void this.checkSessions().catch((error: unknown) => {
              console.error('[zen-bridge] Session check after connector failover failed:', error)
            })
          }, 3500)
        }
      } else {
        this.emit({ type: 'zen-connection', connection: this.getZenConnection() })
      }
    })

    socket.on('error', () => {
      // The close handler updates the application state.
    })
  }
  private adoptSocket(socket: WebSocket, extensionVersion: unknown): void {
    const version = typeof extensionVersion === 'string' ? extensionVersion : undefined
    this.authenticatedVersions.set(socket, version)
    socket.send(JSON.stringify({ type: 'auth-ok', serverVersion: '0.1.0' }))
    const timer = setTimeout(() => {
      if (!this.connectors.getByTransport(socket)) socket.close(1008, 'Client identity handshake timeout')
    }, 10_000)
    this.handshakeTimers.set(socket, timer)
    if (!this.connectors.getActive()) {
      this.setInfo({
        status: 'starting',
        browserName: 'Zen Browser',
        message: 'Авторизация подтверждена. Проверяется экземпляр браузера…',
      })
    }
  }

  private syncActiveConnector(): void {
    const active = this.connectors.getActive()
    this.socket = active?.transport ?? null
    this.authenticated = Boolean(active)
    this.extensionVersion = active?.extensionVersion
    this.clientInfo = active ? {
      instanceId: active.instanceId,
      browserName: active.browserName,
      browserVersion: active.browserVersion,
      extensionVersion: active.extensionVersion,
    } : null
    this.clientHeartbeatAt = active?.lastHeartbeatAt ?? 0
  }

  private handleProgress(message: ZenProgressMessage, socket: WebSocket): void {
    if (this.synthesisActive) return
    const { model, phase, taskId } = message
    if (!this.progressModels.has(model)) return

    const task = taskId
      ? this.taskRegistry.get(taskId)
      : this.taskRegistry.getByModel(model)
    if (taskId && (!task || task.model !== model || task.connectorId !== this.connectors.getByTransport(socket)?.instanceId)) return
    if (!task || task.connectorGeneration !== this.connectors.getByTransport(socket)?.generation) return
    if (!this.taskRegistry.setStatus(task.taskId, phase)) return

    this.emit({
      type: 'model',
      result: {
        model,
        taskId: task?.taskId,
        batchId: task?.batchId,
        status: phase,
        updatedAt: Date.now(),
      },
    })
  }

  private handleResponse(message: ZenResponseMessage, socket: WebSocket): void {
    const pending = this.pending.get(message.id)
    if (!pending || pending.socket !== socket) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)

    if (message.ok) {
      pending.resolve(message.data)
      return
    }

    const { error } = message
    pending.reject(new BridgeError(error.code ?? 'unknown', error.message, error.partial))
  }

  private sendCommand(action: string, payload: unknown, timeoutMs: number, connectorId?: string, expectedGeneration?: number): Promise<unknown> {
    const active = connectorId ? this.connectors.get(connectorId) : this.connectors.getActive()
    if (!active || active.transport.readyState !== WebSocket.OPEN
      || !this.connectors.isFresh(active, Date.now(), CLIENT_HEARTBEAT_TIMEOUT_MS)
      || (expectedGeneration !== undefined && active.generation !== expectedGeneration)) {
      return Promise.reject(new BridgeError(
        'browser',
        connectorId
          ? 'Профиль браузера, закреплённый за задачей, отключён или не отвечает.'
          : 'Расширение Zen не подключено. Откройте расширение Multi-AI Aggregator Bridge в браузере и вставьте код подключения из приложения.',
      ))
    }

    const socket = active.transport
    const id = `${Date.now()}-${++this.commandSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('timeout', 'Расширение Zen не ответило вовремя.'))
      }, timeoutMs)
      this.pending.set(id, { socket, resolve, reject, timer })
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

  private rejectPending(error: Error, socket?: WebSocket): void {
    for (const [id, pending] of this.pending) {
      if (socket && pending.socket !== socket) continue
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
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
          'session-available',
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

    const batchId = randomUUID()
    const taskIds = new Map(MODEL_IDS.map((model) => [model, randomUUID()]))
    this.batchActive = true
    try {
      for (const model of MODEL_IDS) {
        this.emit({
          type: 'model',
          result: {
            model,
            taskId: taskIds.get(model),
            batchId,
            status: 'queued',
            updatedAt: Date.now(),
          },
        })
      }
      return await Promise.all(
        MODEL_IDS.map((model) => this.sendOneInternal(model, prompt, taskIds.get(model)!, batchId)),
      )
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
    return this.sendOneInternal(model, prompt, randomUUID())
  }

  async cancelTask(taskId: TaskId): Promise<{ accepted: boolean; confirmed?: boolean; status?: string }> {
    const task = this.taskRegistry.get(taskId)
    if (!task) return { accepted: false, status: 'not-found' }
    if (['done', 'error', 'cancelled'].includes(task.status)) {
      return { accepted: false, confirmed: task.cancelConfirmed, status: task.status }
    }
    if (task.cancelPromise) {
      return {
        accepted: await task.cancelPromise,
        confirmed: task.cancelConfirmed,
        status: task.status,
      }
    }

    const cancellingTask = this.taskRegistry.beginCancellation(taskId)
    if (!cancellingTask) return { accepted: false, status: task.status }
    this.emit({
      type: 'model',
      result: {
        model: task.model,
        taskId: task.taskId,
        batchId: task.batchId,
        status: 'cancelling',
        updatedAt: Date.now(),
      },
    })

    const cancelPromise = this.sendCommand('cancelTask', { taskId }, 10_000, task.connectorId, task.connectorGeneration)
      .then((data) => {
        const acknowledged =
          Boolean(data) &&
          typeof data === 'object' &&
          (data as Record<string, unknown>).taskId === taskId &&
          (data as Record<string, unknown>).cancelled === true
        if (!acknowledged) {
          this.taskRegistry.restoreAfterCancellationFailure(taskId)
          this.emitTaskStatus(task, task.status)
          return false
        }

        const result: ModelResult = {
          model: task.model,
          taskId: task.taskId,
          batchId: task.batchId,
          status: 'cancelled',
          error: 'Запрос отменён.',
          updatedAt: Date.now(),
        }
        const finalized = this.taskRegistry.finishCancelled(taskId, result)
        if (finalized) this.emit({ type: 'model', result: finalized })
        return Boolean(finalized)
      })
      .catch((error: unknown) => {
        if (task.result?.status === 'cancelled') return true
        if (error instanceof BridgeError && (error.code === 'timeout' || error.code === 'browser')) {
          const result: ModelResult = {
            model: task.model,
            taskId: task.taskId,
            batchId: task.batchId,
            status: 'cancelled',
            error: 'Отмена не подтверждена расширением; локальная задача закрыта.',
            updatedAt: Date.now(),
          }
          const finalized = this.taskRegistry.finishCancelled(taskId, result, false)
          if (finalized) this.emit({ type: 'model', result: finalized })
          return Boolean(finalized)
        }
        this.taskRegistry.restoreAfterCancellationFailure(taskId)
        this.emitTaskStatus(task, task.status)
        console.warn('[zen-bridge] Task cancellation was not acknowledged:', error)
        return false
      })
      .finally(() => {
        task.cancelPromise = undefined
      })

    task.cancelPromise = cancelPromise
    return { accepted: await cancelPromise, confirmed: task.cancelConfirmed, status: task.status }
  }

  async cancelBatch(batchId: TaskId): Promise<{ accepted: number; rejected: number }> {
    const tasks = this.taskRegistry.getBatch(batchId).filter(
      (task) => !['done', 'error', 'cancelled'].includes(task.status),
    )
    const outcomes = await Promise.all(tasks.map((task) => this.cancelTask(task.taskId)))
    return {
      accepted: outcomes.filter((outcome) => outcome.accepted).length,
      rejected: outcomes.filter((outcome) => !outcome.accepted).length,
    }
  }

  private emitTaskStatus(task: ActiveTask, status: ActiveTask['status']): void {
    this.emit({
      type: 'model',
      result: {
        model: task.model,
        taskId: task.taskId,
        batchId: task.batchId,
        status,
        updatedAt: Date.now(),
      },
    })
  }

  private async sendOneInternal(
    model: ModelId,
    prompt: string,
    taskId: TaskId = randomUUID(),
    batchId?: TaskId,
  ): Promise<ModelResult> {
    if (this.running.has(model)) {
      return {
        model,
        taskId,
        batchId,
        status: 'error',
        error: `${MODEL_LABELS[model]} уже выполняет запрос.`,
        errorCode: 'busy',
        updatedAt: Date.now(),
      }
    }

    const connector = this.connectors.getActive()
    if (!connector || connector.transport.readyState !== WebSocket.OPEN
      || !this.connectors.isFresh(connector, Date.now(), CLIENT_HEARTBEAT_TIMEOUT_MS)) {
      return {
        model, taskId, batchId, status: 'error',
        error: 'Нет активного подключённого профиля браузера.', errorCode: 'browser', updatedAt: Date.now(),
      }
    }
    const task: ActiveTask = { taskId, batchId, model, connectorId: connector.instanceId, connectorGeneration: connector.generation, status: 'opening' }
    this.taskRegistry.register(task)
    this.running.add(model)
    this.progressModels.add(model)
    this.emitTaskStatus(task, 'opening')

    try {
      const data = await this.sendCommand(
        'send',
        {
          taskId,
          batchId,
          model,
          prompt,
          timeoutMs: RESPONSE_TIMEOUT_MS,
          purpose: 'answer',
        },
        RESPONSE_TIMEOUT_MS + COMMAND_GRACE_MS,
        task.connectorId,
        task.connectorGeneration,
      )
      if (!data || typeof data !== 'object' || (data as Record<string, unknown>).taskId !== taskId) {
        throw new BridgeError('unknown', `${MODEL_LABELS[model]}: ответ расширения не совпадает с идентификатором задачи.`)
      }
      const text =
        data && typeof data === 'object' && typeof (data as Record<string, unknown>).text === 'string'
          ? ((data as Record<string, unknown>).text as string).trim()
          : ''
      if (!text) {
        throw new BridgeError('site', `${MODEL_LABELS[model]}: сервис вернул пустой ответ.`)
      }

      const result: ModelResult = {
        model,
        taskId,
        batchId,
        status: 'done',
        text,
        updatedAt: Date.now(),
      }
      const finalized = this.taskRegistry.finish(taskId, result)
      if (finalized) {
        this.emit({ type: 'model', result: finalized })
        return finalized
      }
      if (task.cancelPromise) await task.cancelPromise
      if (task.result) return task.result
      const recovered = this.taskRegistry.finish(taskId, result)
      if (recovered) {
        this.emit({ type: 'model', result: recovered })
        return recovered
      }
      return task.result ?? result
    } catch (error) {
      const result: ModelResult = { ...this.errorResult(model, error), taskId, batchId }
      const finalized = this.taskRegistry.finish(taskId, result)
      if (finalized) {
        this.emit({ type: 'model', result: finalized })
        return finalized
      }
      if (task.cancelPromise) await task.cancelPromise
      if (task.result) return task.result
      const recovered = this.taskRegistry.finish(taskId, result)
      if (recovered) {
        this.emit({ type: 'model', result: recovered })
        return recovered
      }
      return task.result ?? result
    } finally {
      this.running.delete(model)
      this.progressModels.delete(model)
      this.taskRegistry.remove(taskId)
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
      const taskId = randomUUID()
      const data = await this.sendCommand(
        'send',
        {
          taskId,
          model: request.model,
          prompt: synthesisPrompt,
          timeoutMs: SYNTHESIS_TIMEOUT_MS,
          purpose: 'synthesis',
        },
        SYNTHESIS_TIMEOUT_MS + COMMAND_GRACE_MS,
      )
      if (!data || typeof data !== 'object' || (data as Record<string, unknown>).taskId !== taskId) {
        throw new BridgeError('unknown', `${MODEL_LABELS[request.model]}: ответ синтеза не совпадает с идентификатором задачи.`)
      }
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
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer)
    this.handshakeTimers.clear()
    this.authenticatedVersions.clear()
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    const shutdownResults = this.taskRegistry.cancelAll((task) => ({
      model: task.model,
      taskId: task.taskId,
      batchId: task.batchId,
      status: 'cancelled',
      error: 'Приложение закрывается; удалённое подтверждение отмены не получено.',
      updatedAt: Date.now(),
    }))
    for (const result of shutdownResults) this.emit({ type: 'model', result })
    this.rejectPending(new BridgeError('browser', 'Приложение закрывается.'))
    this.authenticated = false
    this.socket = null
    this.clientInfo = null
    this.clientHeartbeatAt = 0
    this.connectors.clear()
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
    this.started = false
    this.port = 0
    this.info = { status: 'stopped', browserName: 'Zen Browser' }
  }
}
