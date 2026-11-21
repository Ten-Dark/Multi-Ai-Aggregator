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
import { EventSnapshotTracker, type SnapshotKey } from '../shared/event-snapshot'

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

export function useAggregatorController() {
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
  const snapshotTracker = useRef(new EventSnapshotTracker()).current

  const zenConnected = Boolean(zenConnection?.connected)
  const taskInProgress = useMemo(
    () => MODEL_IDS.some((model) => IN_PROGRESS.includes(results[model].status)),
    [results],
  )
  const busy = sending || synthesizing || taskInProgress || checkingSessions || !zenConnected



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
    const sessionVersions = MODEL_IDS.map((model) => [
      model,
      snapshotTracker.capture(('session:' + model) as SnapshotKey),
    ] as const)
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
        for (const session of list) {
          const capturedVersion = sessionVersions.find(([model]) => model === session.model)?.[1]
          if (
            capturedVersion !== undefined &&
            snapshotTracker.isCurrent(('session:' + session.model) as SnapshotKey, capturedVersion)
          ) {
            next[session.model] = session
          }
        }
        return next
      })
    } catch (error) {
      const message = cleanError(error)
      setGlobalError(message)
      setSessions((current) => {
        const next = { ...current }
        for (const model of MODEL_IDS) {
          const capturedVersion = sessionVersions.find(([candidate]) => candidate === model)?.[1]
          if (
            capturedVersion !== undefined &&
            snapshotTracker.isCurrent(('session:' + model) as SnapshotKey, capturedVersion)
          ) {
            next[model] = { model, status: 'error', message }
          }
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
        snapshotTracker.markEvent('browser')
        setBrowser(event.browser)
      }
      if (event.type === 'zen-connection') {
        snapshotTracker.markEvent('zenConnection')
        setZenConnection(event.connection)
      }
      if (event.type === 'session') {
        snapshotTracker.markEvent(('session:' + event.session.model) as SnapshotKey)
        setSessions((current) => ({ ...current, [event.session.model]: event.session }))
      }
      if (event.type === 'model') {
        applyModelResult(event.result)
      }
    })

    const browserVersion = snapshotTracker.capture('browser')
    void window.aggregator
      .getBrowserInfo()
      .then((info) => {
        if (snapshotTracker.isCurrent('browser', browserVersion)) setBrowser(info)
      })
      .catch(() => {})
    const zenConnectionVersion = snapshotTracker.capture('zenConnection')
    void window.aggregator
      .getZenConnection()
      .then((connection) => {
        if (snapshotTracker.isCurrent('zenConnection', zenConnectionVersion)) {
          setZenConnection(connection)
        }
      })
      .catch(() => {})
    void refreshSessions()

    return () => {
      unsubscribe()
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [applyModelResult, refreshSessions])

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

  return {
    prompt, setPrompt, lastSubmittedPrompt, results, sessions, browser, zenConnection,
    zenConnected, sending, checkingSessions, synthesizing, synthModel, setSynthModel,
    synthText, synthError, globalError, copiedKey, busy, refreshSessions,
    openBrowser, focusModel, handleSubmit, retryModel, handleSynthesize,
    copyText, clearPrompt, browserLabel, sessionHint, doneCount,
    SESSION_TONE, SESSION_LABELS, TASK_TONE, TASK_LABELS, IN_PROGRESS,
  }
}
