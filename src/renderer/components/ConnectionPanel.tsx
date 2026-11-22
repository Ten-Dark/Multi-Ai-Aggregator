interface ConnectionPanelProps {
  connected: boolean
  pairingCode?: string
  browserName?: string
  browserVersion?: string
  copied: boolean
  onCopy: (key: string, text: string) => void
}

export function ConnectionPanel({
  connected,
  pairingCode,
  browserName,
  browserVersion,
  copied,
  onCopy,
}: ConnectionPanelProps) {
  return (
    <section className="panel pairing-panel">
      <div className="pairing-head">
        <div>
          <h2>Подключение к Zen</h2>
          <p className="hint">
            {connected
              ? 'Расширение подключено и работает с вашими текущими сессиями в Zen. Код ниже нужен только в новом профиле или если автоподключение не сработало.'
              : 'Откройте Zen и вручную подключите расширение Multi-AI Aggregator Bridge с помощью кода ниже.'}
          </p>
          {connected && browserName && (
            <p className="hint">
              Активный экземпляр: {browserName}{browserVersion ? ` · ${browserVersion}` : ''}
            </p>
          )}
        </div>
        <span className={`status-pill tone-${connected ? 'ok' : 'warn'}`}>
          {connected ? 'Подключено' : 'Не подключено'}
        </span>
      </div>

      <div className="pairing-code-row">
        <code className="pairing-code">{pairingCode || 'Мост запускается…'}</code>
        <button
          className="button secondary"
          onClick={() => onCopy('zen-pairing', pairingCode || '')}
          disabled={!pairingCode}
        >
          {copied ? 'Скопировано' : 'Скопировать код'}
        </button>
      </div>

      <details className="pairing-help">
        <summary>Как установить и подключить расширение</summary>
        <ol>
          <li>В Zen открой <code>about:debugging#/runtime/this-firefox</code>.</li>
          <li>
            Постоянная установка: <code>about:addons</code> → шестерёнка → «Установить
            дополнение из файла…» → <code>release\\multi-ai-aggregator-zen.xpi</code>. Оно
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
  )
}
