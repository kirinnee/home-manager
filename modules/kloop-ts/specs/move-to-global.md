# Spec: Remove Persisted Session JSON

## Overview

Persisted session JSON under `.kagent/current/sessions/{id}.json` is legacy state and is not part of the live kloop execution path. Rather than moving these files into `~/.kloop/{runId}/...`, remove persisted session JSON entirely.

Runtime session identifiers still matter and must stay:

- `sessionId` — internal per-agent run ID used for prompt temp files and Claude `--session-id`
- `tmuxSession` — tmux session name used for launch/attach/kill/logging
- `harnessSessionId` — harness-native session/thread ID extracted from logs/events

This change removes only **on-disk session persistence**. It does **not** remove runtime session identifiers.

## Problem

- `.kagent/current/sessions/` is legacy local state
- Session persistence is inconsistent: only implementer, reviewer, and checkpointer write session JSON today; verifier, synthesizer, and re-synthesizer do not
- Persisted sessions are only consumed by the legacy `loadSessions()` → `buildSummary()` path in `state/service.ts`
- The live runner path does not use persisted sessions; it builds history directly with `summary: []` in `src/loop/runner.ts`
- Moving dead session files into the global store would preserve and expand unused state instead of removing it

## Design

### No session files anywhere

Do not move session JSON into `~/.kloop/`.

Do not add a new `agentSessionFile(...)` path helper.

After this change, kloop should write:

- prompts
- logs
- verdicts
- reviews
- summaries
- checkpoint results
- event log / materialized status

But **not** `session.json` files.

### Keep runtime session identifiers

`AgentRunner` should continue to use and return runtime identifiers:

- `sessionId`
- `tmuxSession`
- `harnessSessionId`

These are still needed for harness integration and runtime metadata.

Examples:

- Claude still receives `--session-id "${sessionId}"`
- `tmuxSession` is still used by tmux launch and attach flows
- `harnessSessionId` is still extracted from logs and returned in result objects

### Remove persisted session objects from AgentRunner

In `src/agents/runner.ts`, remove the pattern of building a `Session` object and calling `this.state.saveSession(...)`.

Affected methods:

- `runImplementer()`
- `runReviewer()`
- `runCheckpointer()`

Instead:

- keep `sessionId` and `tmuxSession` as local variables
- compute `harnessSessionId` as a local variable after parsing the log
- return `harnessSessionId` in the result object as today
- do not write a session JSON file

Verifier / synthesizer / re-synthesizer already behave this way and need no persistence change.

### Remove legacy session persistence APIs

Remove from `src/deps.ts`:

- `Session` import from `./types`
- `sessionsDir: string` from `Paths`
- `sessionFile: (sessionId: string) => string` from `Paths`
- `saveSession(session: Session): Promise<void>` from `StateService`
- `loadSessions(): Promise<Session[]>` from `StateService`
- `SESSIONS_DIR` const
- `sessionsDir` and `sessionFile` from the default `paths` object

Remove from `src/state/service.ts`:

- `mkdir(this.paths.sessionsDir)` from `createRun()`
- `saveSession()`
- `loadSessions()`
- `buildSummary()`

### Remove dead archive entrypoints tied to persisted sessions

`completeRun()` is dead and only delegates to `archiveRun()`.

Because persisted sessions are being removed and the live runner already constructs its own history entry, remove from `src/state/service.ts`:

- `completeRun()`
- `archiveRun()`

And remove from `src/deps.ts`:

- `completeRun(...)` from `StateService`
- `archiveRun(...)` from `StateService`

This spec does **not** attempt a broader cleanup of the remaining legacy local history APIs beyond these dead entrypoints.

### Remove session-only types

Remove from `src/types.ts`:

- `sessionStatusSchema`
- `sessionSchema`
- `Session` type export
- `parseSession()`

Do **not** remove runtime result fields such as `sessionId`, `tmuxSession`, or `harnessSessionId` from agent result interfaces.

## Non-Goals

- Do not create new `session.json` files under `~/.kloop/`
- Do not remove runtime `sessionId` / `tmuxSession` / `harnessSessionId`
- Do not change event log or materialized status behavior
- Do not redesign loop summaries or history entry shape in this change

## Files Modified

| File                   | Changes                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/runner.ts` | Remove `Session` object construction and `state.saveSession()` calls from implementer / reviewer / checkpointer paths; keep runtime IDs in result objects |
| `src/deps.ts`          | Remove `Session` import, `sessionsDir`, `sessionFile`, `saveSession`, `loadSessions`, `completeRun`, `archiveRun`, and legacy sessions path constants     |
| `src/state/service.ts` | Remove sessions dir creation, `saveSession`, `loadSessions`, `buildSummary`, `completeRun`, and `archiveRun`                                              |
| `src/types.ts`         | Remove `sessionStatusSchema`, `sessionSchema`, `Session`, and `parseSession`                                                                              |

## Verification

```bash
direnv exec . rtk tsc --noEmit
direnv exec . rtk bun test
```
