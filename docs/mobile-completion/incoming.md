# External file handoff: isolated temporary workspace

## User-visible contract

- `attach-current` remains the default, including existing installs and unknown stored settings. The original attachment/composer workflow remains available.
- `temporary-workspace` is an explicit user choice: copy this incoming batch into its own directory, register it and create a distinct, blank session. Merely changing the preference creates nothing.
- This is conversation and current-working-directory separation, not a filesystem sandbox. No new permissions, prompt, automatic send or model invocation is performed.
- Original `uploads/chat-files/...` references stay intact. Those references, not the copied workspace paths, must be attached to the new composer; `chat_file_read` requires the original ChatFiles handle format.

## Native preference API

`com.dshphone.incoming.AndroidIncomingPreferences(context)` exposes `mode()` and `select(IncomingHandoffMode): Boolean`.
Modes have stored values `attach-current` and `temporary-workspace`. Reads never silently save/migrate. Failed Android `commit()` returns false and attempts to restore the previous process-visible choice; repeated underlying storage failure is not a disk-durability guarantee. Root owns the settings UI and snapshot passed to the handoff route.

## Peer integration

```js
import {applyIncomingWorkspaces} from './incoming-workspace/http.mjs';
const files = applyChatFiles(ctx); // keep the existing instance / original upload flow
if (role === 'phone') applyIncomingWorkspaces(ctx, files);
```

Required injected services: `sessions`, `sessionController`, `sessionPersistence`, `sessionQuery`, `workspaceRegistry` (plus existing `connection`, `webServer`, Cordis effect lifecycle).

Authenticated endpoint: `POST /phone-incoming-workspaces/manage`, own origin/Host `http://127.0.0.1:3080`, loopback, application/json, existing cookie admission. It rejects before any broker work on authentication/origin/method failure. Body <=64 KiB, receive timeout 10 seconds, at most 2 concurrent requests. Results are no-store.

```json
{"action":"open","mode":"temporary-workspace","batchId":"32 lowercase hexadecimal characters","files":["uploads/chat-files/original-id/content/example.txt"]}
```

Other actions: `prepare` with batchId/files, `commit`, `cancel`, `status` with batchId, and `sweep`. Envelope is `{ok:true,value:receipt}` or `{ok:false,error:string}`. An explicit `attach-current` open returns `{mode:"attach-current",useExistingComposer:true}` without creating/copying anything. Undefined or unknown modes are rejected, not interpreted as consent to temporary copying.

`IncomingWorkspaceBroker({home,files,services:incomingServices(ctx),now})` exposes the same methods for direct integration. Receipt includes batchId, state, workspacePath, workspaceId, sessionId when committed, verified copied file metadata and retention text. Maximum 16 files/temporary batch and 256 MiB/file; the old attach workflow is not constrained by this module.

## Public client navigation — required before inserting references

```js
import {installIncomingSessionBridge} from './incoming-workspace/client.mjs';
installIncomingSessionBridge(ctx);
await window.__dshPhoneOpenIncomingSession(receipt.sessionId);
```

The hook uses actual public `sessions.refresh()` followed by `uiWorkspace.openSession(sessionId)`; it accepts only this module's deterministic `session-incoming-<32hex>` IDs. A 15-second timeout, pagehide and context disposal prevent late navigation. Equal pending IDs coalesce; distinct simultaneous navigation is rejected. It neither attaches nor sends.

Root must wait for the exact `[data-conversation-session="<receipt.sessionId>"] [data-composer-card]` before emitting the existing `dsh:insert-file-references` event with the **original uploaded metadata**. Never use the first composer or a fallback to the previously selected chat. A navigation/attach failure is shown and retried with the same batch ID; it must not silently attach to the old chat.

## Source-backed core compatibility

- Published alpha.1: `sessionController.create({workspaceId,sessionId})` plus `workspaceRegistry.create(canonicalDirectory,title)` supplies registration and blank creation.
- Actual rc.2 changes create semantics: a named existing nonblank, archived or nonmember session may cause a new random ID. The adapter first adopts an already-existing exact ID with matching cwd, attaches it through the workspace service and flushes persistence; it does not call new-conversation creation again. Initial creation verifies the returned ID before recording success.
- Both versions use durable `sessionPersistence.flush()`. The broker records registration/creating state before creation; retry uses the deterministic identity. `connectWorkspace` / `startSession` are not used because they can reuse a different blank conversation.

Tests execute actual package SessionController create command and JSONL persistence for both versions with synthetic admission; they execute actual public openSession/replaceMain bodies against a synthetic selection/retained-reference fixture. This does not constitute a full Android UI acceptance run.

## Storage, cancellation and retention

Owned root: `<real DSH_HOME>/storage/incoming-workspaces`, with a newly created `.owner.json` marker and matching owner field in every batch manifest. A nonempty preexisting unmarked directory is never taken over. Only validated existing ChatFiles sources are copied; size and streaming SHA-256 are checked, and copied bytes are checked again. Manifest writes are atomic. Destination publication cannot replace an existing file. Symlinks, root/path escape, source mutation and unsupported handles fail closed. Original uploads are never deleted.

The batch state machine is `copying -> prepared -> creating-session -> session-created`; explicit cancellation yields `cancelled` before successful creation. Per-batch operations are serialized. Copy cancellation aborts its stream. Once a session exists, cancellation preserves its data. Retry after a completed batch returns the same identity without overwriting subsequent edits. If core creation became durable but its flush receipt failed, retention protection still keeps that session/cwd and retry recovers it; no compensating deletion of chats is attempted.

**Seven days is not a destructive conversation TTL.** `sweep()` cleans only module-owned expired abandoned/cancelled batches. It preserves any durable/live session, pinned or active session/task, registered workspace, raw-event reference, changed/unknown file, symlink, ownership mismatch, unreadable/incomplete protection snapshot, or ongoing incoming operation. Active/referenced committed conversations therefore remain indefinitely. No ordinary workspace, existing chat or original upload is swept. Unknown files are never recursively removed. Empty owned directories and manifest tombstones remain for safe idempotent status/retry behavior.

Cleanup is on-demand/opportunistic via `sweep`; this module installs no background timer. Root chooses an idle/startup/handoff invocation point. If reference inspection fails, cleanup skips rather than guessing. This conservative difference from the official destructive TTL is intentional to honor preservation of existing user data.

## Verification

Executed: 27 Node tests (broker, real HTTP fixtures, client contract/public-method fixtures, alpha.1 and rc.2 actual command/persistence adapters), all passing. Executed: 6 isolated Kotlin/JVM tests against Android 36 compile interfaces, all passing, including Android commit-failure process-map regression. No Gradle or device commands were run for this incoming module. Full MainActivity/native settings navigation, authenticated phone upload and exact-composer attachment remain root integration/device acceptance.

```sh
DSH_INCOMING_RC2_NODE_MODULES=/absolute/core-evaluation/node_modules node --test peer/incoming-workspace/*.test.mjs
```
