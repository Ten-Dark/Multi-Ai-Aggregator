import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MODEL_IDS,
  MODEL_LABELS,
  type BrowserInfo,
  type ModelId,
  type ModelResult,
  type SessionInfo,
  type SessionStatus,
  type TaskStatus,
  type ZenConnectionInfo,
} from '../shared/types'

const TASK_LABELS: Record<TaskStatus, string> = {
  idle: 'Ожидает запроса',
  queued: 'В очереди',
  opening: 'Открываю сайт',
  sending: 'Отправляю запрос',
  waiting: 'Ожидаю ответ',
  done: 'Готово',
  error: 'Ошибка',
}

const SESSION_LABELS: Record<SessionStatus, string> = {
  unknown: 'Не проверено',
  checking: 'Проверка…',
  'logged-in': 'Вход выполнен',
  guest: 'Гость',
  'login-required': 'Нужен вход',
  'manual-action': 'Нужно действие',
  blocked: 'Проверка безопасности',
  error: 'Ошибка',
}

const SESSION_TONE: Record<SessionStatus, string> = {
  unknown: 'neutral',
  checking: 'neutral',
  'logged-in': 'ok',
  guest: 'warn',
  'login-required': 'bad',
  'manual-action': 'warn',
  blocked: 'bad',
  error: 'bad',
}

const TASK_TONE: Record<TaskStatus, string> = {
  idle: 'neutral',
  queued: 'warn',
  opening: 'warn',
  sending: 'warn',
  waiting: 'warn',
  done: 'ok',
  error: 'bad',
}

const IN_PROGRESS: TaskStatus[] = ['queued', 'opening', 'sending', 'waiting']

function createEmptyResults(): Record<ModelId, ModelResult> {
  return {
    chatgpt: { model: 'chatgpt', status: 'idle', updatedAt: 0 },
    qwen: { model: 'qwen', status: 'idle', updatedAt: 0 },
    deepseek: { model: 'deepseek', status: 'idle', updatedAt: 0 },
  }
}

function createEmptySessions(): Record<ModelId, SessionInfo> {
  return {
    chatgpt: { model: 'chatgpt', status: 'unknown', message: 'Сессия ещё не проверена.' },
    qwen: { model: 'qwen', status: 'unknown', message: 'Сессия ещё не проверена.' },
    deepseek: { model: 'deepseek', status: 'unknown', message: 'Сессия ещё не проверена.' },
  }
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

export function App() {
  const [prompt, setPrompt] = useState('')
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState('')
  const [results, setResults] = useState<Record<ModelId, ModelResult>>(createEmptyResults)
  const [sessions, setSessions] = useState<Record<ModelId, SessionInfo>>(createEmptySessions)
  const [browser, setBrowser] = useState<BrowserInfo>({ status: 'stopped' })
  const [zenConnection, setZenConnection] = useState<ZenConnectionInfo | null>(null)
  const [sending, setSending] = useState(false)
  const [checkingSessions, setCheckingSessions] = useState(false)
  const [synthesizing, setSynthesizing] = useState(false)
  const [synthModel, setSynthModel] = useState<ModelId>('chatgpt')
  const [synthText, setSynthText] = useState('')
  const [synthError, setSynthError] = useState('')
  const [globalError, setGlobalError] = useState('')
  const [copiedKey, setCopiedKey] = useState('')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const zenConnected = Boolean(zenConnection?.connected)
  const taskInProgress = useMemo(
    () => MODEL_IDS.some((model) => IN_PROGRESS.includes(results[model].status)),
    [results],
  )
  const busy = sending || synthesizing || taskInProgress || checkingSessions || !zenConnected

  const refreshZenConnection = useCallback(async () => {
    try {
      setZenConnection(await window.aggregator.getZenConnection())
    } catch {
      // The bridge may not have started yet.
    }
  }, [])

  const applyModelResult = useCallback((result: ModelResult) => {
    setResults((current) => ({ ...current, [result.model]: result }))
    if (
      result.status === 'error' &&
      (result.errorCode === 'login' || result.errorCode === 'manual' || result.errorCode === 'blocked')
    ) {
      const status: SessionStatus =
        result.errorCode === 'login'
          ? 'login-required'
          : result.errorCode === 'manual'
            ? 'manual-action'
            : 'blocked'
      setSessions((current) => ({
        ...current,
        [result.model]: {
          model: result.model,
          status,
          message: result.error || SESSION_LABELS[status],
        },
      }))
    }
  }, [])

  const doneCount = MODEL_IDS.filter(
    (model) => results[model].status === 'done' && Boolean(results[model].text?.trim()),
  ).length

  const refreshSessions = useCallback(async () => {
    setCheckingSessions(true)
    setSessions((current) => {
      const next = { ...current }
      for (const model of MODEL_IDS) {
        next[model] = { ...next[model], status: 'checking', message: 'Проверка сессии…' }
      }
      return next
    })
    try {
      const list = await window.aggregator.checkSessions()
      setSessions((current) => {
        const next = { ...current }
        for (const session of list) next[session.model] = session
        return next
      })
    } catch (error) {
      const message = cleanError(error)
      setGlobalError(message)
      setSessions((current) => {
        const next = { ...current }
        for (const model of MODEL_IDS) {
          next[model] = { model, status: 'error', message }
        }
        return next
      })
    } finally {
      setCheckingSessions(false)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.aggregator.onEvent((event) => {
      if (event.type === 'browser') {
        setBrowser(event.browser)
        void refreshZenConnection()
      }
      if (event.type === 'session') {
        setSessions((current) => ({ ...current, [event.session.model]: event.session }))
      }
      if (event.type === 'model') {
        applyModelResult(event.result)
      }
    })

    void window.aggregator
      .getBrowserInfo()
      .then(setBrowser)
      .catch(() => {})
    void refreshZenConnection()
    void refreshSessions()

    return () => {
      unsubscribe()
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [applyModelResult, refreshSessions, refreshZenConnection])

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshZenConnection()
    }, 2000)
    return () => clearInterval(timer)
  }, [refreshZenConnection])

  const openBrowser = async () => {
    setGlobalError('')
    try {
      const info = await window.aggregator.launchBrowser()
      setBrowser(info)
      await refreshSessions()
    } catch (error) {
      setGlobalError(cleanError(error))
    }
  }

  const focusModel = async (model: ModelId) => {
    try {
      await window.aggregator.focusModel(model)
    } catch (error) {
      setGlobalError(cleanError(error))
    }
  }

  const handleSubmit = async () => {
    const text = prompt.trim()
    if (!text || busy) return

    const hasPreviousResults = MODEL_IDS.some(
      (model) => results[model].status === 'done' || results[model].status === 'error',
    )
    if (hasPreviousResults && text === lastSubmittedPrompt) {
      const confirmed = window.confirm(
        'Ответы на этот запрос уже получены. Отправить тот же запрос всем трём моделям ещё раз?',
      )
      if (!confirmed) return
    }

    setSending(true)
    setGlobalError('')
    setSynthText('')
    setSynthError('')
    setResults((current) => {
      const next = { ...current }
      for (const model of MODEL_IDS) {
        next[model] = { model, status: 'queued', updatedAt: Date.now() }
      }
      return next
    })
    setLastSubmittedPrompt(text)

    try {
      const finalResults = await window.aggregator.sendAll(text)
      for (const result of finalResults) applyModelResult(result)
    } catch (error) {
      const message = cleanError(error)
      setGlobalError(message)
      setResults((current) => {
        const next = { ...current }
        for (const model of MODEL_IDS) {
          if (IN_PROGRESS.includes(next[model].status) || next[model].status === 'idle') {
            next[model] = {
              model,
              status: 'error',
              error: message,
              errorCode: 'unknown',
              updatedAt: Date.now(),
            }
          }
        }
        return next
      })
    } finally {
      setSending(false)
    }
  }

  const retryModel = async (model: ModelId) => {
    const text = lastSubmittedPrompt || prompt.trim()
    if (!text || busy) return
    setGlobalError('')
    setResults((current) => ({
      ...current,
      [model]: { model, status: 'opening', updatedAt: Date.now() },
    }))
    try {
      const result = await window.aggregator.sendOne(model, text)
      applyModelResult(result)
    } catch (error) {
      setResults((current) => ({
        ...current,
        [model]: {
          model,
          status: 'error',
          error: cleanError(error),
          errorCode: 'unknown',
          updatedAt: Date.now(),
        },
      }))
    }
  }

  const handleSynthesize = async () => {
    if (busy || doneCount === 0 || !lastSubmittedPrompt) return
    setSynthesizing(true)
    setSynthError('')
    setSynthText('')

    try {
      const answers = MODEL_IDS.map((model) => {
        const result = results[model]
        return {
          model,
          text:
            result.status === 'done' || result.partial ? result.text?.trim() || undefined : undefined,
          error:
            result.error ||
            (result.status === 'done' ? undefined : result.partial ? 'ответ не завершён' : 'нет ответа'),
        }
      })
      const result = await window.aggregator.synthesize({
        model: synthModel,
        prompt: lastSubmittedPrompt,
        answers,
      })
      setSynthText(result.text)
    } catch (error) {
      setSynthError(cleanError(error))
    } finally {
      setSynthesizing(false)
    }
  }

  const copyText = async (key: string, text: string) => {
    if (!text.trim()) return
    try {
      await window.aggregator.copyText(text)
      setCopiedKey(key)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopiedKey(''), 1600)
    } catch (error) {
      setGlobalError(cleanError(error))
    }
  }

  const clearPrompt = () => setPrompt('')

  const browserLabel =
    browser.status === 'running'
      ? `Zen: подключён${zenConnection?.extensionVersion ? ` · v${zenConnection.extensionVersion}` : ''}`
      : browser.status === 'starting'
        ? 'Zen: ждёт расширение'
        : browser.status === 'error'
          ? 'Zen: ошибка моста'
          : 'Zen: мост остановлен'

  const sessionHint = MODEL_IDS.some((model) =>
    ['login-required', 'manual-action', 'blocked'].includes(sessions[model].status),
  )

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Multi-AI Aggregator</h1>
          <p className="subtitle">
            Один запрос — три независимых ответа — один итоговый синтез. Через расширение Zen,
            локально, без API.
          </p>
        </div>
        <div className="topbar-actions">
          <span className={`browser-badge ${browser.status}`}>{browserLabel}</span>
          <button className="button secondary" onClick={openBrowser} disabled={busy}>
            {browser.status === 'running' ? 'Показать вкладки в Zen' : 'Открыть вкладки в Zen'}
          </button>
          <button
            className="button secondary"
            onClick={() => void refreshSessions()}
            disabled={busy || checkingSessions}
          >
            {checkingSessions ? 'Проверяю…' : 'Проверить сессии'}
          </button>
        </div>
      </header>

      <section className="session-strip" aria-label="Состояние сессий">
        {MODEL_IDS.map((model) => {
          const session = sessions[model]
          return (
            <button
              key={model}
              type="button"
              className={`session-chip tone-${SESSION_TONE[session.status]}`}
              title={session.message}
              onClick={() => void focusModel(model)}
            >
              <span className="dot" />
              <span className="chip-model">{MODEL_LABELS[model]}</span>
              <span className="chip-state">{SESSION_LABELS[session.status]}</span>
            </button>
          )
        })}
        <span className="session-note">
          {sessionHint
            ? 'Завершите вход или проверку во вкладках Zen, затем нажмите «Проверить сессии».'
            : 'Расширение работает в текущем профиле Zen и использует твои существующие сессии.'}
        </span>
      </section>

      {globalError && (
        <div className="alert error" role="alert">
          {globalError}
        </div>
      )}

      <section className="panel pairing-panel">
          <div className="pairing-head">
            <div>
              <h2>Подключение к Zen</h2>
              <p className="hint">
                {zenConnected
                  ? 'Расширение подключено и работает с вашими текущими сессиями в Zen. Код ниже нужен только в новом профиле или если автоподключение не сработало.'
                  : 'Откройте Zen и вручную подключите расширение Multi-AI Aggregator Bridge с помощью кода ниже.'}
              </p>
            </div>
            <span className={`status-pill tone-${zenConnected ? 'ok' : 'warn'}`}>
              {zenConnected ? 'Подключено' : 'Не подключено'}
            </span>
          </div>

          <div className="pairing-code-row">
            <code className="pairing-code">
              {zenConnection?.pairingCode || 'Мост запускается…'}
            </code>
            <button
              className="button secondary"
              onClick={() => void copyText('zen-pairing', zenConnection?.pairingCode || '')}
              disabled={!zenConnection?.pairingCode}
            >
              {copiedKey === 'zen-pairing' ? 'Скопировано' : 'Скопировать код'}
            </button>
          </div>

          <details className="pairing-help">
            <summary>Как установить и подключить расширение</summary>
            <ol>
              <li>
                В Zen открой <code>about:debugging#/runtime/this-firefox</code>.
              </li>
              <li>
                Постоянная установка: <code>about:addons</code> → шестерёнка → «Установить
                дополнение из файла…» → <code>release\multi-ai-aggregator-zen.xpi</code>. Оно
                сохраняется после перезапуска Zen.
              </li>
              <li>
                Откройте меню расширения Multi-AI Aggregator Bridge, вставьте скопированный
                код подключения и нажмите «Подключить». После сохранения код будет использоваться
                автоматически при следующих запусках.
              </li>
              <li>
                При смене профиля Zen, порта или кода подключения повторите эти действия с
                актуальным кодом, который отображается в приложении.
              </li>
            </ol>
          </details>
      </section>

      <section className="panel query-panel">
        <div className="panel-header">
          <h2>Запрос</h2>
          <span className="hint">Ctrl+Enter — отправить</span>
        </div>
        <textarea
          className="query-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              void handleSubmit()
            }
          }}
          placeholder="Введите запрос. Он будет отправлен в ChatGPT, Qwen и DeepSeek одновременно."
          spellCheck
        />
        <div className="query-actions">
          <span className="char-count">{prompt.length.toLocaleString('ru-RU')} символов</span>
          <div className="button-row">
            <button className="button ghost" onClick={clearPrompt} disabled={busy || !prompt}>
              Очистить
            </button>
            <button
              className="button primary"
              onClick={() => void handleSubmit()}
              disabled={!prompt.trim() || busy}
            >
              {sending ? 'Отправляю всем…' : 'Отправить всем'}
            </button>
          </div>
        </div>
      </section>

      <section className="responses-grid" aria-label="Независимые ответы">
        {MODEL_IDS.map((model) => {
          const result = results[model]
          const session = sessions[model]
          const isWorking = IN_PROGRESS.includes(result.status)
          return (
            <article className="panel response-card" key={model}>
              <div className="response-header">
                <div>
                  <h2>{MODEL_LABELS[model]}</h2>
                  <button className="link-button" onClick={() => void focusModel(model)}>
                    Открыть вкладку
                  </button>
                </div>
                <span className={`status-pill tone-${TASK_TONE[result.status]}`}>
                  {TASK_LABELS[result.status]}
                </span>
              </div>

              <div
                className={`session-inline tone-${SESSION_TONE[session.status]}`}
                title={session.message}
              >
                {SESSION_LABELS[session.status]}
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
                  onClick={() => void copyText(`model-${model}`, result.text || '')}
                  disabled={!result.text?.trim()}
                >
                  {copiedKey === `model-${model}` ? 'Скопировано' : 'Скопировать'}
                </button>
                <button
                  className="button small ghost"
                  onClick={() => void retryModel(model)}
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
        })}
      </section>

      <section className="panel synthesis-panel">
        <div className="synthesis-head">
          <div>
            <h2>Финальный синтез</h2>
            <p className="hint">
              {doneCount > 0
                ? `Доступно ответов: ${doneCount} из 3. Синтез возможен, даже если часть моделей не ответила.`
                : 'Сначала отправьте запрос хотя бы одной модели.'}
            </p>
          </div>
          <div className="synthesis-controls">
            <label className="select-label">
              Синтезатор
              <select
                value={synthModel}
                onChange={(event) => setSynthModel(event.target.value as ModelId)}
                disabled={busy}
              >
                {MODEL_IDS.map((model) => (
                  <option key={model} value={model}>
                    {MODEL_LABELS[model]}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary"
              onClick={() => void handleSynthesize()}
              disabled={busy || doneCount === 0 || !lastSubmittedPrompt}
            >
              {synthesizing ? 'Собираю ответ…' : 'Собрать единый ответ'}
            </button>
          </div>
        </div>

        <div className="synthesis-body" aria-busy={synthesizing}>
          {synthText ? (
            <pre className="response-text final-text">{synthText}</pre>
          ) : synthError ? (
            <p className="empty-text error-text">{synthError}</p>
          ) : synthesizing ? (
            <p className="empty-text">
              {MODEL_LABELS[synthModel]} анализирует исходный запрос и доступные ответы…
            </p>
          ) : (
            <p className="empty-text">
              Итоговый ответ появится здесь. По умолчанию используется ChatGPT.
            </p>
          )}
        </div>

        <div className="card-actions">
          <button
            className="button small secondary"
            onClick={() => void copyText('synthesis', synthText)}
            disabled={!synthText.trim()}
          >
            {copiedKey === 'synthesis' ? 'Скопировано' : 'Скопировать итог'}
          </button>
        </div>
      </section>

      <footer className="footer">
        <span>
          Приложение управляет обычными вкладками сервисов в Zen через WebExtension. CAPTCHA и
          проверки безопасности не обходятся — их нужно проходить вручную.
        </span>
      </footer>
    </div>
  )
}
