export const MODEL_IDS = ['chatgpt', 'qwen', 'deepseek'] as const

export type ModelId = (typeof MODEL_IDS)[number]

export type TaskId = string

export const MODEL_LABELS: Record<ModelId, string> = {
  chatgpt: 'ChatGPT',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
}

export type SessionStatus =
  | 'unknown'
  | 'checking'
  | 'logged-in'
  | 'session-available'
  | 'guest'
  | 'login-required'
  | 'manual-action'
  | 'blocked'
  | 'error'

export interface SessionInfo {
  model: ModelId
  status: SessionStatus
  message: string
  url?: string
}

export type TaskStatus =
  | 'idle'
  | 'queued'
  | 'opening'
  | 'sending'
  | 'waiting'
  | 'cancelling'
  | 'done'
  | 'error'
  | 'cancelled'

export type TaskErrorCode =
  | 'cancelled'
  | 'login'
  | 'manual'
  | 'blocked'
  | 'submission-unknown'
  | 'timeout'
  | 'busy'
  | 'browser'
  | 'site'
  | 'unknown'

export interface ModelResult {
  model: ModelId
  taskId?: TaskId
  batchId?: TaskId
  status: TaskStatus
  text?: string
  error?: string
  errorCode?: TaskErrorCode
  partial?: boolean
  updatedAt: number
}

export interface BrowserInfo {
  status: 'stopped' | 'starting' | 'running' | 'error'
  browserName?: string
  message?: string
}

export type BrowserFamily = 'firefox' | 'chromium' | 'unknown'
export type DiscoveryConfidence = 'high' | 'medium' | 'low'

export interface BrowserProcessDescriptor {
  id: string
  instanceId?: string
  processId: number
  parentProcessId: number
  executableName: string
  executablePath?: string
  family: BrowserFamily
  product: string
  startedAt?: string
  windowTitle?: string
  hasVisibleWindow: boolean
  profilePath?: string
  profileName?: string
  profileSource: 'firefox-profile-argument' | 'firefox-profile-name-argument' | 'chromium-user-data-dir' | 'generic-profile-argument' | 'default-or-unknown'
  confidence: DiscoveryConfidence
}

export interface BrowserDiscoverySnapshot {
  platform: string
  scannedAt: number
  status: 'available' | 'unsupported' | 'error'
  processes: BrowserProcessDescriptor[]
  message: string
}

export interface SynthesisAnswer {
  model: ModelId
  text?: string
  error?: string
}

export interface SynthesisRequest {
  model: ModelId
  prompt: string
  answers: SynthesisAnswer[]
}

export interface SynthesisResult {
  model: ModelId
  text: string
}

export interface ZenConnectorInfo {
  instanceId: string
  browserName: string
  browserVersion: string
  extensionVersion: string
  connectedAt: number
  lastHeartbeatAt: number
  active: boolean
}

export interface ZenConnectionInfo {
  pairingCode: string
  wsUrl: string
  connected: boolean
  extensionVersion?: string
  extensionInstanceId?: string
  browserName?: string
  browserVersion?: string
  lastHeartbeatAt?: number
  activeConnectorId?: string
  connectors?: ZenConnectorInfo[]
}

export type AggregatorEvent =
  | { type: 'browser'; browser: BrowserInfo }
  | { type: 'session'; session: SessionInfo }
  | { type: 'model'; result: ModelResult }
  | { type: 'zen-connection'; connection: ZenConnectionInfo }

export interface AggregatorApi {
  getBrowserInfo: () => Promise<BrowserInfo>
  getBrowserDiscovery: () => Promise<BrowserDiscoverySnapshot>
  launchBrowser: () => Promise<BrowserInfo>
  checkSessions: () => Promise<SessionInfo[]>
  focusModel: (model: ModelId) => Promise<void>
  sendAll: (prompt: string) => Promise<ModelResult[]>
  sendOne: (model: ModelId, prompt: string) => Promise<ModelResult>
  cancelTask: (taskId: TaskId) => Promise<{ accepted: boolean; confirmed?: boolean; status?: string }>
  cancelBatch: (batchId: TaskId) => Promise<{ accepted: number; rejected: number }>
  synthesize: (request: SynthesisRequest) => Promise<SynthesisResult>
  copyText: (text: string) => Promise<void>
  getAppVersion: () => Promise<string>
  getZenConnection: () => Promise<ZenConnectionInfo>
  setActiveConnector: (instanceId: string) => Promise<ZenConnectionInfo>
  onEvent: (callback: (event: AggregatorEvent) => void) => () => void
}
