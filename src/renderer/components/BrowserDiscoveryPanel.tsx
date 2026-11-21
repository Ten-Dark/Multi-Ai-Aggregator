import { useCallback, useEffect, useState } from 'react'
import type { BrowserDiscoverySnapshot } from '../../shared/types'

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value)
}

export function BrowserDiscoveryPanel() {
  const [snapshot, setSnapshot] = useState<BrowserDiscoverySnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await window.aggregator.getBrowserDiscovery())
    } catch (error) {
      setSnapshot({
        platform: 'unknown',
        scannedAt: Date.now(),
        status: 'error',
        processes: [],
        message: error instanceof Error ? error.message : 'Не удалось выполнить обнаружение.',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <section className="discovery-panel" aria-label="Обнаружение браузеров">
      <div className="discovery-heading">
        <div>
          <h2>Обнаружение браузеров</h2>
          <p>
            Поиск запущенных процессов и параметров профиля. Сам по себе процесс не означает,
            что расширение подключено или аккаунт авторизован.
          </p>
        </div>
        <button className="button secondary" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Сканирую…' : 'Обновить'}
        </button>
      </div>

      {snapshot ? (
        <>
          <div className={`discovery-status ${snapshot.status}`}>
            <span>{snapshot.message}</span>
            <small>Проверено в {formatTimestamp(snapshot.scannedAt)}</small>
          </div>
          {snapshot.processes.length > 0 ? (
            <div className="discovery-list">
              {snapshot.processes.map((process) => (
                <article className="discovery-item" key={process.id}>
                  <div className="discovery-item-main">
                    <strong>{process.product}</strong>
                    <span>{process.executableName} · PID {process.processId}{process.hasVisibleWindow ? ' · Есть окно' : ''}</span>
                  </div>
                  <div className="discovery-item-details">
                    <span>{process.profilePath ? `Профиль: ${process.profilePath}` : process.profileName ? `Имя профиля: ${process.profileName}` : 'Путь профиля не передан в параметрах запуска'}</span>
                    <span>{process.windowTitle ? `Окно: ${process.windowTitle}` : 'Видимое окно не обнаружено'} · Семейство: {process.family} · Достоверность: {process.confidence}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="discovery-status">Ожидание первого сканирования…</div>
      )}
    </section>
  )
}
