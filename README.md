# Multi-AI Aggregator

Локальное Electron-приложение для работы с ChatGPT, Qwen и DeepSeek через браузер пользователя и Zen Bridge.

## Быстрый старт

Требования: Windows, Node.js 22 и npm.

```powershell
npm ci
npm run dev
```

Проверки и сборки:

```powershell
npm run typecheck       # проверка TypeScript
npm run test:security   # сборка и весь автоматизированный набор тестов
npm run build:extension # собрать и проверить XPI для Zen
npm run release:metadata # сгенерировать update manifest и версию расширения
npm run pack            # распакованный Electron-пакет для локальной проверки
npm run dist            # Windows NSIS installer
npm run clean           # удалить только локальные build outputs
```

## Куда смотреть

| Что нужно найти | Где находится |
|---|---|
| Исходный код приложения | `src/` |
| Electron preload / IPC boundary | `preload/`, `src/main/ipc.ts` |
| Zen WebExtension | `zen-extension/` |
| Автоматизированные тесты | `scripts/*.test.mjs` |
| Сборочные и диагностические скрипты | `scripts/` |
| Архитектура и технические решения | `docs/` |
| Исторические аудиты и расследования | `docs/archive/` |
| Локальные сборки и диагностические артефакты | `artifacts/` (не коммитится) |
| Подготовленные файлы GitHub Release | `release/` (временная staging-папка) |
| Изолированные browser probe profiles | `probe/`, `.probe-profile/` (не удалять при обычной очистке) |

## Релизы

Официальные установщик и подписанное расширение публикуются через GitHub Actions при push тега `v*`.
Скачивать актуальные файлы следует со страницы [GitHub Releases](https://github.com/Ten-Dark/Multi-Ai-Aggregator/releases/latest).

`artifacts/build/` — локальные результаты сборки. `release/` — только staging-папка для файлов, которые workflow прикладывает к GitHub Release. Для генерации метаданных обновления расширения используйте `npm run release:metadata`. Не храните в этих каталогах исходники, отчёты или ручные заметки.

## Архитектура и ограничения

Текущий runtime — Electron Main + Renderer + preload + browser process discovery + Zen-specific Manifest V2 extension + loopback WebSocket bridge. Bridge уже поддерживает несколько Zen profile connectors и маршрутизацию по провайдерам; browser-neutral connector abstraction и расширения для других браузерных семейств ещё не реализованы. Целевое направление описано в [Browser Integration Architecture](docs/BROWSER_INTEGRATION_ARCHITECTURE.md) и ADR 0001.

Полный индекс технической документации: [docs/README.md](docs/README.md). Настройки публикации и Mozilla signing: [Release setup](.github/RELEASE_SETUP.md).

Перед изменением browser integration, task lifecycle или cancellation обязательно изучите соответствующие документы в `docs/`. Диагностические сценарии, способные отправлять запросы в реальные AI-сессии, запускайте только осознанно.
