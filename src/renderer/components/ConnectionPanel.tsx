import { MODEL_IDS, MODEL_LABELS, type ModelId, type ZenConnectorInfo } from '../../shared/types'

interface ConnectionPanelProps {
  connected: boolean
  pairingCode?: string
  browserName?: string
  browserVersion?: string
  connectors: ZenConnectorInfo[]
  activeConnectorId?: string
  providerConnectors?: Record<ModelId, string | null>
  onSelectConnector: (instanceId: string) => void
  onSelectProviderConnector: (model: ModelId, instanceId: string | null) => void
  copied: boolean
  onCopy: (key: string, text: string) => void
}

export function ConnectionPanel({
  connected,
  pairingCode,
  browserName,
  browserVersion,
  connectors,
  activeConnectorId,
  providerConnectors,
  onSelectConnector,
  onSelectProviderConnector,
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
          {connectors.length > 0 && (
            <div className="connector-list">
              <label htmlFor="active-connector">Активный профиль по умолчанию</label>
              <select
                id="active-connector"
                value={activeConnectorId ?? ''}
                onChange={(event) => onSelectConnector(event.target.value)}
              >
                {connectors.map((connector) => (
                  <option key={connector.instanceId} value={connector.instanceId}>
                    {connector.browserName} · {connector.instanceId.slice(0, 8)}
                    {connector.active ? ' (активный)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="connector-list provider-connector-list">
            <h3>Профиль для каждого провайдера</h3>
            {MODEL_IDS.map((model) => {
              const assignedId = providerConnectors?.[model] ?? null
              const assignedIsConnected = assignedId === null || connectors.some((item) => item.instanceId === assignedId)
              return (
                <div className="provider-connector-row" key={model}>
                  <label htmlFor={`provider-connector-${model}`}>{MODEL_LABELS[model]}</label>
                  <select
                    id={`provider-connector-${model}`}
                    value={assignedId ?? ''}
                    onChange={(event) => onSelectProviderConnector(model, event.target.value || null)}
                  >
                    <option value="">Автоматически · активный профиль</option>
                    {assignedId && !assignedIsConnected && (
                      <option value={assignedId} disabled>
                        Профиль недоступен · {assignedId.slice(0, 8)}
                      </option>
                    )}
                    {connectors.map((connector) => (
                      <option key={connector.instanceId} value={connector.instanceId}>
                        {connector.browserName} · {connector.instanceId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
            <p className="hint">
              Привязки сохраняются локально. Если закреплённый профиль отключится, запрос провайдера завершится ошибкой — автоматического переноса на другой профиль не будет.
            </p>
          </div>
          {connectors.length > 0 && (
            <p className="hint">Профили различаются по идентификатору расширения. Путь и имя профиля браузера пока не определяются.</p>
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
            дополнение из файла…» → выберите скачанный <code>multi-ai-aggregator-zen.xpi</code> со страницы GitHub Releases. Оно
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
