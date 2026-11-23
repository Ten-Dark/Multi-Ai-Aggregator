# Project structure

This document describes the current repository layout. It distinguishes implemented runtime code from the approved target architecture.

## Source of truth

| Path | Responsibility |
|---|---|
| `src/main/` | Electron Main process: IPC, browser discovery, update checks, Zen bridge and task coordination |
| `src/renderer/` | React renderer and UI state/presentation |
| `src/shared/` | Contracts and data types shared between Main and Renderer |
| `preload/` | Narrow contextBridge API exposed to the renderer |
| `zen-extension/` | Browser extension source: background worker, content scripts, popup and manifest |
| `scripts/*.test.mjs` | Node test-runner suites, including security and integration regressions |
| `scripts/*.mjs` | Build, packaging, smoke and explicitly invoked diagnostic utilities |
| `docs/` | Current architecture, ADRs, protocols, baselines and operational documentation |
| `docs/archive/` | Historical audit and forensic material; not authoritative for current implementation |

## Generated and local-only data

| Path | Contents | Policy |
|---|---|---|
| `dist-electron/` | TypeScript and Vite output | Recreated by `npm run build`; ignored by Git |
| `artifacts/build/windows/` | Electron Builder output, installer and unpacked package | Recreated by `npm run pack` / `npm run dist`; ignored by Git |
| `artifacts/build/zen-extension/` | Versioned local XPI | Recreated by `npm run build:extension`; ignored by Git |
| `artifacts/build/signed-extension/` | Mozilla-signed XPI from CI | Generated during release workflow; ignored by Git |
| `artifacts/diagnostics/` | Local screenshots, logs and forensic working files | Local-only; never commit without reviewing for credentials and personal data |
| `release/` | Final release staging files only | Created by `npm run release:metadata` and the release workflow; ignored by Git |
| `probe/` and `.probe-profile/` | Browser test profile / probe state | Preserve unless a dedicated cleanup explicitly verifies that the profile is disposable |

## Build lifecycle

1. `npm run build` recreates `dist-electron/`.
2. `npm run dist` creates the Windows installer under `artifacts/build/windows/`.
3. `npm run build:extension` creates the versioned XPI under `artifacts/build/zen-extension/`.
4. GitHub Actions signs the extension through AMO and stages the installer, signed XPI, update manifest, version marker and SHA-256 file under `release/`.
5. The workflow publishes only the explicitly listed release assets. Intermediate build directories are not release assets.

## Architecture status

The implemented runtime remains Zen-specific. `docs/BROWSER_INTEGRATION_ARCHITECTURE.md` and `docs/adr/0001-user-browser-first-integration.md` define the accepted browser-neutral target. Do not treat planned browser families, multi-connector routing or self-healing as implemented until code and tests demonstrate them. Preserve Main-owned task lifecycle and the cancellation contract during future migrations.
