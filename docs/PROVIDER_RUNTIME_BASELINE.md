# Provider Runtime Readiness Baseline

**Recorded:** 2026-11-21  
**Repository baseline:** `27fba3b2fed2e33ae66e42a6a13a7bc78384a499`  
**Branch:** `main` (was synchronized with `origin/main` when this baseline was recorded)  
**Readiness:** **Not ready for new user-facing features**

This document records the current implementation and diagnostic evidence. It supersedes older audit claims only where it explicitly describes a current source or test observation; historical forensic artifacts remain preserved and are not treated as current implementation truth.

## Verified baseline

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

## Current integration observations

- The installed XPI in the user's Zen profile was version `0.2.0` (Manifest V2); the repository extension is version `0.3.0` (Manifest V2). The installed package is stale relative to the repository.
- The app's bridge token file was refreshed on 2026-11-21. The token value was not read or logged. The current extension does not automatically discover/retrieve a replacement pairing token.
- The isolated headless integration run installed extension `0.3.0` and established bridge pairing. Provider session inspection reported errors, and ChatGPT content-script ping did not respond. HTTP reachability checks returned ChatGPT 200, Qwen 200, and DeepSeek 403; HTTP reachability alone does not establish automation compatibility.
- A headful diagnostic attempt did not establish pairing in its temporary test environment and is inconclusive; its child process and temporary profile were cleaned up. Do not treat this as a confirmed product defect.
- The user's normal Zen profile and installed extension have not been modified. No real prompt was submitted to a user account during this diagnostic pass.

**Likely integration cause (not proven):** the stale installed XPI and changed pairing token explain why the user's current browser extension is not connected. Confirm only after a user-approved extension update and manual pairing.

## Confirmed source-level reliability findings

1. **Ambiguous send can cause duplicate submission — P0.** `zen-extension/content/automation.js` retries `form.requestSubmit()` when the first submission has no evidence within five seconds. Delayed DOM evidence can therefore trigger a second submission even if the provider accepted the first request.
2. **Prompt fill is not verified exactly — P1.** Current code checks only that composer text is non-empty, not that it equals the requested prompt.
3. **Response correlation is weak — P1.** Collection relies primarily on assistant-node count and the last visible assistant node; it does not establish a robust association with the current user prompt/task.
4. **Completion detection is weak — P1.** Qwen and DeepSeek rely substantially on text stability and absence of a visible stop control. Temporary pauses may be mistaken for completion; there is no distinct no-progress deadline.
5. **Authentication detection is weak — P1.** DeepSeek has no positive logged-out selectors; a visible composer with no detected login marker is treated as logged in. Similar absence-of-logout inference exists for other providers.
6. **Automation test coverage is insufficient — P0/P1.** Existing 53 tests cover security, bridge, IPC, task lifecycle, and cancellation, but do not directly exercise normal DOM send, send evidence, response correlation, or completion behavior.
7. **Windows token ACL is insufficient — P0 security.** On the inspected machine, the bridge-token file inherits a DACL that grants `Modify` to the local `CodexSandboxUsers` group, which contains separate service accounts. Node's `mode: 0o600` does not establish the intended Windows isolation. The token value was not read. Fix requires an explicit, narrowly scoped DACL strategy and startup verification; do not broadly rewrite the whole application-data ACL.

## Readiness blockers and required evidence

| Priority | Work | Exit evidence |
|---|---|---|
| P0 | Remove blind retry and introduce an explicit ambiguous-submission outcome | Deterministic regression test proves a single submit action when evidence is delayed or absent. |
| P0 | Harden Windows bridge-token DACL | ACL contains only the intended current-user/SYSTEM/Administrators principals; startup verification and tests cover the policy. |
| P0 | Establish a repeatable normal-send DOM test harness | Tests cover fill, single submit, delayed evidence, missing evidence, cancellation, and no duplicate send. |
| P1 | Verify exact composer contents | Whitespace-normalized exact prompt equality before submission. |
| P1 | Correlate responses to the current user turn | A stale/late prior response cannot satisfy a newer task. |
| P1 | Improve completion and no-progress detection | Provider-specific multi-signal completion tests; incomplete output remains partial/timeout. |
| P1 | Positive session-state evidence | Logged-in/guest/login-required states are based on positive provider signals, with unknown kept distinct. |
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
