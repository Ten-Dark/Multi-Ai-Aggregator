import {
  MODEL_LABELS,
  type ModelId,
  type ModelResult,
  type SessionInfo,
  type SessionStatus,
  type TaskStatus,
} from '../../shared/types'

interface ModelResponseCardProps {
  model: ModelId
  result: ModelResult
  session: SessionInfo
  busy: boolean
  lastSubmittedPrompt: string
  prompt: string
  copiedKey: string
  sessionTone: Record<SessionStatus, string>
  sessionLabels: Record<SessionStatus, string>
  taskTone: Record<TaskStatus, string>
  taskLabels: Record<TaskStatus, string>
  inProgress: TaskStatus[]
  onFocus: (model: ModelId) => void
  onCopy: (key: string, text: string) => void
  onRetry: (model: ModelId) => void
}

export function ModelResponseCard({
  model,
  result,
  session,
  busy,
  lastSubmittedPrompt,
  prompt,
  copiedKey,
  sessionTone,
  sessionLabels,
  taskTone,
  taskLabels,
  inProgress,
  onFocus,
  onCopy,
  onRetry,
}: ModelResponseCardProps) {
  const isWorking = inProgress.includes(result.status)

  return (
    <article className="panel response-card">
      <div className="response-header">
        <div>
          <h2>{MODEL_LABELS[model]}</h2>
          <button className="link-button" onClick={() => onFocus(model)}>
            Открыть вкладку
          </button>
        </div>
        <span className={`status-pill tone-${taskTone[result.status]}`}>
          {taskLabels[result.status]}
        </span>
      </div>

      <div
        className={`session-inline tone-${sessionTone[session.status]}`}
        title={session.message}
      >
        {sessionLabels[session.status]}
      </div>

      <div className="response-body" aria-busy={isWorking}>
        {result.text ? (
          <>
            {result.status === 'error' && result.partial && (
              <p className="partial-note">Неполный ответ — запрос не был завершён.</p>
            )}
            <pre className="response-text">{result.text}</pre>
          </>
        ) : result.error ? (
          <p className="empty-text error-text">{result.error}</p>
        ) : isWorking ? (
          <p className="empty-text">
            {result.status === 'queued'
              ? 'Запрос поставлен в очередь.'
              : result.status === 'opening'
                ? 'Открываю новый чат в сервисе.'
                : result.status === 'sending'
                  ? 'Отправляю запрос в сервис.'
                  : 'Модель формирует ответ…'}
          </p>
        ) : result.status === 'done' ? (
          <p className="empty-text">Пустой ответ.</p>
        ) : (
          <p className="empty-text">Ответ появится после отправки запроса.</p>
        )}
      </div>

      {result.error && result.text && (
        <div className="inline-error">{result.error}</div>
      )}

      <div className="card-actions">
        <button
          className="button small secondary"
          onClick={() => onCopy(`model-${model}`, result.text || '')}
          disabled={!result.text?.trim()}
        >
          {copiedKey === `model-${model}` ? 'Скопировано' : 'Скопировать'}
        </button>
        <button
          className="button small ghost"
          onClick={() => onRetry(model)}
          disabled={busy || !(lastSubmittedPrompt || prompt.trim())}
          title={
            lastSubmittedPrompt
              ? 'Повторить последний отправленный запрос'
              : 'Сначала отправьте запрос'
          }
        >
          Повторить
        </button>
      </div>
    </article>
  )
}
