# Zen Extension Packaging

## Build

From the repository root on Windows:

```powershell
npm run build:extension
```

The script reads `zen-extension/manifest.json`, packages the extension root into an XPI, extracts the archive into a temporary directory, and verifies the packaged manifest and required content scripts before publishing the artifact.

Output:

```text
release/zen-extension/multi-ai-aggregator-zen-<manifest-version>.xpi
```

The XPI contains only the extension source tree. It does not contain the integration-test `dev-pairing.json` file or any application pairing token.

## Updating the user's Zen installation

The repository build does not modify the user's browser profile. Install the generated XPI through Zen's supported extension-management flow, then open the extension popup and paste the current pairing code shown by the running Multi-AI Aggregator app.

The application now rotates the legacy bridge token into its protected `userData/zen-secure/` directory. Therefore, an extension paired with the old token will remain disconnected until it is manually paired with the new code.

## Verification boundaries

- The packaging script verifies archive contents and manifest version consistency.
- A successful XPI build does not prove that the extension connects to the app or that provider automation works.
- Do not automate changes to the user's normal Zen profile. Real-provider E2E must be performed only after the user installs the XPI and completes pairing.

## Browser connection and tab safety

- Bridge connectivity and provider readiness are separate states. A green extension connection confirms only the local WebSocket pairing; each provider is checked independently.
- Session checks discover matching ChatGPT, Qwen, and DeepSeek tabs across all Zen windows. They do not require tabs to have been created by the aggregator or to share one browser window.
- If an existing provider tab predates extension installation/update and has no content script, the extension injects its own scripts into that already-loaded matching page. It does not reload, navigate, focus, pin, or close the tab.
- Sending a prompt reuses the discovered provider tab without navigating it to the provider home page. If no matching tab exists, only the requested provider tab is created in the background.
- The explicit `Open tabs in Zen` action reuses discovered provider tabs and creates only missing provider tabs. It does not create duplicates for providers that are already open.
- The extension must never call `browser.tabs.remove()` or `browser.windows.remove()`, and must not reorganize or unpin tabs in the user's normal Zen workspace.
- If script injection is blocked, the app reports that specific provider tab and asks for a manual reload rather than silently opening another tab.
- Regression coverage asserts that destructive tab/window removal APIs are absent and that session checks do not call the tab-creation path.
