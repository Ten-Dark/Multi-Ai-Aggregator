# Cancellation Protocol

Status: Stages 1–5 implemented; full regression and packaged verification remain
Scope: Electron Renderer, Main Process, Zen WebSocket Bridge, Zen Extension  
Compatibility: additive protocol revision; no change to authentication or extension-origin pinning
Protocol baseline: Zen Extension 0.3.0 introduced task-correlated send responses and cancellation. The current extension source version is defined by `zen-extension/manifest.json`.

## 1. Goals and invariants

Implement cooperative cancellation for:
- one model request;
- an entire batch request.

The protocol must guarantee:

1. Cancellation is idempotent. Repeating it does not create a second terminal result.
2. Main Process is the authority for task lifecycle and terminal-state arbitration.
3. A task reaches exactly one terminal state: `done`, `error`, or `cancelled`.
4. A response/progress event received after cancellation cannot overwrite the terminal state.
5. Batch cancellation affects only tasks belonging to that batch that are still active.
6. Already completed model results are preserved when the rest of a batch is cancelled.
7. Cancellation is cooperative: it stops automation and response collection, but cannot retract a prompt already submitted to a remote AI service.
8. Disconnect, timeout, and application shutdown settle pending operations; no task remains indefinitely active.
9. Existing pairing token, origin pinning, WebSocket payload limit, and trusted IPC sender checks remain in force.

## 2. Identifiers and ownership

Main creates cryptographically random UUID v4 identifiers before dispatching work.

- Single model request: Main generates its task ID.
- Batch: Main generates a batch ID and a distinct task ID for each model.
- Renderer receives identifiers through validated model events and uses them only to request cancellation.

Main owns:
- active task registry;
- batch-to-task membership;
- task state and terminal arbitration;
- pending WebSocket command correlation;
- cancellation acknowledgement timeout.

Extension owns:
- active automation controller per task ID;
- mapping from task ID to target tab;
- cancellation of in-flight DOM automation;
- bounded recent-task history for duplicate, cancelled, and already-finished IDs.

Renderer owns presentation only. It may request cancellation but must not mark a task cancelled before Main confirms the transition through a validated event/result.

## 3. State model

Task states:

```text
queued -> opening -> sending -> waiting -> done
   |         |          |         |
   +---------+----------+---------+-> cancelling -> cancelled
   +-----------------------------------------------> error
```

- `cancelling` is non-terminal and shown while cancellation is being acknowledged.
- `cancelled` is terminal and distinct from `error`.
- `done` or `error` wins if Main has already committed that terminal state before the cancellation request is processed.
- Once Main transitions a task to `cancelling`, later success/error responses for that task are ignored, except a bounded cancellation acknowledgement used to settle the cancel request.
- If the extension is disconnected while cancellation is pending, Main finalizes the task as `cancelled` locally with a reason indicating that remote acknowledgement was unavailable. The automation may continue until the extension/browser itself stops; UI must not claim that remote execution was confirmed stopped.

Batch state is derived:
- active while any child task is active;
- completed when all children are terminal;
- cancelled when cancellation was requested and all remaining active children have settled as cancelled (completed/error children remain unchanged);
- partially completed when the batch has a mixture of done/error/cancelled results.

## 4. WebSocket protocol

All messages retain the existing JSON envelope and command ID correlation.

### Main -> Extension

Start command adds a required task identifier:

```json
{
  "type": "command",
  "id": "bridge-command-id",
  "action": "send",
  "payload": {
    "taskId": "opaque-task-id",
    "batchId": "opaque-batch-id",
    "model": "chatgpt",
    "prompt": "...",
    "timeoutMs": 240000,
    "purpose": "answer"
  }
}
```

Cancellation is a normal correlated command:

```json
{
  "type": "command",
  "id": "bridge-command-id",
  "action": "cancelTask",
  "payload": { "taskId": "opaque-task-id" }
}
```

The extension returns an ordinary successful response after the matching automation controller has been aborted and its tab message handler has settled:

```json
{
  "type": "response",
  "id": "bridge-command-id",
  "ok": true,
  "data": { "taskId": "opaque-task-id", "cancelled": true }
}
```

If the task is already absent, cancellation succeeds idempotently with `cancelled: true`. If it already completed, return `cancelled: false` and `reason: "already-finished"`.

Progress messages add `taskId`; Main validates it and verifies that the task is still active before emitting a model event.

Task result responses include `taskId` in the data envelope. Bridge command IDs and task IDs serve different purposes: command IDs correlate one WebSocket request/response; task IDs identify the long-running automation lifecycle.

## 5. Extension cancellation mechanics

Background script maintains `activeTasks: Map<taskId, { model, tabId, controller, startedAt }>`.

On `send`:
1. Validate task ID, model, prompt, timeout and purpose.
2. Reject duplicate active task IDs.
3. Create an AbortController and register the task before dispatching to the tab.
4. Pass task ID to the content script.
5. Remove the task from the map in `finally`.

On WebSocket disconnect:
- send `mai:cancel` to each active task's tab when available;
- abort each background controller so local orchestration settles;
- treat the disconnect as an unconfirmed remote stop, not proof that the AI service stopped generating.

On `cancelTask`:
1. Validate task ID.
2. Find the active task.
3. Send `mai:cancel` to the matching content script with the same task ID.
4. Await its acknowledgement (bounded).
5. Abort the background task signal and await task settlement (bounded).
6. Return an idempotent cancellation result.

Content script maintains `activeRuns`, a bounded finished-task history, and bounded cancellation-before-start tombstones. A cancel arriving before its matching send prevents that send from starting. Cancellation checks are inserted at asynchronous boundaries and polling loops:
- wait for composer;
- consent dismissal;
- composer fill and send evidence;
- wait for answer;
- retry/reload waits.

The delay helper becomes abort-aware. DOM waits accept an AbortSignal and reject with a typed `cancelled` error. Event listeners and timers must be cleaned up in `finally`.

Do not close the tab or clear the composer as a cancellation side effect. If the prompt was already submitted, the remote service may continue generating; the extension only stops local orchestration and response collection.

## 6. Main Process behavior

Maintain a task registry, e.g. `Map<TaskId, ActiveTask>`, with:
- task ID, optional batch ID, model, kind;
- lifecycle state;
- WebSocket start command ID;
- cancellation command ID/promise;
- terminal result, if any.

Start:
- register task before sending the WebSocket command;
- reject duplicate IDs and conflicting active operations;
- attach task ID to all progress and result events.

Cancel one:
- atomically transition active task to `cancelling`;
- emit `cancelling` immediately;
- send `cancelTask` to Extension;
- finalize as `cancelled` when acknowledged;
- use a short bounded grace period; on timeout/disconnect finalize locally as cancelled with an unconfirmed-stop reason;
- ignore any later start response/progress for that task.

Cancel batch:
- atomically mark the batch cancellation requested;
- snapshot active child task IDs;
- request cancellation for each active child concurrently;
- do not alter terminal children;
- resolve only after all active children have settled or hit the cancellation grace timeout.

Race arbitration must be synchronous in Main before awaiting IPC/WebSocket:
- if task is already terminal, cancellation is a no-op;
- if cancellation transitions first, success/error from the original send is ignored;
- if result transitions terminal first, cancellation returns already-finished.

On WebSocket disconnect, reject pending bridge commands as today and settle active task records. No pending map entry or timer may leak.

## 7. IPC and shared types

Add:
- `TaskStatus: 'cancelling' | 'cancelled'`;
- `TaskErrorCode: 'cancelled'` for a cooperative cancellation returned by the Extension;
- optional `taskId` and `batchId` on task events/results;
- a typed cancellation event or model event carrying the new task status;
- `cancelTask(taskId)` and `cancelBatch(batchId)` to AggregatorApi.

`cancelTask` returns `accepted`, `status`, and `confirmed`. A cancelled task with
`confirmed: false` means Main closed the local operation after timeout/disconnect;
it does not prove that remote automation stopped.

IPC handlers must use the existing trusted-sender assertion and strict ID validation. Preload must validate the new task statuses, IDs and cancellation event payloads. Do not expose the raw WebSocket bridge or arbitrary command dispatch to Renderer.

## 8. Renderer behavior

- Read task and batch IDs from Main Process model events.
- Use task and batch IDs from the latest model results when requesting cancellation; Main remains the lifecycle authority.
- Show a Cancel button while a task/batch is active.
- For a batch, show one Cancel all action and preserve per-model terminal results.
- For a single model retry, show cancellation on that model only.
- During `cancelling`, disable duplicate send/retry/synthesis actions and show “Отменяю…”.
- Show “Отменено” for `cancelled`; do not display it as an error.
- A cancelled partial response may be retained as text with an explicit “Ответ прерван” note, but must never be presented as a completed answer.
- Late results are ignored by task ID, not merely by comparing timestamps.
- On unmount, do not silently cancel work unless product behavior explicitly chooses that policy. Window close remains handled by Main shutdown.

## 9. Security and validation

- IDs: bounded ASCII UUID format; reject empty, oversized or malformed values.
- Extension validates every action and payload independently; never trust Renderer validation.
- Bridge validates task IDs and verifies task/model ownership before accepting progress/results.
- A cancel request may target only a task registered by the current Main process.
- Unknown or stale cancellation IDs are handled idempotently without exposing internal state.
- Keep the existing WebSocket authentication and origin checks unchanged.
- Add message-size and schema tests for all new message shapes.

## 10. Test plan

### Shared protocol and Main
- malformed/oversized task IDs rejected;
- duplicate task ID rejected;
- cancel before start response;
- result wins immediately before cancel;
- cancel wins immediately before late success;
- late progress and duplicate responses ignored;
- repeated cancellation is idempotent;
- batch cancellation preserves already completed models;
- batch cancellation waits for all active children;
- disconnect while cancelling settles all tasks;
- cancellation timeout does not leak timers or pending commands.

### Extension background
- cancel active task sends tab cancellation and awaits acknowledgement;
- cancel unknown/already-finished task is idempotent;
- duplicate task ID rejected;
- task registry cleaned after success, failure and cancellation;
- old socket cannot send task results after reconnection.

### Content script
- cancellation during composer wait;
- cancellation during send-evidence wait;
- cancellation during answer wait;
- listeners/timers removed after cancellation;
- cancellation after remote submit does not trigger another submit or erase the prompt.

### Renderer / preload
- cancel one model leaves other batch tasks running;
- cancel batch preserves completed responses;
- late event from previous operation cannot overwrite a newer retry;
- cancelled is not counted as an error or successful answer;
- unsubscribe prevents post-unmount updates;
- preload rejects malformed cancellation events.

## 11. Implementation sequence

1. Shared types, ID validation, protocol schema and deterministic unit tests. (Complete.)
2. Main task registry, terminal arbitration, cancellation commands and IPC surface. (Complete.)
3. Extension background task registry and cancellation routing. (Complete.)
4. Content-script AbortSignal support and cancellation checkpoints. (Complete.)
5. Renderer controls, state presentation and stale-event protection. (Complete.)
6. Full regression: typecheck, all security/integration tests, packaging, packaged smoke test.

Each stage is committed separately with Conventional Commits. Do not push unless explicitly requested.
