import { MODEL_IDS, MODEL_LABELS, type ModelId } from '../shared/types'
import { useAggregatorController } from './use-aggregator-controller'

export function App() {
  const {
    prompt, setPrompt, lastSubmittedPrompt, results, sessions, browser, zenConnection,
    zenConnected, sending, checkingSessions, synthesizing, synthModel, setSynthModel,
    synthText, synthError, globalError, copiedKey, busy, refreshSessions,
    openBrowser, focusModel, handleSubmit, retryModel, handleSynthesize,
    copyText, clearPrompt, browserLabel, sessionHint, doneCount,
    SESSION_TONE, SESSION_LABELS, TASK_TONE, TASK_LABELS, IN_PROGRESS,
  } = useAggregatorController()

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
