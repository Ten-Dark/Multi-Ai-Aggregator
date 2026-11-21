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

## Browser tab safety

- Session inspection on application startup is read-only: it checks only previously registered service tabs and does not create windows or tabs.
- Managed service windows and tabs are created only after an explicit user action (`Open tabs in Zen`) or when the user submits a request that requires them.
- The extension must never call `browser.tabs.remove()` or `browser.windows.remove()`. It must not close, replace, reorganize, or unpin tabs belonging to the user's normal Zen workspace.
- The managed service window may contain its own blank initial tab in addition to the three provider tabs. This is intentional; preserving user data takes priority over removing an extra blank tab.
- Regression coverage asserts that destructive tab/window removal APIs are absent and that session checks do not call the tab-creation path.
