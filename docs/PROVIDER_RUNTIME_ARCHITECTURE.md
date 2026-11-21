# Provider Runtime Architecture

**Status:** Legacy proposal; app-owned-session-first direction superseded for browser hosting
**Canonical browser architecture:** [Browser Integration Architecture](./BROWSER_INTEGRATION_ARCHITECTURE.md)
**Canonical browser decision:** [ADR 0001 — User-Browser-First Integration](./adr/0001-user-browser-first-integration.md)
**Scope retained:** Provider automation reliability, session evidence, diagnostics, and answer-quality improvements

> This document remains a useful source for provider automation contracts and safety requirements. Its proposal to make app-owned browser profiles the primary runtime is superseded. The default integration target is the user's already-running browser/profile through a browser connector; a managed browser context is an explicit fallback.
**Constraint:** Use public AI web interfaces; do not require paid API keys or bypass platform access controls.

## 1. Context and goals

Multi-AI Aggregator currently automates ChatGPT, Qwen, and DeepSeek through the Zen WebExtension and a loopback-authenticated WebSocket bridge. The extension owns the tabs in which users authenticate. This couples login state and automation availability to a separate browser profile and makes environment changes harder to recover from.

The next architecture should make the aggregator the owner of provider sessions and automation lifecycle. A browser engine remains necessary to render and interact with provider websites, but its profiles, lifecycle, and recovery must be controlled by the application rather than borrowed from a user's everyday browser profile.

Goals:

- Keep provider login state in application-managed, persistent, isolated profiles.
- Make the automation host independent of Zen Browser; retain Zen as a migration fallback until parity is demonstrated.
- Improve confidence that a prompt was submitted once and that the returned text is the complete response to that prompt.
- Detect login gates, challenges, rate limits, changed layouts, and extraction failures explicitly.
- Preserve current task IDs, Main-owned task lifecycle arbitration, cancellation semantics, IPC boundary, and synthesis capability.
- Improve final answer quality without paid API keys by strengthening prompt preparation, synthesis, and optional cross-review.
- Keep user prompts, provider responses, cookies, and tokens out of diagnostic logs.

Non-goals:

- Scraping private provider APIs, reverse-engineering undocumented endpoints, or depending on API keys.
- Bypassing CAPTCHAs, age gates, login requirements, rate limits, or other provider controls.
- Promising that a session can always be moved to another machine or that a submitted remote generation can be cancelled.
- Replacing the current architecture in one rewrite.

## 2. Current baseline

- Electron Main owns task registration, task IDs, batch membership, terminal-state arbitration, and IPC validation.
- Zen Bridge is a loopback WebSocket server authenticated with a pairing token.
- Zen Extension background owns task-to-tab routing and active task controllers.
- Content automation contains provider-specific selectors, waits, blocker detection, and response extraction.
- Cancellation is implemented across Main, Extension, Content Script, preload, and renderer. It is cooperative; after submission, a provider may continue generating remotely.
- The three provider adapters are currently implemented in the extension content script. Adapter behavior and selector configuration need a single source of truth before adding more providers or execution hosts.
- The latest recorded regression baseline is 53/53 security/integration tests passing. Packaged smoke and typecheck passed before the final disconnect follow-up; after that follow-up, the full security suite and `git diff --check` passed. A real authenticated E2E run against all providers has not been established by this baseline.

## 3. Target logical architecture

```tex
Renderer
  │ narrow, validated preload API
  ▼
Aggregator Core (Electron Main)
  ├─ Task Coordinator / Batch Registry
  ├─ Provider Runtime API
  ├─ Prompt Orchestrator
  └─ Synthesis Pipeline
         │
         ▼
Provider Runtime
  ├─ Provider Registry
  ├─ Session Manager
  ├─ Automation Hos
  ├─ Adapter Diagnostics
  └─ Provider Health Monitor
         │
         ├─ ChatGPT adapter + isolated app-owned profile
         ├─ Qwen adapter + isolated app-owned profile
         └─ DeepSeek adapter + isolated app-owned profile
```

The Renderer must not receive raw cookies, storage contents, provider credentials, arbitrary browser commands, or direct filesystem access. Main remains the authority for task state and result arbitration.

### Provider interface

Each provider adapter should implement a narrow contract conceptually equivalent to:

- `getCapabilities()` — supported operations and known limitations.
- `inspectSession()` — `checking`, `logged-in`, `guest`, `login-required`, `manual-action`, `blocked`, or `error`.
- `openLogin()` — open the provider in its isolated app-owned context for manual authentication.
- `submit(task)` — submit once and return evidence that submission occurred.
- `collect(task)` — collect the correlated assistant response and completion evidence.
- `cancel(taskId)` — stop local automation/collection where possible and report whether the stop was confirmed locally.
- `dispose()` — release pages, listeners, timers, and runtime resources without silently deleting the persistent profile.

Provider-specific selectors and completion rules belong in one adapter definition per provider, not duplicated across Main and Extension implementations.

## 4. Session ownership and storage

### Desired behavior

1. The user opens an Accounts/Providers screen in the aggregator.
2. The aggregator opens the selected provider in an isolated, persistent application-managed browser context.
3. The user completes the provider's normal login flow manually.
4. The application reuses that provider context after restart.
5. Each provider has a separate context so cookies and site storage are not shared across providers.

### Runtime decision to validate

The preferred first prototype is an Electron persistent session partition per provider (`session.fromPartition('persist:<provider-id>')`) with provider pages hosted in controlled Electron windows. This naturally places Chromium session data under the application's user-data area and removes dependence on Zen's profile.

This is a **prototype candidate, not yet an irreversible decision**. Before adoption, validate provider compatibility, login flows, popup/OAuth behavior, downloads, clipboard, streaming updates, and whether provider sites behave acceptably in Electron's Chromium environment. If Electron's embedded context is incompatible, evaluate a separately launched persistent Chromium context whose profile directory is still owned by the aggregator. Do not reuse a user's default Chrome/Edge/Zen profile.

### Security requirements

- Keep profile directories under the application-controlled user-data root, one directory/partition per provider.
- Apply restrictive OS filesystem permissions where supported.
- Keep cookies and web storage out of Renderer IPC, logs, crash reports, and telemetry.
- Use Electron `safeStorage` only for application-managed secrets that need explicit encryption; do not invent a second cookie store.
- Never export session data as plaintext. Any future backup must be encrypted, opt-in, versioned, and clearly warn that provider-side device/session binding may force re-authentication.
- Do not delete a profile on logout unless the user explicitly chooses a separate “clear local session data” action.
- Do not copy or migrate cookies from Zen automatically. Require a normal login in the aggregator-owned context.

### Portability limits

App-owned storage survives switching everyday browsers and survives app upgrades as long as the user-data directory is preserved. It does not guarantee session portability across computers: providers may bind sessions to device, IP, browser environment, or risk signals. A restored backup may require a fresh login.

## 5. Automation reliability model

Treat web automation as a stateful transaction, not a sequence of clicks:

```tex
created → preparing → ready-to-submit → submitting → submitted
                                      │                 │
                                      │                 ▼
                                      └──────────→ streaming → completed
                                                        ├→ partial
                                                        ├→ blocked / login-required
                                                        └→ failed
```

Cancellation remains a cross-cutting state owned by Main. The provider runtime must distinguish “local automation stopped” from “remote generation stopped”.

Required safeguards:

- Validate the active provider origin and expected page before interacting.
- Locate the composer using layered evidence (stable selectors, accessible roles/labels, visibility, enabled state), not a single brittle selector.
- Verify the prompt was placed in the composer before submitting.
- Capture submission evidence (composer cleared or expected user message appeared) before treating the request as submitted.
- Correlate the assistant response with the current task and the latest user message; never accept an older answer as the new result.
- Detect completion using multiple provider-specific signals: stop/generation control state, streaming DOM changes, response stability, and explicit completion markers when available.
- Use both an overall deadline and a no-progress deadline. Timeouts must be provider-specific and configurable from measured data.
- Classify login gates, challenges/CAPTCHAs, age gates, rate limits, network errors, and changed layouts separately. Stop and ask for user action where required; never attempt to bypass controls.
- Validate extracted content before `done`: non-empty assistant content, expected message identity, no known error placeholder, and a completion signal. Otherwise return a typed failure or `partial` result.
- Preserve partial text when useful, but never present it as a completed answer.
- Clean up observers, listeners, timers, and abort handlers on every terminal path.

### Retry and duplicate-submission policy

- Retry automatically only when there is reliable evidence that submission did not occur (for example, composer unavailable before clicking Send).
- If the click may have succeeded but submission acknowledgement is ambiguous, do not blindly resend. Mark the task `submission-unknown`, inspect the page, and require recovery logic or user confirmation.
- After confirmed submission, retry response collection without resubmitting the prompt.
- Keep idempotency/task IDs in Main and pass them through every runtime/adapter message.

## 6. Diagnostics and observability

Collect bounded, privacy-safe operational metrics per provider:

- attempts, successful completions, partial results, failures, cancellations;
- time to open, time to submit, time to first response content, total response duration;
- timeout category, blocker category, adapter/version identifier;
- selector/DOM contract health (which expected signal was missing), without storing page text.

Do not log prompts, responses, cookies, auth tokens, pairing codes, or full URLs containing sensitive query parameters. Diagnostics should use stable error codes and redacted metadata. Keep retention bounded and make diagnostics inspectable by the user.

The UI should show provider readiness separately from task status: connected/session-valid, login required, blocked/manual action, degraded, or unavailable. Do not imply that “logged-in” means the provider is currently accepting requests.

## 7. Answer-quality improvements without API keys

### Prompt Orchestrator

- Preserve the user's original request verbatim as the source of truth.
- Optionally classify task type (coding, research, comparison, explanation, creative, etc.).
- Add only concise, task-relevant output constraints; avoid model-specific prompt rewrites that make answers incomparable.
- Keep a record of the effective prompt version for reproducibility, without logging its contents.

### Synthesis Pipeline 2.0

- Normalize model outcomes and distinguish missing, failed, partial, and complete responses.
- Extract claims, recommendations, assumptions, and cited sources where present.
- Compare agreement, disagreement, and unique contributions.
- Preserve meaningful disagreements and uncertainty.
- Do not treat model consensus as proof of factual correctness.
- Do not fabricate citations or imply independent fact-checking that did not occur.
- Produce a useful answer even when one or more providers fail, while disclosing missing inputs.

### Optional Cross-Review

An opt-in mode may ask other web models to critique a draft for errors, omissions, and alternatives, then feed those findings into synthesis. It increases latency and consumes provider limits; it must not be the default path. Cross-review is critique, not a guarantee of correctness.

## 8. Compatibility and migration

- Preserve Main-owned task registry, task IDs, batch IDs, terminal arbitration, and cancellation semantics.
- Keep the preload/IPC boundary narrow; introduce typed Provider Runtime IPC methods rather than exposing browser internals.
- Keep Zen Bridge/Extension available as a temporary fallback until each provider passes parity tests in the app-owned runtime.
- Migrate one provider at a time. Do not remove the Zen path until all supported providers meet acceptance criteria and rollback is tested.
- Reuse existing synthesis and renderer components where their contracts remain valid.

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Provider blocks or behaves differently in Electron | Session/runtime migration may fail | Run a compatibility spike before committing to Electron partitions; retain alternate app-owned Chromium host as a fallback candidate |
| Provider DOM changes | Automation regression | Adapter contract tests, diagnostics, layered selectors, manual E2E smoke per provider |
| Ambiguous submit acknowledgement | Duplicate prompts | Explicit submission state and no blind retry after ambiguous submit |
| Session data is sensitive | Account compromise | Isolated profiles, OS permissions, no cookie IPC/logging, opt-in encrypted backup only |
| Provider session is device-bound | Restore on another PC fails | Explain re-auth possibility; do not promise portable cookies |
| Web UI limits/rate limits change | Reduced availability | Detect and report; respect provider controls; no bypass |
| More model calls for synthesis/review | Latency and account limits | Make Cross-Review optional and show estimated extra work |

## 10. Architecture decision gates

Do not approve the runtime host for production until a spike demonstrates, for each initial provider:

1. Normal manual login works in the isolated app-owned context.
2. Session survives app restart and remains isolated from other providers.
3. Prompt submission and response extraction work on the supported UI.
4. Completion and partial-response detection are reliable under streaming.
5. Login gates, challenges, rate limits, and layout failures are classified without bypass.
6. Cancellation stops local automation and accurately reports remote-stop uncertainty.
7. No secrets or conversation contents leak through logs, IPC, or diagnostics.
8. The app can close/reopen contexts without corrupting persistent session data.

Passing one provider is not evidence that all providers are compatible.\n