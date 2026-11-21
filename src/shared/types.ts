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
  | { type: 'zen-connection'; connection: ZenConnectionInfo }

export interface AggregatorApi {
  getBrowserInfo: () => Promise<BrowserInfo>
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
  onEvent: (callback: (event: AggregatorEvent) => void) => () => void
}
