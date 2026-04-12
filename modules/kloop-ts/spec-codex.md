# Codex CLI Harness Support

## Summary

Add OpenAI Codex CLI (`codex`) as a first-class harness type for kloop alongside Claude and Gemini.

This spec extends the multi-harness design established in `spec.md` (Gemini) with Codex-specific event normalization, command construction, and session identity semantics.

## Motivation

- Cost diversity: Codex CLI uses OpenAI models (o4-mini, gpt-4.1, etc.) with different pricing
- Model diversity: OpenAI reasoning models have different strengths than Claude and Gemini
- Redundancy: Third harness provider reduces dependency on any single vendor's API availability
- Already installed: `codex` CLI is available via `npm install -g @openai/codex`

## Scope

In scope:

- `codex` harness type in config parsing
- harness-aware command building for Codex
- Codex JSONL stream normalization for `kloop stream`
- Codex token extraction support
- log/view compatibility for Codex-generated logs
- explicit Definition of Done

Wrapper packaging is handled by `home-manager-modules.multi-codex` — no wrapper changes in this repo.

Out of scope:

- per-agent model override syntax (use wrapper naming like `codex-auto-o4mini`)
- Codex session resume across loop iterations
- changing overall loop, review, or verdict semantics
- Codex sandbox mode configuration

## Design Principles

1. **Extends existing patterns.** This spec follows the same structure as the Gemini harness spec (`spec.md`).
2. **Parse once, execute structurally.** Raw config strings are never passed directly into shell commands.
3. **JSONL, not JSON.** Codex outputs newline-delimited JSON (JSONL), one event per line — compatible with kloop's existing line-by-line stream processing.
4. **Multi-event session lifecycle.** A single Codex session emits `thread.started`, multiple `turn.*` events, and multiple `item.*` events. Normalization must aggregate these into kloop's simpler event model.
5. **Ephemeral by default.** Codex sessions in kloop use `--ephemeral` to avoid polluting local session storage.

## Feature Parity Matrix

Tested with `codex` CLI (openai/codex) on 2026-04-12.

| Capability           | Claude Code                      | Gemini CLI                     | Codex CLI                   | Parity       | Decision                                             |
| -------------------- | -------------------------------- | ------------------------------ | --------------------------- | ------------ | ---------------------------------------------------- |
| Non-interactive mode | `--print`                        | `-p`                           | `exec` subcommand           | ✅ Full      | Uses `codex exec`                                    |
| Auto-approve tools   | `--dangerously-skip-permissions` | `--yolo`                       | `--full-auto` / `yolo`      | ✅ Full      | Uses `--full-auto`                                   |
| Stream JSON output   | `--output-format stream-json`    | `--output-format stream-json`  | `--json`                    | ✅ Full      | Uses `--json`                                        |
| Session ID injection | `--session-id <uuid>`            | Not supported                  | Not supported               | ❌ Different | Codex does not support external session ID injection |
| Session ID capture   | Returned/injected by CLI         | Emitted in `init` event        | Emitted in `thread.started` | ✅ Full      | kloop captures `thread.started.thread_id`            |
| Session persistence  | `--session-id` reconnects        | `--resume latest`              | `--ephemeral` disables      | ⚠️ Partial   | kloop uses `--ephemeral` for clean runs              |
| Model selection      | `--model <model>`                | `-m <model>`                   | `--model <model>`           | ⚠️ Partial   | Out of scope in v1 (use wrapper naming)              |
| Verbose output       | `--verbose`                      | `-d`                           | `--verbose`                 | ⚠️ Partial   | Not required for headless mode                       |
| MCP support          | `--mcp-config`                   | Gemini MCP flags               | `--mcp-config`              | ⚠️ Partial   | Out of scope in v1                                   |
| Token counting       | `result.*tokens`                 | `result.stats.*tokens`         | `turn.completed.usage.*`    | ✅ Full      | Extracted from turn-level usage, aggregated          |
| Context file         | `CLAUDE.md`                      | `GEMINI.md`                    | `AGENTS.md` / `CLAUDE.md`   | ✅ Full      | Harness-native behavior                              |
| Stdin piping         | prompt over stdin                | `-p` flag (v1 uses stdin pipe) | prompt over stdin           | ✅ Full      | kloop pipes prompt via stdin                         |
| Sandbox mode         | N/A                              | N/A                            | `--sandbox none`            | ⚠️ Partial   | Not required for headless mode                       |
| Provider selection   | N/A                              | N/A                            | Not exposed via CLI         | ⚠️ Partial   | Out of scope (use wrapper + env vars)                |

## Stream JSONL Event Comparison

### Codex CLI Events (JSONL)

```jsonc
// Session start
{"type":"thread.started","thread_id":"thread_abc123","created_at":1234567890}

// Turn lifecycle
{"type":"turn.started","turn_id":0}
{"type":"item.started","item_id":"msg_001","type":"agent_message"}
{"type":"item.updated","item_id":"msg_001","type":"agent_message","content":"thinking..."}
{"type":"item.completed","item_id":"msg_001","type":"agent_message","content":"final content"}
{"type":"item.started","item_id":"call_001","type":"tool_call","name":"bash","arguments":"..."}
{"type":"item.completed","item_id":"call_001","type":"tool_call","name":"bash","arguments":"...","output":"..."}
{"type":"turn.completed","turn_id":0,"usage":{"input_tokens":1000,"output_tokens":500,"total_tokens":1500}}

// Error case
{"type":"turn.failed","turn_id":0,"error":{"type":"Error","message":"API rate limited"}}
```

### Normalization Rules

1. Codex `type: "thread.started"` maps to kloop `system` init semantics. `thread_id` becomes `session_id`.
2. Codex `type: "item.started/updated", item.type: "agent_message"` with `content` maps to kloop `assistant` (streaming text). Only final content (`item.completed`) is emitted as a full assistant message; intermediate `item.updated` events are suppressed to avoid duplicate text.
3. Codex `type: "item.started/updated/completed", item.type: "tool_call"` maps to kloop `assistant` tool_use blocks.
4. Codex `type: "item.completed", item.type: "tool_call"` with `output` maps to kloop `tool_result` blocks.
5. Codex `type: "turn.completed"` with `usage` maps to kloop `result` with token extraction.
6. Codex `type: "turn.failed"` with `error` maps to kloop `error`.
7. Codex `type: "item.started/updated/completed"` events that are not `agent_message` or `tool_call` are preserved as `unknown`.
8. Token extraction reads from `turn.completed.usage.input_tokens` and `turn.completed.usage.output_tokens`.
9. If multiple `turn.completed` events exist (unlikely in single-prompt mode), the last one wins.
10. Session ID is captured from `thread.started.thread_id`.

## Config Format

No change to config grammar. Codex follows the same `binary:harness` notation established by Gemini.

### Examples

```toml
# Codex-only implementer
implementers = { "codex-personal:codex" = 1 }

# Mixed Claude + Codex reviewers
reviewPhases = [["claude-reviewer:claude:1", "codex-personal:codex:0"]]

# Codex conflict checker
conflictChecker = "codex-personal:codex"

# Legacy Claude-only configs remain valid
implementers = { claude-auto-zai = 1 }
```

### Config Parsing

The existing `parseHarness()` validator must accept `'codex'` as a valid harness type:

```typescript
export type HarnessType = 'claude' | 'gemini' | 'codex';
```

All existing parsing functions (`parseImplementerConfig`, `parseReviewerConfig`, `parseConflictCheckerConfig`) work unchanged because they delegate to `parseHarness()`.

### Validation Rules

New accepted harness values:

- `codex` — OpenAI Codex CLI

Existing rules remain unchanged:

- `foo:bar:baz:1` -> too many segments
- `foo:unknown` -> invalid harness
- `foo:codex:2` -> invalid reviewer flag

## Command Construction

**File: `src/agents/runner.ts`**

### Codex Command

```bash
cat "${promptFile}" | codex-personal exec --full-auto --json --ephemeral 2>&1 | tee "${logFile}" | kloop stream
```

### Command Builder Extension

The `buildAgentCommand()` function gains a `codex` branch:

```typescript
if (harness === 'claude') {
  // existing Claude command
} else if (harness === 'codex') {
  // Codex: exec subcommand, --full-auto, --json, --ephemeral, stdin prompt
  return `cat "${promptFile}" | ${binary} exec --full-auto --json --ephemeral 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
} else {
  // Gemini: existing fallback
}
```

### Command Builder Decisions

1. kloop always generates its own `internalSessionId` for temp files, bookkeeping, and result correlation.
2. Claude receives that ID as the harness session ID via `--session-id`.
3. Gemini does not receive a session ID from kloop.
4. **Codex does not receive a session ID from kloop.** Codex generates its own `thread_id`.
5. kloop captures Codex's `thread.started.thread_id` and stores it as `harnessSessionId`.
6. `--full-auto` is owned by kloop's command builder, not by the `codex-auto` wrapper.
7. `--json` is owned by kloop's command builder, not by the wrapper.
8. `--ephemeral` is owned by kloop's command builder to avoid polluting local Codex session storage.
9. Prompt delivery uses stdin piping (consistent with Claude's existing approach and Codex's native stdin support).
10. Codex uses the `exec` subcommand for non-interactive headless execution.

### Why `--ephemeral`

- Codex by default persists session state locally
- kloop manages its own session lifecycle via `internalSessionId`
- persisted Codex sessions would accumulate without cleanup
- `--ephemeral` keeps each run clean and deterministic

## Stream Normalization

**File: `src/stream/parse.ts`**

### Normalization Order

The `normalizeEvent()` function must handle Codex events. Codex normalization is added after Gemini normalization in the existing function. The order matters:

1. Claude events first (unchanged)
2. Gemini error result (unchanged)
3. Gemini init, message, result (unchanged)
4. **Codex error: `turn.failed`** — maps to kloop `error`
5. **Codex session start: `thread.started`** — maps to kloop `system/init`
6. **Codex assistant message: `item.completed` with `type: "agent_message"`** — maps to kloop `assistant`
7. **Codex turn result: `turn.completed`** — maps to kloop `result`
8. Unknown fallback (unchanged)

### Illustrative Shape

```typescript
// === Codex error: turn failed ===
if (o.type === 'turn.failed' && o.error) {
  const error = o.error as { message?: string };
  return { type: 'error', error: { message: error.message ?? 'Unknown error' } };
}

// === Codex session start -> system init ===
if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
  return {
    type: 'system',
    subtype: 'init',
    session_id: o.thread_id,
    tools: [],
  };
}

// === Codex assistant message (final only) -> assistant ===
if (o.type === 'item.completed' && o.item_type === 'agent_message' && o.content) {
  return {
    type: 'assistant',
    message: {
      content: typeof o.content === 'string' ? [{ type: 'text', text: o.content }] : o.content,
    },
  };
}

// === Codex turn result -> result ===
if (o.type === 'turn.completed' && o.usage) {
  const usage = o.usage as Record<string, unknown>;
  return {
    type: 'result',
    result: {
      duration_ms: o.duration_ms as number | undefined,
      input_tokens: usage.input_tokens as number | undefined,
      output_tokens: usage.output_tokens as number | undefined,
    },
  };
}
```

### Intermediate Event Suppression

Codex emits multiple events per turn (`item.started`, `item.updated`, `item.completed`). To avoid flooding kloop's stream with duplicate assistant text:

- `item.started` with `type: "agent_message"` is suppressed (no content yet)
- `item.updated` with `type: "agent_message"` is suppressed (intermediate content)
- `item.completed` with `type: "agent_message"` is the only one normalized to kloop `assistant`
- `item.started/completed` with `type: "tool_call"` are normalized to `assistant` tool_use blocks

This suppression happens naturally because `normalizeEvent()` only matches `item.completed` for assistant messages. The other `item.*` events fall through to `unknown`, which is fine — they remain in the raw log but don't generate spurious kloop events.

## Token Extraction

**File: `src/stream/parse.ts`**

### Extraction from Log Files

The `extractTokensFromContent()` function must handle Codex's token format in addition to Claude and Gemini:

```typescript
// Inside the result-type scanning loop:

// Codex token format: turn.completed event with usage.*
// This is a separate pass because Codex turn.completed has type: "turn.completed",
// not type: "result"
if (parsed.type === 'turn.completed' && parsed.usage) {
  const usage = parsed.usage;
  if (typeof usage.input_tokens === 'number' && result.inputTokens === undefined) {
    result.inputTokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number' && result.outputTokens === undefined) {
    result.outputTokens = usage.output_tokens;
  }
}
```

### Extraction from Harness Session ID

The `extractHarnessSessionIdFromContent()` function must handle Codex's session format:

```typescript
// Inside the scanning loop:

// Codex session ID: thread.started event with thread_id
if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
  return parsed.thread_id;
}
```

### Acceptance Rule

A successful Codex run must contribute token counts to the same aggregate status/reporting flows that Claude and Gemini use today.

## Event Identity and Status Materialization

No change to the existing approach. Codex events follow the same identity/materialization rules established by the Gemini spec:

- event payloads continue using the original configured reviewer token string for identity matching
- parsed harness metadata is used for execution
- a stable original identifier is used for status materialization and logs
- if config entry is `codex-personal:codex:0`, the reviewer identity remains stable across phase start, reviewer start, reviewer result, and materialization lookup

## Session Identity Semantics

kloop treats these as separate concepts (consistent with Gemini):

- `internalSessionId`: kloop-generated identifier for temp files, result correlation, and bookkeeping
- `harnessSessionId`: Codex's `thread.started.thread_id`

Harness-specific behavior:

- Claude: `harnessSessionId === internalSessionId` because kloop injects it
- Gemini: `harnessSessionId` captured from `init.session_id` event
- **Codex: `harnessSessionId` captured from `thread.started.thread_id` event**

Implementation rule (consistent with existing harnesses):

- no code path may assume that `harnessSessionId` is known before process start
- the Codex harness session ID becomes known only after parsing the `thread.started` event

## Wrapper Binary

### Decision

Use wrappers generated by `home-manager-modules.multi-codex`. These already produce account-specific wrapper binaries (e.g., `codex-personal`, `codex-mm`) that set environment variables for API keys and model defaults.

### Wrapper Responsibilities (managed by multi-codex module)

Allowed:

- select the right base executable
- set required environment variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, etc.)
- set model defaults via environment if needed

Not allowed (enforced by kloop's command builder):

- injecting `--full-auto`
- injecting `--json`
- injecting `--ephemeral`
- injecting `exec`
- injecting prompt flags
- injecting model flags

## Prompt Delivery Decision

Decision for v1:

- use stdin piping: `cat "${promptFile}" | codex-auto exec --full-auto --json --ephemeral`

Rationale:

- Codex natively supports stdin prompt delivery
- consistent with Claude's existing stdin approach
- no shell argument length limit issues (unlike Gemini's `-p` flag)
- `--ephemeral` ensures clean session lifecycle

## Model Selection

Decision for v1:

- no per-config model override syntax (consistent with Claude and Gemini)

Examples:

- `codex-auto` may use the default model configured by environment
- a future `codex-auto-o4mini` wrapper can target a specific model
- model can also be set via `OPENAI_MODEL` environment variable in the wrapper

## Files to Change

| File                   | Required change                                                           |
| ---------------------- | ------------------------------------------------------------------------- |
| `src/types.ts`         | add `'codex'` to `HarnessType` union; update `parseHarness()` error msg   |
| `src/agents/runner.ts` | add `codex` branch to `buildAgentCommand()`                               |
| `src/stream/parse.ts`  | add Codex normalization cases to `normalizeEvent()`                       |
| `src/stream/parse.ts`  | add Codex token extraction to `extractTokensFromContent()`                |
| `src/stream/parse.ts`  | add Codex session ID extraction to `extractHarnessSessionIdFromContent()` |

No changes needed:

- `src/cli/view.ts` — harness-agnostic log viewer, no harness-specific code paths
- `src/stream/format.ts` — harness-agnostic stream formatter
- `src/cli/shared.ts` — the `harness !== 'claude'` check at line 13 works correctly for codex (shows `binary:codex`)
- `src/cli/status.ts` — same `harness !== 'claude'` check at line 18, works correctly
- `default.nix` — wrapper packaging is handled by `home-manager-modules.multi-codex` (generates `codex-personal`, `codex-mm`, etc.)
- `loop/runner.ts` — the `[['claude-auto-zai']]` fallback strings are default config values, not harness-type logic

## Implementation Steps

### Step 1: Add `'codex'` to HarnessType — `src/types.ts`

- Line 260: `'claude' | 'gemini'` → `'claude' | 'gemini' | 'codex'`
- Line 285-289: Update `parseHarness()` to accept `'codex'` and update the error message to list all three

### Step 2: Add Codex command branch — `src/agents/runner.ts`

- Lines 102-118: In `buildAgentCommand()`, change the `else` (Gemini fallback) to `else if (harness === 'gemini')` and add a `codex` case:
  ```typescript
  } else if (harness === 'codex') {
    return `cat "${promptFile}" | ${binary} exec --full-auto --json --ephemeral 2>&1 | tee "${logFile}" | ${KLOOP_BIN} stream`;
  } else {
    // Gemini fallback
  ```

### Step 3: Add Codex stream normalization — `src/stream/parse.ts`

Add four normalization cases to `normalizeEvent()` after the Gemini cases (before the `unknown` fallback):

1. `turn.failed` with `error` → kloop `error`
2. `thread.started` with `thread_id` → kloop `system` init
3. `item.completed` with `item_type === 'agent_message'` → kloop `assistant`
4. `turn.completed` with `usage` → kloop `result`

### Step 4: Add Codex token extraction — `src/stream/parse.ts`

- In `extractTokensFromContent()`: add scan for `type === 'turn.completed'` with `usage.input_tokens` / `usage.output_tokens`
- In `extractHarnessSessionIdFromContent()`: add scan for `type === 'thread.started'` with `thread_id`

### Step 5: Add test cases — `src/index.test.ts`

Add to the `::i implementer suffix parsing` describe block:

- `parseImplementerConfig('codex-personal:codex')` returns `{ binary: 'codex-personal', harness: 'codex', firstIterationPreferred: false }`
- `parseImplementerConfig('codex-personal:codex::i')` returns `{ binary: 'codex-personal', harness: 'codex', firstIterationPreferred: true }`

### Verification

1. `direnv exec . bun run check` — type check + tests pass

## Functional Definition of Done

### Config parsing

- [ ] Existing Claude-only configs still parse unchanged
- [ ] Existing Gemini configs still parse unchanged
- [ ] `binary:codex` works for implementers
- [ ] `binary:codex:flag` works for reviewers
- [ ] `conflictChecker` accepts `binary:codex`
- [ ] invalid harness names fail with a clear error
- [ ] invalid reviewer flags fail with a clear error
- [ ] malformed colon-separated config entries fail with a clear error

### Command execution

- [ ] Claude commands are unchanged in behavior
- [ ] Gemini commands are unchanged in behavior
- [ ] Codex implementers can run successfully in headless mode
- [ ] Codex reviewers can run successfully in headless mode
- [ ] Codex conflict checker can run successfully in headless mode
- [ ] Codex runs use `exec` subcommand
- [ ] Codex runs include `--full-auto`, `--json`, and `--ephemeral`
- [ ] Codex runs do not attempt `--session-id` injection
- [ ] Codex `thread.started` events populate `harnessSessionId` without requiring a second launch

### Stream/log behavior

- [ ] `kloop stream` displays Codex assistant output during live execution
- [ ] Codex `item.completed agent_message` events are recognized as assistant messages
- [ ] Codex `item.started/updated` events are suppressed (no duplicate text)
- [ ] Codex `turn.completed` events are recognized as results
- [ ] Codex `turn.failed` events are recognized as errors
- [ ] Codex `thread.started` events surface a session ID into logs/state

### Status/token accounting

- [ ] Codex runs produce token counts in the same aggregate reporting paths as Claude and Gemini runs
- [ ] Codex runs do not break status materialization for phased reviews
- [ ] mixed Claude+Gemini+Codex reviewer phases work correctly

### Packaging

- [ ] Codex wrapper binaries (e.g., `codex-personal`) are available via `home-manager-modules.multi-codex`
- [ ] wrappers do not duplicate semantic flags managed by kloop

## Non-Functional Definition of Done

### Backwards compatibility

- [ ] no existing Claude or Gemini config needs migration
- [ ] no existing Claude or Gemini loop behavior regresses
- [ ] old reviewer syntax `binary:0|1` still works
- [ ] old reviewer syntax `binary:harness:0|1` still works

### Maintainability

- [ ] harness-specific logic is centralized in `buildAgentCommand()` and `normalizeEvent()`
- [ ] user input validation is explicit (no unchecked type assertions)
- [ ] wrapper responsibilities and runner responsibilities are clearly separated

### Observability

- [ ] Codex logs are inspectable with existing kloop log/view workflows
- [ ] harness-emitted session IDs (thread_id) are retained for debugging
- [ ] failure modes from malformed config are actionable

### Simplicity

- [ ] no new config grammar
- [ ] no session resume support added speculatively
- [ ] no per-model config syntax added speculatively

## Test Scenarios

At minimum, validate these scenarios (in addition to existing Claude/Gemini scenarios):

1. Codex-only implementer config runs.
2. Mixed Claude/Gemini/Codex reviewer phase runs.
3. Codex reviewer with `:0` and `:1` semantics behaves correctly.
4. Codex `turn.completed` contributes tokens.
5. Codex `turn.failed` is surfaced as an error.
6. Codex `thread.started` captures harness session ID.
7. Invalid harness in config fails before execution (already tested for Claude/Gemini).
8. Conflict checker using Codex runs successfully.
9. `--ephemeral` flag is present in Codex commands.

## Known Limitations in v1

- Codex sessions are ephemeral; kloop does not persist or resume them across iterations.
- No per-config model override syntax.
- MCP parity is intentionally out of scope.
- Codex sandbox mode configuration is out of scope.
- Intermediate `item.started`/`item.updated` events from Codex are not normalized (they fall through to `unknown` in the log but don't affect kloop event processing).

## Future Extensions

Potential follow-up work, explicitly deferred:

- per-wrapper model selection via dedicated wrapper names
- Codex sandbox mode configuration if needed for security isolation
- richer event schemas carrying both binary and harness metadata everywhere
- Codex session resume support if it proves useful in practice
