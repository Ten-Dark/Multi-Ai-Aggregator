# Browser Integration and Self-Healing Roadmap

**Status:** Stage 0 complete; Stage 1 Windows discovery provider and OS provider registry implemented. Windows live smoke validation passed; other OS providers are not implemented.
**Architecture:** [Browser Integration Architecture](./BROWSER_INTEGRATION_ARCHITECTURE.md)
**Decision:** [ADR 0001 — User-Browser-First Integration](./adr/0001-user-browser-first-integration.md)
**Architecture baseline commit:** 0363ad3
**Current connector:** Zen WebExtension + loopback WebSocket bridge.

## Delivery rules

- User-browser-first: attach to an existing browser/profile; do not silently create a managed profile.
- Preserve the current Zen path until a replacement connector passes real-browser parity.
- Never use fixed install/profile paths as the discovery source of truth.
- Process discovery does not prove extension connectivity, tabs, or authentication.
- No cookie database access, cookie export, profile scraping, or credential migration.
- No automatic destructive profile/browser actions.
- Preserve Main-owned task IDs, batch arbitration, cancellation, and no-blind-resubmit behavior.
- Implement small phases with deterministic tests and explicit acceptance evidence.
- Keep forensic artifacts and pre-existing working-tree changes untouched.

## Stage 0 — Architecture and audit

**Goal:** Define the target system and migration boundaries without changing runtime behavior.

- [x] S0.1 Audit current Main/IPC/Extension coupling and record confirmed constraints.
- [x] S0.2 Define browser-neutral Browser Integration Manager architecture.
- [x] S0.3 Record user-browser-first decision and rejected alternatives in ADR 0001.
- [x] S0.4 Define process discovery versus connector discovery responsibilities.
- [x] S0.5 Define connector contract, multi-connector protocol requirements, and provider readiness states.
- [x] S0.6 Define safe self-healing policy, retry boundaries, and prohibited automatic actions.
- [x] S0.7 Review the current bridge ownership and handshake: one active socket is stored; adopting a new socket closes the previous one, so parallel profiles are not supported yet.
- [x] S0.8 Add architecture/ADR/roadmap links to the documentation index and mark the app-owned-session-first Provider Runtime proposal as superseded for browser hosting.

**Exit criteria:** No ambiguity that the default mode attaches to the user's existing browser; current implementation limitations and migration rollback are documented; no runtime behavior changed.

## Stage 1 — Browser discovery foundation

**Goal:** Reliably discover running browser instances and profile candidates without touching browser data.

- [x] S1.1 Define shared BrowserFamily, BrowserProcessDescriptor, and DiscoveryConfidence types; attach a stable instance identifier derived from browser identity and explicit profile arguments.
- [x] S1.2 Define BrowserDiscoveryProvider interface and OS provider registry.
- [x] S1.3 Implement read-only Windows process enumeration in an isolated discovery service; no profile database access.
- [x] S1.4 Parse process executable, command line, parent/child relationships, start time, and visible-window metadata.
- [x] S1.5 Parse Firefox-family -profile and Chromium --user-data-dir / --profile-directory arguments.
- [x] S1.6 Identify browser family/product from Windows executable version metadata (FileDescription, ProductName, CompanyName), with conservative false-positive handling and metadata fixtures.
- [x] S1.7 Add deterministic fixtures for quoted paths, spaces, Unicode, missing flags, custom executables, and child processes.
- [x] S1.8 Preserve multiple root process candidates and collapse child processes; no arbitrary first-process selection.
- [x] S1.9 Add a read-only diagnostic for the user's currently running X:\BrowserPortal\ZenProfile instance when present; never assume that path in production code.
- [ ] S1.10 POST-PRODUCTION: Activate, validate, and ship macOS/Linux process providers. Unix provider code is retained but intentionally excluded from the current Windows production runtime.

**Exit criteria:** Discovery is path-independent on Windows, identifies multiple instances/profile candidates, exposes confidence/provenance, and does not inspect or modify profile databases.

## Stage 2 — Browser-neutral connector abstraction

**Goal:** Extract the existing Zen extension integration behind a generic contract without changing behavior.

- [ ] S2.1 Define BrowserConnector, ConnectorDescriptor, ConnectorHealth, ConnectorPermissionReport, and ConnectorTab contracts.
- [ ] S2.2 Define connector lifecycle states: discovered, pairing-required, connecting, connected, degraded, disconnected, incompatible, blocked.
- [ ] S2.3 Introduce BrowserIntegrationManager and connector registry in Electron Main.
- [ ] S2.4 Wrap current ZenBridge behind a compatibility adapter; preserve current IPC/UI during transition.
- [ ] S2.5 Replace Zen-specific shared browser status with browser-neutral descriptors while retaining compatibility fields temporarily.
- [ ] S2.6 Add protocol/capability negotiation and explicit unsupported-version errors.
- [ ] S2.7 Ensure connector messages are validated in Main and task IDs remain Main-owned.
- [ ] S2.8 Add contract tests using a fake connector and parity tests for the Zen adapter.

**Exit criteria:** Existing Zen send/check/focus/cancel flows pass unchanged through the generic manager; no second browser connector is required yet.

## Stage 3 — Multi-connector bridge protocol

**Goal:** Support several browser products and profiles concurrently.

- [ ] S3.1 Audit current WebSocket client ownership, replacement rules, origin validation, and connection cleanup.
- [ ] S3.2 Design protocol v2 hello/ack with connector ID, protocol version, browser family/product, extension version, profile-instance ID, and capabilities.
- [ ] S3.3 Scope pairing/authorization to connector installations or explicit profile approvals.
- [ ] S3.4 Replace single-peer assumptions with a connector session registry.
- [x] S3.5 Route each task through an explicit connector identity and connection generation; prevent cross-profile task routing.
- [x] S3.6 Add provider-level connector affinity for ChatGPT, Qwen, and DeepSeek, including persisted assignments and isolated session/focus/send/synthesis routing.
- [x] S3.7 Add heartbeat, request correlation, bounded reconnect with jitter, and stale connection eviction.
- [x] S3.8 Ensure one connector disconnect does not affect other connectors or their tasks.
- [x] S3.9 Add deterministic tests for duplicate connector IDs, stale sockets, parallel peers, reconnect races, version mismatch, and in-flight task ownership.
- [ ] S3.10 Migrate pairing UX without exposing or logging pairing secrets.

**Exit criteria:** Two or more connector instances can remain connected and route tasks independently; reconnect and disconnect behavior is covered by tests.

## Stage 4 — Browser-family extension packages

**Goal:** Ship connectors compatible with distinct extension ecosystems.

- [ ] S4.1 Extract shared provider automation and protocol code from browser-specific background bootstrap where practical.
- [ ] S4.2 Keep a Firefox-family build for Zen/Firefox and validate supported minimum versions.
- [ ] S4.3 Build a separate Chromium Manifest V3 package (service worker lifecycle, permissions, action API).
- [ ] S4.4 Add build-time manifest validation and package smoke tests for each target family.
- [ ] S4.5 Validate host permission grant UX for ChatGPT, Qwen, and DeepSeek independently.
- [ ] S4.6 Add extension version/protocol compatibility diagnostics and safe update guidance.
- [ ] S4.7 Validate install, update, disable/enable, browser restart, profile restart, and extension reload in real browsers.
- [ ] S4.8 Publish a truthful support matrix; do not list an untested browser as supported.

**Exit criteria:** At least Zen/Firefox-family and one Chromium-family connector pass real-browser connection, permissions, tab discovery, content activation, and reconnect tests.

## Stage 5 — Permission and provider readiness

**Goal:** Make every layer's state visible and distinguishable.

- [ ] S5.1 Add per-connector permission inspection for required APIs and each provider origin.
- [ ] S5.2 Distinguish browser process, profile candidate, extension, connector, permission, tab, content runtime, session, and request readiness.
- [ ] S5.3 Add per-provider tab matching that is scoped to a connector.
- [ ] S5.4 Add content activation diagnostics: ping, permission check, injection attempt, post-injection ping, exact failure.
- [ ] S5.5 Keep authentication evidence provider-specific; never infer login from composer visibility alone.
- [ ] S5.6 Add UI that identifies which browser/profile connector owns each provider tab.
- [ ] S5.7 Add privacy-safe diagnostics export without prompt/response/cookie/token contents.

**Exit criteria:** The user can see exactly which browser/profile is connected, which permissions are missing, which tabs are found, and whether authentication is confirmed.

## Stage 6 — Self-healing and recovery

**Goal:** Recover transient failures autonomously while preserving user state.

- [ ] S6.1 Define typed recovery reasons, safe action catalogue, per-category retry budgets, and cooldowns.
- [x] S6.2 Implement WebSocket reconnect, heartbeat recovery, and connector re-handshake.
- [ ] S6.3 Implement stale-tab rediscovery and safe tab remapping.
- [ ] S6.4 Implement content ping/re-injection with permission-aware error classification.
- [ ] S6.5 Implement extension/protocol version mismatch guidance and update handoff.
- [ ] S6.6 Implement circuit breakers and recovery-loop prevention.
- [ ] S6.7 Add recovery event log with redacted metadata and outcome verification.
- [ ] S6.8 Add manual-action escalation only after safe recovery paths are exhausted.
- [ ] S6.9 Test browser crash/restart, app crash/restart, extension reload, network interruption, permission revocation, and multiple connector failures.

**Exit criteria:** Common transient faults recover without user action; permission/login/challenge issues produce precise user actions; no destructive recovery path exists.

## Stage 7 — Production compatibility and hardening

**Goal:** Validate real-world browser/profile combinations and ship reliable defaults.

- [ ] S7.1 Test portable/custom-path installs and profile paths containing spaces and Unicode.
- [ ] S7.2 Test multiple browsers and multiple profiles simultaneously.
- [ ] S7.3 Test active user browser discovery without launching extra windows or tabs.
- [ ] S7.4 Test task send/cancel, reconnect, provider readiness, and no cross-connector leakage.
- [ ] S7.5 Run security review of process discovery, local bridge, pairing, connector identity, and extension packages.
- [ ] S7.6 Run full typecheck, security/integration suite, package build, extension package tests, and production dependency audit.
- [ ] S7.7 Document support matrix, installation/update/recovery UX, known limitations, and rollback.
- [ ] S7.8 Keep managed browser context as an explicit opt-in fallback only if separately validated.

**Exit criteria:** All claimed browser/profile combinations pass the same acceptance suite; unsupported environments fail clearly without damaging user state.

## Global acceptance gates

- No fixed browser executable or profile path in Core.
- Process discovery is never treated as proof of extension/tab/auth state.
- Existing user browser/profile is the default integration target.
- No cookie/password database access or session migration.
- Multiple connectors are isolated and concurrently supported.
- No automatic destructive profile or tab operation.
- Recovery is bounded, verified, and does not duplicate provider submissions.
- Main-owned task lifecycle and cancellation semantics remain intact.
- npm run typecheck, npm run test:security, build/package checks, and git diff --check pass for relevant changes.
- Real-browser evidence is reported separately from mocks.

## Stage 1 implementation status

The Windows discovery implementation is in `src/main/browser/browser-discovery.ts`. `BrowserDiscoveryProvider` and `BrowserDiscoveryRegistry` isolate OS-specific discovery from the application-facing service; Windows currently has the only concrete provider. The renderer displays executable identity, process ID, profile candidate, confidence, and visible-window metadata. The scan is read-only and does not inspect cookies, profile databases, extension storage, or provider pages.

Live Windows smoke validation identified the active Zen process, its `X:\\BrowserPortal\\ZenProfile` profile, and a visible Zen window title. The process scan is path-independent. Browser process detection remains distinct from extension connection, tab discovery, and provider authentication. Generic unknown executable candidates are intentionally conservative to avoid classifying unrelated Electron apps as browsers.

macOS/Linux provider code is retained in `src/main/browser/unix-browser-discovery.ts` for the post-production phase. The current production runtime intentionally registers only the Windows provider. Native macOS/Linux validation and activation are explicitly deferred until after the Windows production release.

## Windows multi-connector implementation (2026-11-22)

The extension reports a stable per-installation UUID plus browser name/version after token authentication and sends an application-level heartbeat every 15 seconds. The bridge validates identity metadata, requires the identity handshake within 10 seconds, tracks each connector's heartbeat independently with a 45-second lease, and terminates stale peers.

The single-socket bridge ownership has been replaced with `ZenConnectorRegistry` and a socket-to-instance ownership map. Multiple browser profiles can remain connected simultaneously. A reconnect replaces only the prior socket for the same extension installation; stale close events cannot unregister the replacement. Disconnecting a non-active profile does not affect the active connection. Responses are accepted only from the socket that owns the pending command, and pending work for a disconnected socket is rejected without affecting other peers.

The renderer exposes connected profiles, a default active profile, and an independent connector selector for ChatGPT, Qwen, and DeepSeek. Each provider can either follow the active profile or be pinned to a specific extension installation. Assignments are stored locally in `provider-connectors.json` and survive application restarts; if a pinned connector is unavailable, that provider fails explicitly instead of silently falling back. Session checks are grouped by connector and only update the providers assigned to that connector. Focus, individual sends, batch sends, and synthesis all resolve through provider affinity. A batch snapshots every provider route before dispatch, so changing the active profile during the batch cannot split the operation across unintended profiles. Each task also captures the connector instance ID and monotonic connection generation; send, progress, response, and cancellation remain bound to that exact generation. Reconnect under the same installation ID cannot inherit an in-flight task. The active profile may now be changed during pending operations because existing tasks retain their original connector ownership. If a connector disconnects, only commands owned by its socket are rejected; tasks on other connectors continue. Profiles are distinguished by a short instance-ID suffix because the extension does not yet report a verified browser profile path/name.

Added `scripts/zen-multi-connector.integration.test.mjs` to exercise real local WebSocket handshakes, parallel profiles, incompatible extension metadata, same-profile reconnect races, active-profile command routing, provider-level assignment and persistence, per-provider session checks, batch route snapshots, focus/synthesis routing, unavailable-assignment failure, mismatched heartbeat rejection, failover, and task/cancellation affinity to the originating connector generation. The task registry tests cover connector ownership metadata; the pure connector registry tests cover independent heartbeat freshness, isolated removal, explicit selection, and shutdown clearing. Extension reconnect now uses exponential backoff (1–60 seconds) with bounded ±20% jitter, reports the next retry delay, and resets the retry budget only after the identity handshake succeeds. `scripts/zen-reconnect-policy.test.mjs` covers growth, cap, jitter, reset, and invalid inputs. This is unit/integration evidence; browser restart and real-network interruption still require real-browser validation.

**Known boundaries:** provider affinity currently binds each AI provider to one browser extension installation; it does not yet bind individual tabs or browser windows separately. Browser process discovery is not yet cryptographically or deterministically matched to an extension instance; do not infer profile paths from extension metadata. Full Windows ACL/security-origin tests remain blocked on this host by the PowerShell `Microsoft.PowerShell.Security` / `Get-Acl` module-load failure; the injected storage-security seam is used only by the bridge integration tests, while production continues to use the real ACL implementation. macOS/Linux provider activation and native testing remain deferred until after the Windows production release.
