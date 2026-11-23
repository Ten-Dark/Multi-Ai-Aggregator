# Scripts

## Routine commands

- `npm run test:security` — runs the automated `*.test.mjs` suites.
- `npm run build:extension` — packages and verifies the current Zen extension into `artifacts/build/zen-extension/`.
- `npm run release:metadata` — writes the extension update manifest and version marker into `release/`.
- `npm run dist` — builds the Windows installer into `artifacts/build/windows/`.

## Manual diagnostics

Files such as `probe-*.mjs`, `e2e-send.mjs`, `integration-zen.mjs`, `_live.mjs` and `smoke*.mjs` are diagnostic utilities, not part of normal application startup. App-launching smoke scripts require `MAI_ALLOW_USER_PROFILE_SMOKE=1` because launching the app can migrate/rotate its local bridge token and require extension re-pairing. Scripts that submit real provider prompts (`e2e-send.mjs`, `integration-zen.mjs`, `_live.mjs`) additionally require `MAI_ALLOW_LIVE_PROVIDER_TESTS=1`. `integration-zen.mjs` also requires `MAI_ZEN_EXECUTABLE_PATH` pointing to an explicit Zen executable and creates a separate temporary Zen profile; the Electron app still uses its normal app-data directory. Use a test account/session when a live submission is required. Do not run these scripts while the user's active browser/app state must remain untouched.

Diagnostic output belongs under `artifacts/diagnostics/`, never in the repository root. Smoke screenshots redact the pairing code. `_live.mjs` does not save screenshots or log prompt/response text, and it will not submit a real prompt unless `MAI_ALLOW_LIVE_PROVIDER_TESTS=1` is explicitly set. Do not store pairing codes, cookies, prompts, provider responses or other credentials in logs/screenshots.
