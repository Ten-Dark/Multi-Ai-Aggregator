import { MODEL_IDS, type ModelId, type TaskErrorCode } from '../../shared/types.js'

export type ProgressPhase = 'opening' | 'sending' | 'waiting'

export interface ZenAuthMessage {
  type: 'auth'
  token: string
  extensionVersion?: string
}

export interface ZenProgressMessage {
  type: 'progress'
  model: ModelId
  phase: ProgressPhase
  purpose?: 'answer' | 'synthesis'
}

export type ZenResponseMessage =
  | {
      type: 'response'
      id: string
      ok: true
      data: Record<string, unknown> | unknown[]
    }
  | {
      type: 'response'
      id: string
      ok: false
      error: {
        code?: TaskErrorCode
        message: string
        partial?: string
      }
    }

export type ZenClientMessage =
  | ZenAuthMessage
  | { type: 'ping' | 'pong' }
  | ZenProgressMessage
  | ZenResponseMessage

const TASK_ERROR_CODES: TaskErrorCode[] = [
  'login',
  'manual',
  'blocked',
  'timeout',
  'busy',
  'browser',
  'site',
  'unknown',
]

const PROGRESS_PHASES: ProgressPhase[] = ['opening', 'sending', 'waiting']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isZenAuthMessage(value: Record<string, unknown>): value is Record<string, unknown> & ZenAuthMessage {
  return (
    value.type === 'auth' &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    value.token.length <= 512 &&
    (value.extensionVersion === undefined ||
      (typeof value.extensionVersion === 'string' && value.extensionVersion.length <= 64))
  )
}

export function isZenProgressMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ZenProgressMessage {
  return (
    value.type === 'progress' &&
    MODEL_IDS.includes(value.model as ModelId) &&
    typeof value.phase === 'string' &&
    PROGRESS_PHASES.includes(value.phase as ProgressPhase) &&
    (value.purpose === undefined || value.purpose === 'answer' || value.purpose === 'synthesis')
  )
}

export function isZenResponseMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ZenResponseMessage {
  if (value.type !== 'response' || typeof value.id !== 'string' || !value.id || value.id.length > 128) {
    return false
  }

  if (value.ok === true) {
    return isRecord(value.data) || Array.isArray(value.data)
  }

  if (value.ok !== false || !isRecord(value.error)) return false
  const { code, message, partial } = value.error
  return (
    typeof message === 'string' &&
    message.length <= 4000 &&
    (code === undefined || (typeof code === 'string' && TASK_ERROR_CODES.includes(code as TaskErrorCode))) &&
    (partial === undefined || (typeof partial === 'string' && partial.length <= 300_000))
  )
}
