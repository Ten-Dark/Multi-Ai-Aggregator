# Security notes

## Zen extension pairing

The local WebSocket bridge accepts only a canonical `moz-extension://` origin. On the first successful token-authenticated connection, it stores that exact origin in Electron's application data directory as `zen-bridge-origin`. Later connections from a different extension origin are rejected, even if they present the pairing token.

This binds the pairing to one installed Zen extension identity/profile. Reinstalling the extension into a different browser profile can change its origin and require pairing reset.

### Reset pairing

1. Fully close Multi-AI Aggregator.
2. Open the application's user-data directory (the path returned by Electron's `app.getPath('userData')`; on Windows it is normally under `%APPDATA%\Multi-AI Aggregator`).
3. Delete only `zen-bridge-token` and `zen-bridge-origin`.
4. Start the application. It generates a new pairing token.
5. Copy the new pairing code from the application and enter it in the Zen extension popup.

Do not share the pairing code. It contains the local bridge authentication token.

## Renderer Content Security Policy

The renderer HTML declares a restrictive Content Security Policy. The only additional WebSocket destination allowed for development is Vite's local HMR endpoint; the app's own bridge remains bound to loopback.
