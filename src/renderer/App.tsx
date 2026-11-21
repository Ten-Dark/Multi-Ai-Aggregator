import { MODEL_IDS, MODEL_LABELS, type ModelId } from '../shared/types'
import { ModelResponseCard } from './components/ModelResponseCard'
import { QueryPanel } from './components/QueryPanel'
import { ConnectionPanel } from './components/ConnectionPanel'
import { BrowserDiscoveryPanel } from './components/BrowserDiscoveryPanel'
import { SynthesisPanel } from './components/SynthesisPanel'
import { useAggregatorController } from './use-aggregator-controller'

export function App() {
  const {
    prompt, setPrompt, lastSubmittedPrompt, results, sessions, browser, zenConnection,
    zenConnected, sending, checkingSessions, synthesizing, synthModel, setSynthModel,
    synthText, synthError, globalError, copiedKey, busy, refreshSessions,
    openBrowser, focusModel, handleSubmit, retryModel, cancelModel, cancelBatch, canCancelBatch, handleSynthesize,
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

      <BrowserDiscoveryPanel />

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

      <ConnectionPanel
        connected={zenConnected}
        pairingCode={zenConnection?.pairingCode}
        copied={copiedKey === 'zen-pairing'}
        onCopy={copyText}
      />

      <QueryPanel
        prompt={prompt}
        busy={busy}
        sending={sending}
        onPromptChange={setPrompt}
        onSubmit={() => void handleSubmit()}
        onClear={clearPrompt}
        canCancelBatch={canCancelBatch}
        onCancelBatch={() => void cancelBatch()}
      />

      <section className="responses-grid" aria-label="Независимые ответы">
        {MODEL_IDS.map((model) => (
          <ModelResponseCard
            key={model}
            model={model}
            result={results[model]}
            session={sessions[model]}
            busy={busy}
            lastSubmittedPrompt={lastSubmittedPrompt}
            prompt={prompt}
            copiedKey={copiedKey}
            sessionTone={SESSION_TONE}
            sessionLabels={SESSION_LABELS}
            taskTone={TASK_TONE}
            taskLabels={TASK_LABELS}
            inProgress={IN_PROGRESS}
            onFocus={focusModel}
            onCopy={copyText}
            onRetry={retryModel}
            onCancel={cancelModel}
            canCancel={Boolean(results[model].taskId && IN_PROGRESS.includes(results[model].status))}
          />
        ))}
      </section>

      <SynthesisPanel
        doneCount={doneCount}
        hasPrompt={Boolean(lastSubmittedPrompt)}
        synthModel={synthModel}
        busy={busy}
        synthesizing={synthesizing}
        synthText={synthText}
        synthError={synthError}
        copied={copiedKey === 'synthesis'}
        onModelChange={setSynthModel}
        onSynthesize={() => void handleSynthesize()}
        onCopy={copyText}
      />

      <footer className="footer">
        <span>
          Приложение управляет обычными вкладками сервисов в Zen через WebExtension. CAPTCHA и
          проверки безопасности не обходятся — их нужно проходить вручную.
        </span>
      </footer>
    </div>
  )
}
