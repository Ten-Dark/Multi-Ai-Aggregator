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
