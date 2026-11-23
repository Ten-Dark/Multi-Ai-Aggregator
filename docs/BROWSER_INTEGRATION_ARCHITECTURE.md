# Browser Integration Architecture

**Status:** Accepted target architecture; implementation is partial and must be assessed against the current source and tests.
**Supersedes:** The app-owned-session-first direction in `PROVIDER_RUNTIME_ARCHITECTURE.md`. That document remains useful for provider automation and session-isolation requirements, but its browser-host and session-ownership assumptions are no longer the primary product direction.
**Current implementation:** Electron Main + Renderer/preload + browser process discovery + a Zen-specific WebExtension (Manifest V2) + an authenticated loopback WebSocket bridge. The bridge supports multiple extension instances/profiles and per-provider connector affinity; the browser-extension abstraction is not yet browser-neutral.
**Initial providers:** ChatGPT, Qwen, DeepSeek.
**Initial OS:** Windows; architecture must not encode Windows-only assumptions into Core.

## 1. Product requirement

Multi-AI Aggregator must connect to the browser environment the user is already using, without requiring a fixed browser installation path, a fixed profile path, or one named browser.

The default path is **attach to an existing user browser and its already-open provider tabs**. The aggregator must not silently create a replacement browser profile, migrate cookies, copy credentials, close tabs, or alter the user's browsing session.

A separately managed browser context may be offered as an explicit fallback when no supported user browser can be connected. It is not the default and must never silently replace the user's current session.

The application should recover transient integration failures autonomously where the operation is safe and reversible. It must explain and request user action only when recovery requires a permission grant, extension installation/update, provider login, CAPTCHA/challenge handling, or another action that only the user can perform.

## 2. Non-negotiable principles

1. **Browser-neutral Core.** Core consumes browser, profile, connector, tab, and provider capabilities through typed interfaces. It must not import Zen-specific APIs or assume a browser executable/profile path.
2. **Attach, do not take over.** Prefer an already-running browser/profile and reuse existing provider tabs. Never launch duplicate browser windows during discovery.
3. **Explicit identity.** A process is not a connected browser. A profile is not a connected extension. A tab is not an authenticated provider session. These are separate facts and statuses.
4. **Extension-backed access.** Existing browser tabs are discoverable to an extension only inside the profile where that extension is installed and granted host permissions. Process discovery cannot enumerate another profile's tabs or prove its login state.
5. **No profile scraping.** Do not read browser cookie databases, decrypt OS browser credentials, copy cookies, or inspect private browser storage to establish a connection. Use the extension runtime and provider UI evidence.
6. **Least privilege.** Request only the required host permissions and APIs. Explain missing permissions precisely; do not ask for broad all-sites access when provider-specific host access is sufficient.
7. **Bounded self-healing.** Recovery actions must be classified, reversible, rate-limited, observable, and verified. Never loop indefinitely.
8. **No destructive repair.** Do not clear cookies/storage, reset profiles, close/reorder tabs, uninstall extensions, or rewrite browser settings as an automatic recovery action.
9. **Privacy by design.** Do not send cookie values, passwords, page contents, prompts, or responses to discovery/health telemetry. Avoid persisting raw profile paths unless required for a user-visible diagnostic; prefer opaque stable IDs and redacted metadata.
10. **Provider controls respected.** Never bypass login, CAPTCHA, rate limits, access restrictions, or anti-abuse controls.
11. **Progressive compatibility.** Support browser families through separate connector packages/builds where manifest and API differences require it. Do not pretend one extension artifact is universally compatible.

## 3. Current baseline and confirmed constraints

- Electron Main currently constructs `ZenBridge` directly in `src/main/main.ts`; IPC types and handlers expose Zen-named bridge methods.
- Process discovery is implemented behind `BrowserDiscoveryService` and platform-specific discovery providers. It reports process/executable/profile metadata candidates; it does not prove extension connectivity, tab visibility, or provider authentication.
- `ZenConnectorRegistry` and `ZenBridge` support multiple authenticated extension instances, connector generations, heartbeats, explicit active selection, and per-provider routing. These are Zen-specific implementations, not yet the generic `BrowserConnector` contract shown in the target architecture.
- Provider-to-connector affinity and task routing are covered by deterministic tests. Live authenticated browser parity across multiple real browser families remains unverified.
- The extension is named and packaged as a Zen bridge and uses Manifest V2 in `zen-extension/manifest.json`.
- Extension background tab discovery calls `browser.tabs.query({})`. This can discover tabs only in the browser profile where that extension instance is running.
- The extension's declared host permissions cover the three provider domains and loopback bridge. They do not install the extension in another browser or grant permissions in another profile.
- Windows process discovery can identify running browser processes, executable paths, and command-line profile arguments. It cannot, by itself, enumerate tabs or prove extension connectivity/authentication.
- Chromium-family browsers and Firefox-family browsers have different extension manifest/API lifecycles. The current Manifest V2 package must not be treated as a ready-to-use Chrome/Edge connector. Chromium MV3 and Firefox/Zen packaging compatibility must be validated independently.
- Existing Main-owned task IDs, batch membership, terminal arbitration, cancellation, and synthesis behavior are valuable invariants and must be preserved during migration.

## 4. Target logical architecture

```text
Electron Renderer
  │ narrow, validated preload API
  ▼
Aggregator Core (Electron Main)
  ├─ Task Coordinator
  ├─ Browser Integration Manager
  │    ├─ Browser Discovery
  │    ├─ Profile/Instance Registry
  │    ├─ Connector Registry
  │    ├─ Connection Health Monitor
  │    └─ Recovery Orchestrator
  ├─ Provider Runtime
  │    ├─ Provider Registry
  │    ├─ Provider Session Evidence
  │    ├─ Provider Automation
  │    └─ Provider Health
  └─ Diagnostics / Redacted Event Store
         │
         ├─ BrowserConnector: Firefox-family (Zen, Firefox, compatible forks)
         ├─ BrowserConnector: Chromium-family (Chrome, Edge, Brave, etc.)
         └─ Optional ManagedBrowserConnector (explicit fallback)
                  │
                  └─ Provider adapters: ChatGPT / Qwen / DeepSeek / future providers
```

The target Core knows connector capabilities and opaque identities, not browser-specific UI details. A connector instance represents one extension runtime in one browser profile. Multiple connector instances may be connected concurrently. The current code has multi-instance transport and routing primitives, but still exposes Zen-specific types and lifecycle methods at the Main/IPC boundary; extracting the generic connector contract remains a migration task.

### 4.1 Browser Discovery

Discovery has two independent evidence sources:

**Local process discovery**
- Enumerate browser processes using OS-specific providers behind a common interface.
- Capture executable path, process ID, parent/child relationship, command-line arguments, start time, and visible-window metadata where available.
- Parse known profile arguments such as Firefox-family `-profile` and Chromium-family `--user-data-dir` / `--profile-directory`.
- Resolve browser family and probable product from executable metadata and process metadata, not from hard-coded installation directories.
- Treat inferred/default profile paths as candidates only. Do not claim an active profile unless it is tied to a running process or authenticated connector.
- Do not read cookies or browser credential stores.

**Extension connector discovery**
- Each installed extension opens an authenticated loopback connection to the aggregator.
- On connection it sends a versioned, schema-validated hello containing connector ID, browser family/product when available, extension version, supported capabilities, and an opaque profile-instance identifier.
- The aggregator correlates this connector with process candidates using browser metadata and user-approved matching when correlation is ambiguous.
- The extension reports its own tabs and provider matches. This is the authoritative source for tabs in that profile.
- Connector presence is proof of extension connectivity, not proof of provider login.

A browser process with no matching connector is shown as discovered/unconnected. A connector with no matching process metadata is still a valid connected connector, but its process association is marked unknown. Discovery must not silently select the first process when several candidates exist.

### 4.2 Profile identity

A profile is represented by a stable opaque ID scoped to a browser connector, not by a globally assumed path. The connector may provide a locally generated installation/profile identifier stored in extension storage. If the browser API cannot expose a stable profile identifier, the application uses a generated connector-instance ID and marks profile identity as approximate.

Raw filesystem paths are local diagnostic metadata only. They must not be used as a remote identity, sent to providers, or exposed to Renderer unless a user explicitly opens an advanced diagnostic view.

### 4.3 Connector contract

The browser-neutral contract should cover:

- `getDescriptor()`: connector ID, browser family/product, extension version, protocol version, profile-instance ID, capabilities.
- `getHealth()`: transport state, last heartbeat, protocol compatibility, permission/readiness diagnostics.
- `listTabs()`: tabs visible to this extension instance, with opaque tab IDs, normalized origin, title only when needed, active/selected state, and provider match.
- `inspectPermissions()`: required versus granted host/API permissions for supported provider origins.
- `activateContent(tabId)`: ping first, inject only when permitted and safe, then verify readiness. Never reload or navigate a user's tab automatically.
- `focusTab(tabId)`: focus only after an explicit user action or an operation that requires it and has been disclosed.
- `sendTask()` / `cancelTask()`: versioned task messages with Main-owned task IDs and existing cancellation semantics.
- `dispose()`: release transport resources without changing the browser profile.

The contract must not expose raw cookies, browser storage, arbitrary JavaScript execution, filesystem paths, or unrestricted browser commands to Renderer.

### 4.4 Protocol and transport

Retain loopback WebSocket as the initial transport because it is already implemented and authenticated. Evolve the protocol from a single Zen-specific peer into a multi-connector protocol:

- Each connector has a distinct connector ID and connection lifecycle.
- Pairing/authorization is scoped to a connector installation or explicitly approved browser profile, not an accidental global trust decision.
- The bridge validates protocol version, message schema, origin, size limits, rate limits, and task ownership.
- Reconnect uses bounded exponential backoff with jitter.
- Heartbeats and request/response correlation detect half-open connections.
- One connector disconnect must not evict other connected browser profiles.
- Task routing is explicit: provider tab → connector ID → extension task controller.
- Duplicate connector IDs and stale connections are resolved deterministically; newer connection replacement must not silently steal in-flight tasks.

## 5. Browser support strategy

Support is organized by engine family and verified product compatibility, not by installation path.

| Family | Initial candidates | Integration strategy | Important constraint |
|---|---|---|---|
| Firefox WebExtensions | Zen, Firefox, compatible forks | Firefox-compatible extension package and WebExtension APIs | Validate product-specific permissions and API differences |
| Chromium WebExtensions | Chrome, Edge, Brave, compatible browsers | Manifest V3 package and Chromium API adapter | Current MV2 package is not a valid production baseline |
| Other engines | Safari and future browsers | Separate connector only after a feasibility spike | No compatibility claim before validation |

A browser is considered supported only after installation/update, permission, connection, tab discovery, content activation, send/cancel, reconnect, and profile-isolation tests pass on a real instance.

## 6. Provider readiness is a separate state machine

Do not collapse these layers into one "connected" boolean:

1. **Process discovered** — a browser process was observed.
2. **Profile candidate identified** — process metadata points to a probable profile.
3. **Connector installed/available** — package is present or installation can be offered.
4. **Connector connected** — extension authenticated to the local bridge.
5. **Permissions ready** — required provider host permissions are granted.
6. **Provider tab discovered** — connector sees a matching provider tab.
7. **Content runtime ready** — content script answers the expected protocol ping.
8. **Session evidence available** — provider-specific positive/negative UI evidence is collected.
9. **Authenticated** — provider UI gives positive evidence of an authenticated account.
10. **Request ready** — page, composer, and automation contract are ready for a task.

A composer being visible or a provider page being open is not proof of authentication. Cookie-name/expiry metadata is corroborating evidence only and never replaces provider UI confirmation.

## 7. Self-healing and recovery policy

Recovery is a policy engine, not an unbounded retry loop.

| Failure | Safe automatic recovery | User action threshold |
|---|---|---|
| WebSocket transient disconnect | Reconnect with bounded backoff; preserve connector identity | Ask only after retry budget/circuit breaker |
| Half-open connection | Heartbeat timeout, reconnect, re-handshake | Ask if bridge process/port cannot recover |
| Stale tab ID | Re-query tabs in the same connector and remap by provider origin | Ask if no eligible tab exists and creating one is not authorized |
| Content script missing | Ping, inject permitted scripts, ping again | Ask for manual reload only if browser blocks injection |
| Permission missing | Detect exact missing origin/API permission and show targeted guidance | User must grant browser permission |
| Extension version mismatch | Report required/current protocol and offer package/update flow | User confirms browser installation/update |
| Browser process exits | Mark connector unavailable; wait for restart/reconnect | Do not relaunch user's browser without explicit setting |
| Provider login expired | Re-inspect UI and expose login-required | User performs normal login |
| CAPTCHA/challenge/rate limit | Stop automation and classify blocker | User resolves provider challenge or waits |
| Repeated adapter failure | Circuit breaker, preserve diagnostics, avoid more sends | Offer manual recovery |

Every recovery action records a redacted reason, attempt number, result, and elapsed time. Retry budgets and cooldowns are per connector and failure category. A failed recovery must not silently mutate user state.

### 7.1 Explicitly prohibited automatic actions

- Read/decrypt/copy cookies or password stores.
- Clear cookies, local storage, cache, or browser history.
- Close, reorder, pin, unpin, or navigate existing tabs.
- Disable/uninstall/reinstall extensions.
- Change browser startup flags, profile preferences, or remote-debugging settings.
- Launch another browser/profile as an implicit replacement for the user's active environment.
- Retry a provider submission when its outcome is ambiguous.

## 8. Security and privacy boundaries

- Local process discovery runs in Electron Main only and returns a minimized descriptor to Renderer.
- Never enable remote debugging on an existing browser as a discovery shortcut. Do not attach to an arbitrary CDP endpoint or expose DevTools ports.
- Pairing tokens remain protected by existing Windows ACL hardening and must not be returned through generic diagnostics.
- Validate connector identity and protocol messages on the Main side. Renderer cannot address arbitrary connectors or tabs without Main authorization.
- Extension host permissions remain provider-specific. Optional permissions may be used where supported to defer grants until a provider is enabled, but UX and browser compatibility must be tested.
- Store only opaque connector/profile IDs and bounded operational metadata by default.
- Do not log prompt/response content, cookie values, auth tokens, pairing codes, or full URLs with sensitive query strings.
- Treat extension messages and browser metadata as untrusted input.

## 9. Migration plan

1. **Stage 0 — Architecture and audit:** inventory Zen coupling, define contracts, document protocol migration and acceptance gates. No runtime behavior change.
2. **Stage 1 — Discovery foundation:** implement OS-neutral domain contracts plus Windows process discovery behind an adapter; add deterministic parser/tests. Process discovery remains informational until a connector claims a profile.
3. **Stage 2 — Connector abstraction:** extract current Zen extension behavior behind a generic BrowserConnector contract without changing task semantics. Preserve a compatibility facade for current IPC/UI.
4. **Stage 3 — Multi-connector bridge:** protocol v2, multiple simultaneous extension instances, connector-scoped pairing, health and reconnect.
5. **Stage 4 — Browser packages:** Firefox-family package first (Zen/Firefox); Chromium MV3 package with separate build and API compatibility tests.
6. **Stage 5 — Provider readiness and permission diagnostics:** explicit readiness layers, per-origin permission status, positive authentication evidence.
7. **Stage 6 — Self-healing:** bounded recovery engine, circuit breakers, safe automatic actions, actionable manual recovery.
8. **Stage 7 — Production validation:** real-browser matrix, multiple profiles, multiple browser processes, restart/reconnect, send/cancel, packaging/update and security validation.

The current Zen connector remains the first compatibility implementation throughout migration. Do not remove it until replacement connectors meet parity gates.

## 10. Stage 0 audit findings

| Severity | Finding | Evidence | Required action |
|---|---|---|---|
| P1 | Core is Zen-coupled | `main.ts` constructs `ZenBridge`; IPC imports `ZenBridge` and exposes Zen-named methods | Introduce browser-neutral manager/facade incrementally |
| P1 | Discovery is profile-local | Extension uses `browser.tabs.query({})` | Add process discovery plus connector-reported profile/tab inventory; do not claim process scan sees tabs |
| P1 | Bridge currently enforces a single active extension socket | `ZenBridge` stores one `private socket`, rejects messages from any socket other than the adopted one, and `adoptSocket()` closes the previous socket as `Replaced by a new connection` | Replace single-peer ownership with connector-scoped sessions; test parallel profiles and in-flight task isolation before enabling multiple connectors |
| P1 | Extension origin approval is globally pinned to one origin | `approvedExtensionOrigin` is a single persisted value; `approveExtensionOrigin()` rejects any different extension origin after the first one is approved | Replace the global origin pin with an explicit connector trust registry and connector-scoped pairing; never broaden to arbitrary extension origins |
| P1 | Current extension packaging is not cross-browser | `manifest_version: 2` and Zen-specific metadata | Separate Firefox-family and Chromium MV3 builds |
| P2 | Browser/profile identity is absent from shared contracts | `BrowserInfo` exposes status/name/message only | Add typed browser/connector/profile descriptors with opaque IDs |
| P2 | Permission diagnostics are not first-class | Current extension has declared host permissions but no general per-connector permission report contract | Add permission inspection and distinguish missing grants from injection/runtime failures |
| P2 | Recovery policy is implicit | Existing ping/injection behavior has no central bounded recovery policy | Add recovery taxonomy, budgets, cooldowns and verified outcomes |

## 11. Acceptance criteria

Stage 0 is complete when the architecture, ADR, migration plan, current constraints, and explicit non-goals are documented and reviewed.

Stage 1 is complete when:
- Process discovery works without assuming install paths for the supported OS.
- Multiple browser products and multiple instances are represented without selecting an arbitrary "first" process.
- Command-line parsing is tested against quoted paths, spaces, profile flags, missing flags, and child processes.
- Process discovery never claims tabs, extension presence, or authentication.
- No browser profile or credential database is modified/read.

Connector parity requires, for each browser/profile:
- Connector handshake and protocol compatibility.
- Permission inspection for all supported provider origins.
- Provider tab discovery in that connector's profile only.
- Content activation without automatic reload/navigation.
- Task send/cancel and stale-tab recovery.
- Reconnect after browser/app restart.
- Multiple connectors can coexist without task cross-routing.
- Logs and diagnostics contain no credentials or conversation content.

## 12. Open implementation decisions

- Whether a connector ID is installation-scoped or profile-scoped in each browser family; choose the strongest stable non-secret identity the extension APIs provide.
- How to correlate process metadata to connector instances without exposing raw profile paths or relying on brittle process-tree assumptions.
- Whether Chromium MV3 service-worker lifecycle needs a different heartbeat/reconnect implementation from Firefox persistent background scripts.
- Whether optional host permissions improve least-privilege UX consistently across target browsers.
- Which additional OS process providers to implement after Windows (macOS/Linux).
