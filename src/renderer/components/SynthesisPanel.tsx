import { MODEL_IDS, MODEL_LABELS, type ModelId } from '../../shared/types'

interface SynthesisPanelProps {
  doneCount: number
  hasPrompt: boolean
  synthModel: ModelId
  busy: boolean
  synthesizing: boolean
  synthText: string
  synthError: string
  copied: boolean
  onModelChange: (model: ModelId) => void
  onSynthesize: () => void
  onCopy: (key: string, text: string) => void
}

export function SynthesisPanel({
  doneCount,
  hasPrompt,
  synthModel,
  busy,
  synthesizing,
  synthText,
  synthError,
  copied,
  onModelChange,
  onSynthesize,
  onCopy,
}: SynthesisPanelProps) {
  return (
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
              onChange={(event) => onModelChange(event.target.value as ModelId)}
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
            onClick={onSynthesize}
            disabled={busy || doneCount === 0 || !hasPrompt}
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
          onClick={() => onCopy('synthesis', synthText)}
          disabled={!synthText.trim()}
        >
          {copied ? 'Скопировано' : 'Скопировать итог'}
        </button>
      </div>
    </section>
  )
}
