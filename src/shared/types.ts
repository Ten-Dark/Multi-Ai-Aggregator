export const MODEL_IDS = ['chatgpt', 'qwen', 'deepseek'] as const

export type ModelId = (typeof MODEL_IDS)[number]

export const MODEL_LABELS: Record<ModelId, string> = {
  chatgpt: 'ChatGPT',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
}

export type SessionStatus =
  | 'unknown'
  | 'checking'
  | 'logged-in'
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
  | 'done'
  | 'error'

export type TaskErrorCode =
  | 'login'
  | 'manual'
  | 'blocked'
  | 'timeout'
  | 'busy'
  | 'browser'
  | 'site'
  | 'unknown'

export interface ModelResult {
  model: ModelId
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

export interface ZenConnectionInfo {
  pairingCode: string
  wsUrl: string
  connected: boolean
  extensionVersion?: string
}

export type AggregatorEvent =
  | { type: 'browser'; browser: BrowserInfo }
  | { type: 'session'; session: SessionInfo }
  | { type: 'model'; result: ModelResult }

export interface AggregatorApi {
  getBrowserInfo: () => Promise<BrowserInfo>
  launchBrowser: () => Promise<BrowserInfo>
  checkSessions: () => Promise<SessionInfo[]>
  focusModel: (model: ModelId) => Promise<void>
  sendAll: (prompt: string) => Promise<ModelResult[]>
  sendOne: (model: ModelId, prompt: string) => Promise<ModelResult>
  synthesize: (request: SynthesisRequest) => Promise<SynthesisResult>
  copyText: (text: string) => Promise<void>
  getAppVersion: () => Promise<string>
  getZenConnection: () => Promise<ZenConnectionInfo>
  onEvent: (callback: (event: AggregatorEvent) => void) => () => void
}
