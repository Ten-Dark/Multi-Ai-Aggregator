import { useCallback, useEffect, useState } from 'react'

export function AppUpdatePanel() {
  const [message, setMessage] = useState('Проверяю наличие обновлений…')
  const [currentVersion, setCurrentVersion] = useState('')
  const [latestVersion, setLatestVersion] = useState<string | undefined>()
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const checkForUpdates = useCallback(async () => {
    setChecking(true)
    try {
      const result = await window.aggregator.checkAppUpdate()
      setCurrentVersion(result.currentVersion)
      setLatestVersion(result.latestVersion)
      setUpdateAvailable(result.updateAvailable)
      setMessage(result.message)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось проверить обновления.')
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void checkForUpdates()
  }, [checkForUpdates])

  const downloadUpdate = async () => {
    setDownloading(true)
    setMessage('Скачиваю установщик и проверяю его целостность…')
    try {
      const result = await window.aggregator.downloadAppUpdate()
      setMessage(result.message)
      if (result.success) setUpdateAvailable(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить обновление.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <section className="update-panel" aria-label="Обновления приложения">
      <div className="update-panel-copy">
        <div className="update-panel-title">
          <strong>Обновления</strong>
          {currentVersion && <span className="update-version">Текущая версия: {currentVersion}</span>}
          {latestVersion && <span className="update-version">Новая версия: {latestVersion}</span>}
        </div>
        <p role="status">{message}</p>
      </div>
      <div className="update-panel-actions">
        {updateAvailable && (
          <button className="button primary" type="button" onClick={() => void downloadUpdate()} disabled={downloading || checking}>
            {downloading ? 'Загружаю…' : 'Скачать и установить'}
          </button>
        )}
        <button className="button secondary" type="button" onClick={() => void checkForUpdates()} disabled={checking || downloading}>
          {checking ? 'Проверяю…' : 'Проверить обновления'}
        </button>
      </div>
    </section>
  )
}