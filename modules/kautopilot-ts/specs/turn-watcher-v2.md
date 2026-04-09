# Turn Watcher v2 — Cursor-Based Forward Scan with Interactive Tool Awareness

## Problem Statement

The current `turn-watcher.ts` uses a **level-triggered backwards scan**: on every file change, it re-reads the entire JSONL, walks backwards, and finds the last `assistant`/`user` entry. This approach has multiple accuracy bugs:

1. **`queue-operation:enqueue` is invisible** — when the user submits a message, a `queue-operation { operation: "enqueue" }` line appears BEFORE the `user` entry. The watcher only looks for `type: "assistant"` / `type: "user"`, so it still says "user's turn" during the gap between submission and the `user` entry being written.

2. **Interactive tools are invisible** — tools like `AskUserQuestion`, `EnterPlanMode`, and `ExitPlanMode` require human interaction. When Claude calls `AskUserQuestion`, it's the **user's turn** to answer. When Claude calls `ExitPlanMode`, it's the **user's turn** to approve. The current code treats ALL `stop_reason: "tool_use"` as "LLM's turn", which is wrong for interactive tools.

3. **Permission-mode approval is invisible** — in non-`bypassPermissions` mode, any `tool_use` means Claude is waiting for the user to approve the tool. The watcher says "LLM's turn" regardless.

4. **`stop_reason: null` intermediate streaming chunks** are conflated with actual state — an `assistant` entry with `stop_reason: null` and `content: [{ type: "thinking" }]` is a streaming intermediate, not a final state. The current code happens to work (null !== "end_turn") but the semantics are fragile.

5. **Tool-result `user` entries vs human `user` entries** are indistinguishable to the watcher — both set `userTurn: false`, but they represent different flows: a `user` with `toolUseResult` is an automated tool result returning to the LLM, while a `user` with `permissionMode` is a human message.

## Real Data Evidence

From production JSONL files (April 2026):

### AskUserQuestion (63s human wait, watcher says "LLM's turn")

```
19: assistant:tool_use  tools=[AskUserQuestion]  ts=19:01:12
20: user [tool-result]                            ts=19:02:01   ← 63s later, user answering
```

### ExitPlanMode (617s human wait, watcher says "LLM's turn")

```
132: assistant:tool_use  tools=[ExitPlanMode]  ts=21:07:38
133: user [tool-result]                          ts=21:17:56   ← 10 minutes later, user approving
```

### Queue operation gap (watcher still says "user's turn")

```
937: assistant:end_turn     ts=05:20:11
938: queue-operation        ts=05:20:11   ← user submitted, but watcher sees no "user" entry yet
939: progress               ts=05:19:18   ← out-of-order hook progress
940: user                   ts=05:20:11   ← watcher finally sees "user"
```

## Solution: Cursor-Based Forward State Machine

### Core changes

1. **Cursor tracking** — remember how many lines have been processed. On each `fs.watch` callback, only process newly appended lines (from cursor forward). No more re-reading the entire file.

2. **State machine** — maintain explicit turn state instead of deriving it from the last entry. Process entries forward in order, applying transitions.

3. **Interactive tool classification** — when `stop_reason: "tool_use"`, check the tool name. Interactive tools → user's turn. Automated tools in `bypassPermissions` → LLM's turn. Any tool in non-`bypassPermissions` → user's turn (approval needed).

### States

```
user_turn         — Waiting for human input
llm_thinking      — LLM is generating a response (streaming/thinking)
llm_executing     — LLM is executing automated tools (reading files, running bash, etc.)
user_interactive  — LLM asked a question or needs approval (AskUserQuestion, ExitPlanMode, permission prompt)
```

For the binary `userTurn` output: `user_turn` and `user_interactive` → `true`; `llm_thinking` and `llm_executing` → `false`.

### Interactive tools (always require human input regardless of permission mode)

```typescript
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
```

### Transition table

| Entry                                                                                         | Fields checked                                           | Current state → New state                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `user` (no `toolUseResult`, has `permissionMode`)                                             | `permissionMode`                                         | any → `llm_thinking`                                                                                    |
| `user` (has `toolUseResult`)                                                                  | `toolUseResult`                                          | `user_interactive` → `user_interactive` (stay), `llm_executing` → `llm_thinking`, else → `llm_thinking` |
| `assistant` (`stop_reason: null`)                                                             | streaming intermediate                                   | no state change (still `llm_thinking`)                                                                  |
| `assistant` (`stop_reason: "tool_use"`, tool in `INTERACTIVE_TOOLS`)                          | tool name from `content[].name`                          | any → `user_interactive`                                                                                |
| `assistant` (`stop_reason: "tool_use"`, tool NOT in `INTERACTIVE_TOOLS`, `bypassPermissions`) | tool name, `permissionMode` from last human `user` entry | any → `llm_executing`                                                                                   |
| `assistant` (`stop_reason: "tool_use"`, tool NOT in `INTERACTIVE_TOOLS`, non-bypass)          | tool name, permission mode                               | any → `user_interactive` (approval needed)                                                              |
| `assistant` (`stop_reason: "end_turn"`)                                                       |                                                          | any → `user_turn`                                                                                       |
| `queue-operation` (`operation: "enqueue"`)                                                    | `operation`                                              | `user_turn` → `llm_thinking`                                                                            |
| `queue-operation` (`operation: "dequeue"`)                                                    |                                                          | no change                                                                                               |
| `system`                                                                                      |                                                          | no change                                                                                               |
| `progress`                                                                                    |                                                          | no change                                                                                               |
| `file-history-snapshot`                                                                       |                                                          | no change                                                                                               |
| `last-prompt`                                                                                 |                                                          | no change                                                                                               |
| `custom-title` / `agent-name`                                                                 |                                                          | no change                                                                                               |

### Permission mode tracking

The `permissionMode` field only appears on human `user` entries (those with `permissionMode` key, no `toolUseResult`). Track the most recent one as part of the state machine context:

```typescript
interface TurnState {
  userTurn: boolean;
  ts: string;
  state: TurnStateMachine['state']; // optional: expose internal state for debugging
}

interface TurnMachineContext {
  cursor: number; // lines processed
  state: 'user_turn' | 'llm_thinking' | 'llm_executing' | 'user_interactive';
  permissionMode: string | null; // from last human user entry
  lastSize: number; // for file-growth check optimization
}
```

## Implementation Plan

### 1. Replace `watchTurn` internals

File: `src/core/turn-watcher.ts`

- Add `INTERACTIVE_TOOLS` constant
- Add `TurnMachineContext` type
- Replace the `check()` function:
  - Read only newly appended lines (from `context.cursor` to end)
  - Parse each new line forward, applying transitions to `context.state`
  - Track `permissionMode` from human `user` entries
  - For `assistant:tool_use`, extract tool names from `content` array
  - After processing new lines, call `onChange` with derived `userTurn` + `ts`
- The `onChange` callback type stays the same: `(state: TurnState) => void`
- `startTurnWatcher` stays the same

### 2. Update `TurnState` interface

```typescript
interface TurnState {
  userTurn: boolean;
  ts: string;
}
```

Keep the same interface — downstream code (`updateUserTurn`, CLI display) only needs the boolean. The internal state machine state is implementation detail.

### 3. Handle edge cases

- **File doesn't exist yet**: Same exponential backoff polling as current implementation.
- **File truncated/replaced**: If `stat.size < lastSize`, reset cursor to 0 and re-process entire file.
- **Non-JSON lines**: Skip as before.
- **Multiple tool_use in one assistant entry**: Some entries have `content: [{ type: "tool_use", name: "Read" }, { type: "tool_use", name: "Write" }]`. If ANY tool is interactive, treat as `user_interactive`.
- **`assistant` entry without `message`**: Skip (malformed entry).

### 4. Tests

Create `src/core/turn-watcher.test.ts` with a pure state machine function (extracted from the I/O) for deterministic testing:

```
describe('turn state machine', () => {
  - Simple user → LLM → user cycle
  - Tool use (bypassPermissions) → llm_executing → tool result → llm_thinking
  - AskUserQuestion → user_interactive → tool result → llm_thinking
  - ExitPlanMode → user_interactive → tool result → llm_thinking
  - EnterPlanMode → user_interactive → tool result → llm_thinking
  - Non-bypass permission mode → tool_use → user_interactive (approval)
  - queue-operation:enqueue → llm_thinking
  - Multiple tool_use with one interactive → user_interactive
  - Streaming intermediates (stop_reason: null) → no state change
  - File growth detection (cursor-based incremental)
})
```

Extract the state machine logic into a pure function:

```typescript
function processEntry(ctx: TurnMachineContext, entry: ParsedEntry): TurnMachineContext;
```

This can be tested without touching the filesystem.

## Non-goals

- **Predicting "user is typing"** — no signal available in the JSONL for this.
- **Sub-agent turn tracking** — sub-agents write to separate JSONL files under `subagents/`. The watcher watches the parent file. This is orthogonal and can be added later.
- **Changing `updateUserTurn` or `SessionStatus`** — the `userTurn: boolean | null` field in status.yaml is sufficient. The new states (`llm_executing`, `user_interactive`) are internal to the watcher and map to the same boolean.
