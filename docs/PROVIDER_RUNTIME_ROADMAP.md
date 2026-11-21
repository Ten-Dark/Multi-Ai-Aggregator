# Provider Runtime and Web-Agent Reliability Roadmap

**Status:** Planning baseline
**Architecture reference:** [`PROVIDER_RUNTIME_ARCHITECTURE.md`](./PROVIDER_RUNTIME_ARCHITECTURE.md)
**Starting commit:** `1262368`
**Implementation status:** P0/P1 reliability work is in progress. See [`PROVIDER_RUNTIME_BASELINE.md`](./PROVIDER_RUNTIME_BASELINE.md) for the current evidence and remaining blockers.

## Principles

- No paid API keys are required for the planned web-agent path.
- Prefer small, independently reviewable phases and Conventional Commits.
- Preserve forensic/audit artifacts; stage only explicitly selected project files.
- Do not remove Zen automation until app-owned runtime parity and rollback are proven.
- Every phase must include tests and evidence. A mocked test is not a real-provider E2E test.
- Respect provider login, CAPTCHA, rate-limit, and access controls.

## Phase 0 — Baseline and contracts

**Goal:** Establish an accurate, reproducible baseline before changing the runtime.

Tasks:

- [ ] P0.1 Re-run typecheck, security/integration suite, package build, packaged smoke test, production dependency audit; record exact results.
- [ ] P0.2 Inventory current provider-specific selectors, login detection, blocker detection, submission evidence, response extraction, and completion rules.
- [ ] P0.3 Compare adapter configuration in the current source tree and remove drift by defining one canonical provider adapter contract/configuration source.
- [ ] P0.4 Define typed provider error taxonomy and task submission states, including `submission-unknown` and `partial` semantics; preserve current terminal-state arbitration.
- [x] P0.5 Add deterministic tests for submission outcomes, prompt verification, and “never resend after ambiguous submission”.
- [x] P0.6 Move bridge credentials into a dedicated protected directory, apply and verify a Windows DACL for the current user/SYSTEM/Administrators, and rotate the legacy token.
- [x] P0.7 Add reproducible XPI packaging with archive-content and manifest-version verification.

Exit criteria: baseline recorded; adapter contract documented; all existing tests pass; no source behavior changes without tests.

## Phase 1 — Automation reliability

**Goal:** Improve the current Zen-based path first, so the same behavioral contract can later be reused by the new runtime.

Tasks:

- [ ] P1.1 Add a submission state machine: `preparing`, `ready-to-submit`, `submitting`, `submitted`, `submission-unknown`.
- [x] P1.2 Strengthen prompt-fill verification by comparing the normalized composer contents with the original prompt before submission.
- [x] P1.3 Add explicit submission evidence and prevent blind retries after ambiguous send actions (`submission-unknown`).
- [ ] P1.4 Correlate extracted assistant messages with the current task and latest user message.
- [ ] P1.5 Implement multi-signal completion detection with `MutationObserver`, generation controls, response stability, and provider-specific completion markers.
- [x] P1.6 Separate overall timeout from provider-specific no-progress timeout.
- [ ] P1.7 Add extraction-quality gates for empty, stale, error-placeholder, and incomplete responses.
- [ ] P1.8 Test cleanup of observers, timers, and listeners on success, failure, timeout, disconnect, and cancellation.
- [ ] P1.9 Validate positive logged-in/logged-out indicators for every provider; keep session state `unknown` when neither is positively established.

Exit criteria: deterministic unit/integration coverage for each transition; no duplicate-send regression; partial results cannot be labelled complete; existing cancellation tests pass.

## Phase 2 — Provider Runtime compatibility spike

**Goal:** Choose an app-owned browser/session host based on evidence, not assumptions.

Tasks:

- [ ] P2.1 Define `ProviderRuntime`, `ProviderContext`, and `ProviderAdapter` interfaces without exposing Electron or Playwright types to Renderer.
- [ ] P2.2 Prototype persistent Electron session partitions per provider under the application user-data directory.
- [ ] P2.3 Validate login, OAuth/popups, clipboard, downloads, streaming DOM updates, and site compatibility for ChatGPT.
- [ ] P2.4 Repeat compatibility checks for Qwen and DeepSeek; record provider-specific limitations.
- [ ] P2.5 Evaluate a separately launched persistent Chromium context with an aggregator-owned profile only if Electron session compatibility is insufficient.
- [ ] P2.6 Record an ADR selecting the host and document packaging, update, profile path, and rollback strategy.

Exit criteria: written evidence for all three providers; session isolation and restart persistence demonstrated; runtime host selected by ADR; no migration of existing user cookies.

## Phase 3 — Auth Session Manager and account UI

**Goal:** Make the aggregator the owner of provider login state.

Tasks:

- [ ] P3.1 Implement one persistent isolated context per provider.
- [ ] P3.2 Implement session lifecycle: create/open, inspect, reuse, close, and explicit clear-local-session-data.
- [ ] P3.3 Implement session status events with typed states and user-action reasons.
- [ ] P3.4 Add Accounts/Providers UI for opening login, viewing status, and recovering a session.
- [ ] P3.5 Apply storage permissions and verify cookies/storage never cross IPC or enter logs.
- [ ] P3.6 Test app restart, app upgrade simulation, logout, corrupted profile recovery, and provider isolation.

Exit criteria: login persists across app restarts; each provider is isolated; no secrets exposed to Renderer/logs; users can re-authenticate without editing browser profiles.

## Phase 4 — Migrate provider automation

**Goal:** Move providers from Zen Extension to Provider Runtime incrementally.

Tasks:

- [ ] P4.1 Implement the first provider adapter in the selected app-owned runtime.
- [ ] P4.2 Add parity tests for session inspection, submit, response extraction, completion, blocker detection, and cancellation.
- [ ] P4.3 Migrate the second provider after the first passes its acceptance gate.
- [ ] P4.4 Migrate the third provider and run cross-provider batch tests.
- [ ] P4.5 Add runtime selection/fallback while Zen remains available.
- [ ] P4.6 Remove Zen dependency only after all providers pass manual E2E and rollback is verified; otherwise keep it as a supported fallback.

Exit criteria: all supported providers pass real authenticated E2E; task and cancellation semantics match the current Main-owned contract; no regression in batch behavior.

## Phase 5 — Provider health and diagnostics

**Goal:** Make failures observable and recoverable.

Tasks:

- [ ] P5.1 Add bounded per-provider counters and timing metrics.
- [ ] P5.2 Add adapter diagnostics for missing selectors/signals and changed page structure without storing page text.
- [ ] P5.3 Add Provider Health Monitor states: ready, degraded, login-required, manual-action, blocked, unavailable.
- [ ] P5.4 Add conservative retry policy and circuit breaker for repeated transient failures.
- [ ] P5.5 Add recovery actions for disconnected runtime, stale page, and corrupted local profile.
- [ ] P5.6 Add diagnostics UI with redacted recent events and bounded retention.

Exit criteria: common failure categories are visible and actionable; retry cannot duplicate a submitted prompt; logs contain no prompts, responses, cookies, or tokens.

## Phase 6 — Prompt and synthesis quality

**Goal:** Improve answer quality using ordinary web sessions only.

Tasks:

- [ ] P6.1 Add task-type classification as advisory metadata; preserve original prompt verbatim.
- [ ] P6.2 Add optional concise prompt templates for coding, research, comparison, and explanation tasks.
- [ ] P6.3 Normalize provider outcomes (complete, partial, missing, failed) before synthesis.
- [ ] P6.4 Upgrade synthesis to compare claims, assumptions, evidence, contradictions, and unique contributions.
- [ ] P6.5 Require uncertainty disclosure and prohibit fabricated citations or consensus-as-proof language.
- [ ] P6.6 Add regression fixtures for partial providers, conflicting answers, unsupported claims, and missing citations.

Exit criteria: synthesis tests cover disagreements and missing/partial inputs; output does not hide conflicts or invent evidence; user prompt remains traceable.

## Phase 7 — Optional Cross-Review

**Goal:** Add a higher-quality, higher-latency analysis mode.

Tasks:

- [ ] P7.1 Define an opt-in Cross-Review workflow and its extra-request budget.
- [ ] P7.2 Ask selected providers to critique a draft for errors, omissions, and alternatives.
- [ ] P7.3 Aggregate critiques and update synthesis while preserving unresolved disagreements.
- [ ] P7.4 Add UI disclosure that cross-review uses additional provider requests and does not guarantee correctness.

Exit criteria: feature is opt-in, bounded, cancellable, and clearly distinguished from independent factual verification.

## Cross-phase acceptance gates

- `npm run typecheck` passes.
- `npm run test:security` passes.
- Package build and packaged smoke test pass for runtime/package changes.
- `git diff --check` passes.
- Real authenticated provider E2E is reported separately from mocks and only claimed for providers actually tested.
- Cancellation, stale-result protection, and task terminal arbitration remain intact.
- Production dependency audit is recorded; dev-only findings are not “fixed” through breaking upgrades without a separate impact review.
- Conventional Commit per completed phase; push only to a configured and verified remote.

## Recommended first implementation slice

Start with **P0.1–P0.5**, then **P1.1–P1.5**. This creates a stable adapter contract and prevents duplicate submissions before introducing a new browser host. In parallel, keep Phase 2 as a small compatibility spike; do not begin a full session migration until the runtime choice has evidence.\n
