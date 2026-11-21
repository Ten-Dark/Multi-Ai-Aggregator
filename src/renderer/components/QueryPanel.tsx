interface QueryPanelProps {
  prompt: string
  busy: boolean
  sending: boolean
  onPromptChange: (value: string) => void
  onSubmit: () => void
  onClear: () => void
  canCancelBatch: boolean
  onCancelBatch: () => void
}

export function QueryPanel({
  prompt,
  busy,
  sending,
  onPromptChange,
  onSubmit,
  onClear,
  canCancelBatch,
  onCancelBatch,
}: QueryPanelProps) {
  return (
    <section className="panel query-panel">
      <div className="panel-header">
        <h2>Запрос</h2>
        <span className="hint">Ctrl+Enter — отправить</span>
      </div>
      <textarea
        className="query-input"
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            onSubmit()
          }
        }}
        placeholder="Введите запрос. Он будет отправлен в ChatGPT, Qwen и DeepSeek одновременно."
        spellCheck
      />
      <div className="query-actions">
        <span className="char-count">{prompt.length.toLocaleString('ru-RU')} символов</span>
        <div className="button-row">
          <button className="button ghost" onClick={onClear} disabled={busy || !prompt}>
            Очистить
          </button>
          <button
            className="button primary"
            onClick={onSubmit}
            disabled={!prompt.trim() || busy}
          >
            {sending ? 'Отправляю всем…' : 'Отправить всем'}
          </button>
          {canCancelBatch && (
            <button className="button secondary" onClick={onCancelBatch}>
              Отменить все
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
