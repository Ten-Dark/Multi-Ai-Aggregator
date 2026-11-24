# Provider Runtime Readiness Baseline

**Recorded:** 2026-11-21  
**Repository baseline:** `27fba3b2fed2e33ae66e42a6a13a7bc78384a499`  
**Branch:** `main` (was synchronized with `origin/main` when this baseline was recorded)  
**Readiness:** **Not ready for new user-facing features**

## Latest repository verification — 2026-11-24

This section supersedes the earlier repository-layout and validation observations below. It does not supersede the live-provider E2E limitations or the no-go decision.

### Gordon audit remediation — 2026-11-24

- **Cancellation race fixed:** `TaskRegistry.setStatus()` now rejects progress updates while a task is `cancelling`; terminal states already reject updates. A failed cancellation can still restore the captured pre-cancellation state.
- **Regression coverage:** the WebSocket lifecycle test injects a late `waiting` progress event after cancellation begins and again after cancellation is confirmed, then injects a late successful response. The task remains `cancelled` and the late response is ignored.
- **Partial response contract rechecked:** bridge errors preserve partial text with `status: 'error'` and `partial: true`; the response card labels it as incomplete, and synthesis receives the text with the explicit error `ответ не завершён`. The audit wording that it is simply treated as a complete `received` result is not supported by the current code.
- **Extension-origin policy rechecked:** a candidate origin is persisted only after a valid pairing-token comparison. A different valid extension origin can be rebound after successful pairing, supporting extension reinstall/profile migration. The existing security-origin tests cover this behavior; no code change was made.
- **CI added:** `.github/workflows/ci.yml` runs on pushes to branches and pull requests; it performs typecheck, the full automated test suite, and extension build. The release workflow remains tag-triggered.
- **Dependency audit rechecked:** `npm audit --omit=dev` reports zero vulnerabilities. Full `npm audit` reports six moderate dependency-path findings; the affected installed `minimatch` is `10.2.6`, and npm proposes downgrading `electron-builder` from `26.18.0` to `25.1.0` as a semver-major change. This downgrade was not applied without compatibility validation.

| Check | Result | Notes |
|---|---|---|
| Latest code-bearing commit | `74eeca46f6d47d773b9ca76660da13746a5afb3b` | Cancellation-state guard, regression coverage, and branch/PR CI. |
| `npm run dist` | PASS | Windows NSIS installer rebuilt and copied to the project root. |
| `npm run typecheck` | PASS | TypeScript compilation succeeds. |
| `npm run test:security` | PASS | **113/113 tests passed** on 2026-11-24. |
| `npm run build:extension` | PASS | Zen extension `0.3.9`; XPI created under `artifacts/build/zen-extension/`. |
| `npm run release:metadata` | PASS | Generated update manifest parses as valid JSON; generated staging files were removed after verification. |
| `npm audit --omit=dev` | PASS | **0 production vulnerabilities**. |
| `npm audit` | WARN | Six moderate findings remain in development tooling (`electron-builder` / `@electron/universal` / `minimatch`); no automatic or breaking fix was applied. |
| Live diagnostic harnesses | PASS | `e2e-send.mjs` and `integration-zen.mjs` now require explicit profile/live-test flags, redact prompt/response output, and avoid screenshots of conversation content; guard paths and syntax checks passed without launching either harness. |
| Live environment snapshot | PARTIAL | Zen Browser processes are running. The app was launched once by the failed diagnostic guard-check and closed after session inspection timed out before `SEND_STARTED`; no real provider prompt was submitted. A pending local bridge-token migration may have occurred. |
| CI workflow | PASS (configuration added) | `.github/workflows/ci.yml` runs on all branch pushes and pull requests; hosted execution will be confirmed by GitHub Actions after push. |
| Real authenticated provider E2E | NOT VERIFIED | Requires user-controlled extension installation/pairing and manual validation of each provider in the active Zen profile. |

The no-go decision for new user-facing features remains in force until the live-provider readiness blockers below are closed. Deterministic tests and package builds do not replace real authenticated provider E2E. No Zen profile or installed extension was directly modified. Because the app was launched once during the failed diagnostic preflight, a pending local bridge-token migration may have occurred; verify the displayed pairing code and extension connection before relying on the existing pairing.

The repository organization cleanup was committed and pushed as `929fdf5`. Historical audit and forensic reports that were previously untracked remain local-only and were deliberately not added to the public repository.

This document records the current implementation and diagnostic evidence. It supersedes older audit claims only where it explicitly describes a current source or test observation; historical forensic artifacts remain preserved and are not treated as current implementation truth.


## Historical verified baseline — 2026-11-21

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | PASS | TypeScript compilation succeeds. |
| `npm run test:security` | PASS | 53/53 tests passed at the recorded baseline. |
| `npm audit --omit=dev` | PASS | No production dependency vulnerabilities reported. |
| `npm audit` | WARN | Six moderate findings in the development dependency chain (`electron-builder` / `@electron/universal` / `minimatch`). Do not use `npm audit fix --force`; assess compatible upgrades separately. |
| `git diff --check` | PASS | No whitespace errors at the recorded baseline. |
| `npm run pack` | PASS | Directory package build completed. |
| `node scripts/smoke-packaged.mjs` | PASS WITH LIMITATION | Packaged app starts; provider states remain unavailable because no extension pairing is active in the smoke environment. This is not a provider E2E pass. |
| `HEAD` vs `origin/main` | PASS | Both pointed to `27fba3b2fed2e33ae66e42a6a13a7bc78384a499`. |
| CI workflow | GAP | No tracked workflow exists under `.github/workflows`. |

Build metadata warnings about missing author and application icon are non-blocking for the current reliability work.

## Remediation update

After recording the initial baseline, the first reliability slice was implemented:

- The content script now invokes the provider submit action at most once per task attempt. If send evidence does not arrive within the observation window, it returns the explicit `submission-unknown` outcome and instructs the user to inspect the provider tab; it does not call `requestSubmit()` again.
- Prompt contents are compared with the original request before submission (line endings and non-breaking spaces are normalized; other content differences are rejected).
- A shared extension helper is loaded before the automation content script.
- New deterministic tests cover delayed evidence, absent evidence, submit-action failure, prompt equality, and the existing cancellation-after-submit path.
- The Windows token-storage remediation was implemented and exercised on Windows using isolated temporary directories:
  - Bridge token and approved extension-origin files now live under `userData/zen-secure/`, not directly in the broadly inherited application-data directory.
  - The directory receives a protected DACL granting Full Control only to the current process user SID, SYSTEM, and built-in Administrators. The token file receives a matching protected DACL. The code reads the resulting ACL back and fails closed if unexpected or missing rules are present.
  - Non-Windows systems use `0700` for the directory and `0600` for files.
- The old `userData/zen-bridge-token` is rotated and removed only after the new token file is created and its ACL is verified. This invalidates the old extension pairing; the user will need to paste the new pairing code after launching the updated app.
- Windows tests verify the DACL in a temporary directory and verify bridge migration/rotation against a temporary user-data directory.
- Response collection now requires a newly added assistant node to appear after the latest user message, whose normalized text must exactly match the current prompt. A delayed answer that appears before the current prompt in DOM order is ignored.
- Separate provider no-progress deadlines were added (35 seconds for Qwen; 45 seconds for ChatGPT and DeepSeek). A stalled response is classified as timeout/partial rather than silently treated as complete.
- Selector provenance is provisional: Qwen's `.user-message-content` is based on community DOM observations ([reference](https://greasyfork.org/en/scripts/588050-qwen-chat-markdown-latex-renderer-user-messages)); DeepSeek's `div.fbb737a4` is based on a community live-DOM capture ([reference](https://github.com/NIyueeE/deepseek-user-message-renderer)). These are not official provider contracts and require validation in the authenticated Zen profile.
- Session inspection no longer labels a visible composer as `logged-in` by default. It requires a positive profile indicator, returns `unknown` when evidence is inconclusive, and treats an explicit login control as `guest` or `login-required` according to provider policy. DeepSeek's positive profile selectors are provisional community-observed selectors and still require live-profile validation.
- A reproducible `npm run build:extension` command builds `artifacts/build/zen-extension/multi-ai-aggregator-zen-<version>.xpi`, extracts it into a temporary directory, and checks its manifest and required content scripts. The XPI build passed for version `0.3.0`; the output directory was later standardized under `artifacts/build/zen-extension/`.
- Latest validation: `npm run test:security` **PASS, 67/67**; `npm run typecheck` **PASS**; `npm run pack` **PASS** (latest Electron package build before the session-indicator-only change); `npm run build:extension` **PASS** (XPI `0.3.0`); `npm audit --omit=dev` **0 vulnerabilities**; `git diff --check` **PASS**.
- Full `npm audit` still reports six moderate development-toolchain findings in `electron-builder` / `@electron/universal` / `minimatch`; the available automatic fix requires a breaking `electron-builder` downgrade and was not applied.
- The packaged smoke script was not run after this change because it launches against the real Windows user-data directory and would rotate the active local pairing token. Actual profile migration is pending the next launch of the updated app; the isolated Windows migration test passes.

This closes the blind-retry defect, exact-fill check, and implements Windows token ACL hardening. It does not establish response correlation, completion correctness, or real-provider E2E readiness.

## Current integration observations

- The installed XPI in the user's Zen profile was version `0.2.0` (Manifest V2); the repository extension is version `0.3.0` (Manifest V2). The installed package is stale relative to the repository.
- The app's bridge token file was refreshed on 2026-11-21. The token value was not read or logged. The current extension does not automatically discover/retrieve a replacement pairing token.
- The isolated headless integration run installed extension `0.3.0` and established bridge pairing. Provider session inspection reported errors, and ChatGPT content-script ping did not respond. HTTP reachability checks returned ChatGPT 200, Qwen 200, and DeepSeek 403; HTTP reachability alone does not establish automation compatibility.
- A headful diagnostic attempt did not establish pairing in its temporary test environment and is inconclusive; its child process and temporary profile were cleaned up. Do not treat this as a confirmed product defect.
- The user's normal Zen profile and installed extension have not been modified. No real prompt was submitted to a user account during this diagnostic pass.

**Likely integration cause (not proven):** the stale installed XPI and changed pairing token explain why the user's current browser extension is not connected. Confirm only after a user-approved extension update and manual pairing.

## Confirmed source-level reliability findings

1. **Response correlation requires live-provider validation — P1.** Prompt matching and DOM-order correlation are implemented and stale-response regression-tested, but Qwen/DeepSeek selectors come from community observations and are not yet verified against the user's authenticated Zen pages.
2. **Completion detection still needs provider E2E — P1.** Separate no-progress deadlines are implemented, but completion still combines provider stop controls, response stability, and the ChatGPT completion attribute; each provider's behavior must be validated against real streaming sessions.
3. **Authentication selector validation remains open — P1.** The false-positive `logged-in` fallback is removed and inconclusive states remain `unknown`. Provider profile/login selectors have not yet been validated against all authenticated pages in the user's Zen profile.

## Readiness blockers and required evidence

| Priority | Work | Exit evidence |
|---|---|---|
| P0 | Remove blind retry and introduce an explicit ambiguous-submission outcome | **Implemented and tested**; one submit action is asserted for delayed and absent evidence. |
| P0 | Harden Windows bridge-token DACL | **Implemented and verified in isolated Windows tests.** Actual user profile migration occurs on next launch and requires extension re-pairing. |
| P0 | Establish a repeatable normal-send DOM test harness | Tests cover fill, single submit, delayed evidence, missing evidence, cancellation, and no duplicate send. |
| P1 | Verify exact composer contents | **Implemented and tested**; line endings and NBSP normalized, all other text differences rejected. |
| P1 | Correlate responses to the current user turn | **Implemented and regression-tested for DOM ordering.** Real Qwen/DeepSeek selector validation remains pending. |
| P1 | Improve completion and no-progress detection | **No-progress deadlines implemented.** Provider-specific multi-signal completion tests remain pending. |
| P1 | Positive session-state evidence | **Conservative unknown state implemented and unit-tested.** Live validation of profile/login selectors for all providers remains pending. |
| P1 | Extension distribution and pairing workflow | Reproducible XPI build/version check and documented user-controlled update/pairing steps. |
| P1 | Real authenticated E2E | User-approved pairing and manual verification for each supported provider; report each provider separately. |

## Safety and repository handling

- Never read, print, commit, or place pairing tokens, cookies, passwords, prompts, or provider responses in diagnostic artifacts.
- Do not modify the user's normal Zen profile or installed XPI without explicit approval.
- Preserve untracked forensic/audit artifacts. They are not part of this report and must not be staged or deleted implicitly.
- Stage only explicitly named files; never use `git add .` or `git add -A` for this repository.
- Keep the existing cancellation protocol and Main-owned task-state arbitration intact.

## Go/no-go decision

**No-go for new feature development.** Continue with reliability and local security remediation first. A successful typecheck/package build or isolated bridge handshake is not sufficient to declare provider automation ready. Reassess only after the P0/P1 exit evidence above is collected, followed by real authenticated E2E for each provider.
