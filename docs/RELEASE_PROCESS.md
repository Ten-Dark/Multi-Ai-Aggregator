# Release process

## Local build

```powershell
npm ci
npm run typecheck
npm run test:security
npm run dist
npm run build:extension
```

After `npm run dist`, the current Windows installer is copied to the project root:

- **Convenient local installer:** `Multi-AI-Aggregator-Setup-<version>.exe` (project root)
- Original installer and unpacked Electron package: `artifacts/build/windows/`
- Local unsigned Zen XPI: `artifacts/build/zen-extension/`

The root-level installer is a generated local artifact and is ignored by Git. Each successful `npm run dist` replaces an older root-level installer with the newly built version.

## Continuous integration

`.github/workflows/ci.yml` runs on every branch push and pull request. It installs the locked dependencies, runs TypeScript typecheck, executes the full automated test suite, and builds the Zen extension. The tag-triggered release workflow remains responsible for packaging and publishing release assets.

## Official release

Push a version tag (`v*`) to start `.github/workflows/release.yml`. The workflow runs tests, builds the installer and extension, lints the extension, creates update metadata, obtains a Mozilla AMO unlisted signature, verifies the signature metadata, and stages the final files in `release/`.

The release staging directory contains only the files uploaded to GitHub Releases:

- `Multi-AI-Aggregator-Setup-<version>.exe`
- matching `.sha256` file
- `multi-ai-aggregator-zen.xpi` (Mozilla-signed)
- `updates.json`
- `zen-extension-version.txt`

Never publish the local unsigned XPI as the self-distributed update package. Signing credentials belong only in GitHub Actions secrets (`AMO_API_KEY`, `AMO_API_SECRET`).

## Cleanup rules

- `npm run clean` removes `dist-electron/` and `artifacts/build/` only.
- It deliberately does not remove `artifacts/diagnostics/`, `probe/`, browser profiles, or `release/`.
- Review and clean those local-only directories separately; do not delete evidence or user browser data as part of a routine build.
- The authoritative published artifacts are on the [GitHub Releases page](https://github.com/Ten-Dark/Multi-Ai-Aggregator/releases/latest), not old files left by previous local builds.
