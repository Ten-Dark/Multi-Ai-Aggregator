# Release setup

The Windows release workflow publishes the Electron installer and a Mozilla-signed
Zen extension. The extension is signed through AMO for **unlisted self-distribution**;
it is not published as a public AMO listing.

## One-time Mozilla setup

1. Sign in to the Mozilla Add-ons Developer Hub.
2. Open the API credentials page and create personal API credentials.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
4. Add these repository secrets:

   - `AMO_API_KEY` — the AMO JWT issuer / API key.
   - `AMO_API_SECRET` — the AMO JWT secret.

Do not commit these values, put them in repository variables, or paste them into
issues, pull requests, or chat. The workflow exposes them only to the signing step.

## Release behavior

The release workflow:

1. Runs the project test suite and builds the Windows installer.
2. Builds and lints the Zen extension as a self-distributed package.
3. Generates the Firefox-compatible update manifest.
4. Submits the extension to AMO with `web-ext sign --channel=unlisted`.
5. Verifies that the returned XPI contains Mozilla signature metadata.
6. Publishes only that signed XPI as `multi-ai-aggregator-zen.xpi`.

The signing step intentionally fails closed when either secret is missing or Mozilla
does not return a signed package. It must never fall back to publishing the unsigned
build artifact.

## Extension data disclosure

The extension reads provider-page content to submit prompts and retrieve responses,
uses provider tab URLs for session identification, and passes conversation content
to the local Multi-AI Aggregator app. The manifest declares the corresponding
Firefox data-collection categories: `personalCommunications`, `websiteContent`,
and `browsingActivity`.

The declared minimum Gecko version is 142.0 so the extension uses Firefox's built-in
data-collection consent support on desktop and Android.
