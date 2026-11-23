# Scripts

## Routine commands

- `npm run test:security` — runs the automated `*.test.mjs` suites.
- `npm run build:extension` — packages and verifies the current Zen extension into `artifacts/build/zen-extension/`.
- `npm run release:metadata` — writes the extension update manifest and version marker into `release/`.
- `npm run dist` — builds the Windows installer into `artifacts/build/windows/`.

## Manual diagnostics

Files such as `probe-*.mjs`, `e2e-send.mjs`, `integration-zen.mjs`, `_live.mjs` and `smoke*.mjs` are diagnostic utilities, not part of the normal application startup. The app-launching smoke scripts refuse to start against the normal user profile unless `MAI_ALLOW_USER_PROFILE_SMOKE=1` is explicitly set. `_live.mjs` additionally refuses to submit a real provider prompt unless `MAI_ALLOW_LIVE_PROVIDER_TESTS=1` is set. Read the script before running it and use a test account/session when a live submission is required.

Diagnostic output belongs under `artifacts/diagnostics/`, never in the repository root. Smoke screenshots redact the pairing code. `_live.mjs` does not save screenshots or log prompt/response text, and it will not submit a real prompt unless `MAI_ALLOW_LIVE_PROVIDER_TESTS=1` is explicitly set. Do not store pairing codes, cookies, prompts, provider responses or other credentials in logs/screenshots.
