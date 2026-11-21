# ADR 0001: User-Browser-First Integration

- **Status:** Accepted for implementation planning
- **Date:** 2026-11-21
- **Decision owners:** Multi-AI Aggregator project
- **Related:** [Browser Integration Architecture](../BROWSER_INTEGRATION_ARCHITECTURE.md), [Provider Runtime Architecture](../PROVIDER_RUNTIME_ARCHITECTURE.md)

## Context

The current application is integrated with Zen through one WebExtension and a loopback WebSocket bridge. The extension can discover tabs only in the profile where it is installed. Electron Main currently constructs a Zen-specific bridge directly, while shared browser information has no profile or connector identity.

The product requirement is to work with the browser the user is already using, regardless of its installation directory or profile path. Users may run portable browsers, custom profiles, multiple browser products, or multiple instances at once. The application must connect quickly and recover transient failures without damaging existing tabs or authentication state.

A process scan alone cannot enumerate tabs, prove extension presence, or establish provider authentication. Browser extension APIs are scoped to their own browser profile. Chromium and Firefox-family extensions also differ in manifest versions and lifecycle behavior.

## Decision

Adopt a **user-browser-first, extension-backed, multi-connector architecture**.

1. Electron Main owns a browser-neutral Browser Integration Manager.
2. OS-specific discovery adapters enumerate running browser processes and collect process metadata without assuming install paths.
3. A browser extension in each supported profile establishes a versioned, authenticated loopback connector and reports tabs/permissions/capabilities for that profile.
4. Each connector has an opaque identity and independent connection/health lifecycle. Multiple browser/profile connectors may coexist.
5. Provider automation is routed through the connector that owns the selected provider tab.
6. The existing Zen integration becomes the first Firefox-family connector and remains operational during migration.
7. Chromium-family support uses a separate Manifest V3 package and compatibility layer; the current Manifest V2 XPI is not represented as universally compatible.
8. Safe transient recovery is automatic and bounded. Permission grants, extension installation/update, provider login, and challenge handling remain user-controlled.
9. A managed app-owned browser context is an explicit fallback, never the silent default.

## Rejected alternatives

### Make app-owned Electron partitions the default

Rejected because it moves the user's authenticated sessions into a separate environment, creates a second login surface, and does not meet the requirement to connect to the browser already in use. It remains a possible explicit fallback after compatibility testing.

### Discover browsers by fixed executable/profile paths

Rejected because portable installations, custom drives, profile flags, multiple installations, and per-user layouts make fixed paths unreliable.

### Use process discovery as the source of tabs/authentication

Rejected because process metadata does not expose browser tab contents or provider session validity. Only a connector running inside a profile can report that profile's tabs, and provider UI evidence is required for authentication state.

### Attach to existing browsers through remote debugging/CDP

Rejected as a default discovery mechanism because it requires debugging endpoints/flags, can expose powerful browser control, may not be enabled on an already-running browser, and creates a large security boundary. A future narrowly scoped, explicit opt-in integration would require a separate ADR and threat model.

### Read browser profile databases or copy cookies

Rejected because it bypasses browser isolation, creates credential-handling risk, is browser-specific, and may corrupt or invalidate sessions. Cookies are not needed for connector discovery.

## Consequences

### Positive

- Supports portable and custom-path browser installations.
- Connects to the user's actual profile and already-open provider tabs.
- Separates browser process discovery from extension connectivity and provider authentication.
- Enables multiple browser products/profiles simultaneously.
- Provides a safe foundation for health monitoring and self-healing.
- Preserves existing provider automation and Main-owned task semantics during migration.

### Costs and constraints

- Every supported profile needs its connector extension installed and granted the required provider permissions.
- Browser families require separate packaging and compatibility validation.
- Multi-connector bridge protocol and task routing are more complex than a single-peer bridge.
- Process discovery is OS-specific and needs dedicated adapters/tests.
- A browser with no installed connector can be detected as a process, but cannot be controlled or inspected until the user installs/enables the connector.
- Browser updates and extension-store policies may constrain automatic updates; the application can diagnose and guide, not silently bypass those policies.

## Security requirements

- Never read or export cookie values, passwords, or browser credential stores.
- Never clear or migrate browser profile data automatically.
- Never close/reorder/navigate existing tabs as a repair action.
- Never enable remote debugging on the user's browser automatically.
- Pair and authorize each connector explicitly; validate protocol version, message schemas, origin, and task ownership.
- Bound reconnect/recovery attempts and provide a circuit breaker.
- Keep prompts, responses, cookies, passwords, and pairing tokens out of diagnostics.
- Preserve existing Windows ACL hardening for bridge credentials.

## Implementation sequence

1. Stage 0: audit and document current coupling and contracts.
2. Stage 1: process discovery contracts and Windows provider, with no browser mutation.
3. Stage 2: generic connector interface and Zen adapter extraction.
4. Stage 3: multi-connector protocol and routing.
5. Stage 4: Firefox-family and Chromium MV3 connector packages.
6. Stage 5: permission/provider readiness diagnostics.
7. Stage 6: bounded self-healing.
8. Stage 7: browser/profile compatibility matrix and production hardening.

## Rollback

Keep the existing Zen bridge and extension available behind the compatibility facade until the generic connector passes real-browser parity tests. Do not migrate user data or authentication state. If a new connector fails, disable that connector instance and leave existing browser profiles untouched.
