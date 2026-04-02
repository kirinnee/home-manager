# Gemini CLI Harness Support

## Summary

Add Gemini CLI (`gemini`) as a first-class harness type for kloop alongside the existing Claude Code harness.

The core design is:

- config remains string-authored, but is parsed into structured `{ binary, harness }` values before execution
- command construction becomes harness-aware
- Gemini stream events are normalized into kloop's existing internal event shapes
- kloop internal run IDs are separated from harness session IDs
- session control semantics are explicitly different between Claude and Gemini

This spec resolves the previously open questions and defines clear acceptance criteria.

## Motivation

- Cost diversity: Gemini offers free-tier and different pricing models
- Model diversity: Different reasoning patterns across LLM families
- Redundancy: If Claude API is down or rate-limited, Gemini can take over
- Already installed: `gemini` CLI v0.35.3 is in the nix profile

## Scope

In scope:

- multi-harness config parsing for implementers, reviewers, and conflict checker
- harness-aware command building for Claude and Gemini
- Gemini stream normalization for `kloop stream`
- Gemini token extraction support
- minimal log/view compatibility for Gemini-generated logs
- local `gemini-auto` wrapper packaging in this repo
- explicit Definition of Done

Out of scope:

- adding arbitrary new harness types beyond `claude` and `gemini`
- per-agent model override syntax in kloop config
- Gemini session resume across loop iterations
- changing overall loop, review, or verdict semantics
- replacing the external `claude-multi` wrapper system

## Design Principles

1. Backwards compatibility first. Existing Claude-only configs must continue to work unchanged.
2. Parse once, execute structurally. Raw config strings must not be passed directly into shell commands.
3. Keep the rest of kloop unchanged where practical, but not by hiding real incompatibilities.
4. Prefer deterministic behavior over clever implicit fallbacks.
5. Make Gemini support good enough for unattended loop usage, not feature-identical to Claude.

## Feature Parity Matrix

Tested with `gemini` CLI v0.35.3 on 2026-04-01.

| Capability           | Claude Code                      | Gemini CLI                         | Parity       | Decision                                           |
| -------------------- | -------------------------------- | ---------------------------------- | ------------ | -------------------------------------------------- |
| Non-interactive mode | `--print`                        | `-p`                               | ✅ Full      | Supported via harness-specific command builder     |
| Auto-approve tools   | `--dangerously-skip-permissions` | `--yolo`                           | ✅ Full      | Supported                                          |
| Stream JSON output   | `--output-format stream-json`    | `--output-format stream-json`      | ✅ Full      | Supported                                          |
| Session ID injection | `--session-id <uuid>`            | Not supported                      | ❌ Different | Claude injects harness session ID; Gemini does not |
| Session ID capture   | Returned/injected by CLI         | Emitted in `init` event            | ✅ Full      | kloop captures harness session ID after launch     |
| Session resumption   | `--session-id` reconnects        | `--resume latest` / indexed resume | ⚠️ Partial   | Not used by kloop in v1                            |
| Model selection      | `--model <model>`                | `-m <model>`                       | ⚠️ Partial   | Out of scope in v1                                 |
| Verbose output       | `--verbose`                      | `-d`                               | ⚠️ Partial   | Not required for headless mode                     |
| MCP support          | `--mcp-config`                   | Gemini MCP flags                   | ⚠️ Partial   | Out of scope in v1                                 |
| Token counting       | `result.*tokens`                 | `result.stats.*tokens`             | ✅ Full      | Supported via normalization/extraction             |
| Context file         | `CLAUDE.md`                      | `GEMINI.md`                        | ✅ Full      | Harness-native behavior                            |
| Stdin piping         | prompt over stdin                | supported, but not primary mode    | ⚠️ Partial   | v1 uses `-p` argument path                         |

## Stream JSON Event Comparison

### Claude Code Events

```jsonc
{"type":"system","subtype":"init","session_id":"...","tools":[...]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
{"type":"user","message":{"role":"user","content":"..."}}
{"type":"result","result":{"cost_usd":0.01,"duration_ms":5000,"session_id":"...","input_tokens":1000,"output_tokens":500}}
```

### Gemini CLI Events

```jsonc
{"type":"init","timestamp":"...","session_id":"...","model":"gemini-2.5-pro"}
{"type":"message","timestamp":"...","role":"user","content":"..."}
{"type":"message","timestamp":"...","role":"model","content":"..."}
{"type":"result","timestamp":"...","status":"success","stats":{"total_tokens":500,"input_tokens":200,"output_tokens":300,"duration_ms":3000}}
{"type":"result","timestamp":"...","status":"error","error":{"type":"Error","message":"..."},"stats":{...}}
```

### Normalization Rules

1. Gemini `type: "init"` maps to kloop `system` init semantics.
2. Gemini `type: "message", role: "model"` maps to kloop `assistant`.
3. Gemini `type: "message", role: "user"` maps to kloop `user`.
4. Gemini `type: "result", status: "success"` maps to kloop `result`.
5. Gemini `type: "result", status: "error"` maps to kloop `error`.
6. Gemini string content is normalized into Claude-style text content blocks where needed.
7. Gemini token stats are extracted from `stats.*`, not `usage.*`.
8. Session ID must be captured from Gemini `init` events, not assumed to appear in `result` events.
9. kloop must distinguish between its own internal run/session identifiers and harness-native session IDs.

## Config Format

### Current Format (Claude only)

```toml
implementers = { claude-auto-zai = 1 }
reviewPhases = [["claude-auto-zai:1", "claude-auto-mm:0"]]
conflictChecker = "claude-auto-zai"
```

### New Multi-Harness Format

```toml
implementers = { "claude-auto-zai:claude" = 1, "gemini-auto:gemini" = 1 }
reviewPhases = [["claude-auto-zai:claude:1", "gemini-auto:gemini:0"]]
conflictChecker = "gemini-auto:gemini"
```

### Notation

```text
binary:harness          implementers and conflictChecker
binary:harness:flag     reviewers only
```

Where:

- `binary` is the executable name or wrapper name
- `harness` is one of `claude` or `gemini`
- `flag` is reviewer-only:
  - `1` = no verdict counts as rejection
  - `0` = no verdict counts as approval

### Backwards Compatibility

These legacy forms remain valid:

- `claude-auto-zai` -> `binary=claude-auto-zai, harness=claude`
- `claude-auto-zai:1` -> `binary=claude-auto-zai, harness=claude, noVerdictAsFailure=true`
- `claude-auto-zai:0` -> `binary=claude-auto-zai, harness=claude, noVerdictAsFailure=false`

### Validation Rules

Accepted harness values:

- `claude`
- `gemini`

Invalid config examples that must fail fast with a clear error:

- `foo:bar:baz:1` -> too many segments
- `foo:unknown` -> invalid harness
- `foo:gemini:2` -> invalid reviewer flag
- empty binary segment

### Parsing Decision

`:` remains the separator in v1.

Constraint:

- user-authored binary names used in kloop config must not contain `:`

Rationale:

- this matches existing reviewer syntax
- it keeps the config compact
- it is acceptable for current Unix wrapper naming

If binary names with `:` are ever required in the future, config must move to a structured object format rather than extending this grammar.

## Internal Types

**File: `src/types.ts`**

```typescript
export type HarnessType = 'claude' | 'gemini';

export interface ParsedBinary {
  binary: string;
  harness: HarnessType;
}

export interface ReviewerBinary extends ParsedBinary {
  noVerdictAsFailure: boolean;
}
```

Required parser functions:

```typescript
parseHarness(value: string): HarnessType
parseImplementerConfig(entry: string): ParsedBinary
parseReviewerConfig(entry: string): ReviewerBinary
parseConflictCheckerConfig(entry: string): ParsedBinary
```

Session model requirements:

```typescript
interface AgentRunIdentity {
  internalSessionId: string; // kloop-generated ID for temp files, bookkeeping, and result correlation
  harnessSessionId?: string; // CLI-native session ID if exposed by the harness
}
```

Parsing requirements:

- `parseHarness()` must validate values explicitly
- no `as HarnessType` casts on unchecked user input
- parsers must return structured data or throw a descriptive config error
- raw config strings must not be used directly for command construction

## Command Construction

**File: `src/agents/runner.ts`**

Command building must be centralized in a harness-aware builder used by:

- implementer runs
- reviewer runs
- checkpoint/conflict-check runs

### Claude Command

Claude behavior remains unchanged:

```bash
cat "${promptFile}" | claude-auto-zai --dangerously-skip-permissions --verbose --print --session-id "${sessionId}" --output-format stream-json 2>&1 | tee "${logFile}" | kloop stream
```

### Gemini Command

Gemini behavior in v1:

```bash
gemini-auto --yolo --output-format stream-json -p "$(cat "${promptFile}")" 2>&1 | tee "${logFile}" | kloop stream
```

### Command Builder Decisions

1. kloop always generates its own `internalSessionId` for temp files, bookkeeping, and result correlation.
2. Claude receives that ID as the harness session ID via `--session-id`.
3. Gemini does not receive a session ID from kloop.
4. Gemini sessions always start fresh in v1.
5. kloop captures Gemini's emitted `session_id` from the `init` event and stores it as `harnessSessionId`.
6. Gemini session capture is part of normal stream processing; there is no start-stop-resume handshake in v1.
7. Gemini prompt delivery uses `-p` with file content expansion in v1.
8. `--yolo` is owned by kloop's command builder, not by the `gemini-auto` wrapper.
9. Wrappers may set environment or select accounts, but must not inject semantic CLI flags that kloop also manages.

### Why fresh Gemini sessions are acceptable in v1

- kloop's loop semantics do not require the harness-native session ID before process launch
- each iteration already materializes work into repo state and prompt files
- kloop already has its own internal identifiers for files, logs, and bookkeeping
- avoiding Gemini resume logic keeps behavior deterministic and implementation smaller
- resumption can be added later without breaking the config model

## Stream Normalization

**File: `src/stream/parse.ts`**

Normalization order matters.

Required behavior:

1. Handle Gemini `result status=error` before generic Gemini success result normalization.
2. Normalize Gemini `init` into kloop's `system` init-compatible shape.
3. Capture Gemini `init.session_id` as the run's `harnessSessionId` during normal stream processing.
4. Normalize Gemini `message role=model` into assistant messages with Claude-style content blocks.
5. Normalize Gemini `message role=user` into user messages.
6. Normalize Gemini `result status=success` into kloop result shape.
7. Preserve raw event fallback for unknown events.

Illustrative shape:

```typescript
function normalizeEvent(obj: unknown): StreamEvent {
  // existing Claude cases first

  // Gemini error result must come before generic result
  if (o.type === 'result' && o.status === 'error' && o.error) {
    return { type: 'error', error: { message: o.error.message } };
  }

  if (o.type === 'init' && o.session_id) {
    return {
      type: 'system',
      subtype: 'init',
      session_id: o.session_id,
      tools: [],
    } as StreamEvent;
  }

  if (o.type === 'message' && (o.role === 'model' || o.role === 'assistant')) {
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: typeof o.content === 'string' ? [{ type: 'text', text: o.content }] : o.content,
      },
    } as StreamEvent;
  }

  if (o.type === 'message' && o.role === 'user') {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: o.content,
      },
    } as StreamEvent;
  }

  if (o.type === 'result' && o.status === 'success' && o.stats) {
    return {
      type: 'result',
      result: {
        duration_ms: o.stats.duration_ms,
        input_tokens: o.stats.input_tokens,
        output_tokens: o.stats.output_tokens,
      },
    } as StreamEvent;
  }

  return { type: 'unknown', raw: obj };
}
```

## Token Extraction

**Files: `src/stream/parse.ts`, any downstream usage consumers**

This is not optional.

The earlier draft claimed normalization alone was enough. That is incorrect for the current codebase because token extraction currently reads Claude-shaped `usage.*` fields directly.

Required behavior:

- retain existing Claude token extraction
- add Gemini extraction from `stats.input_tokens`, `stats.output_tokens`, and optionally `stats.total_tokens`
- do not depend solely on normalized event output if token extraction still parses raw log lines independently

Acceptance rule:

- a successful Gemini run must contribute token counts to the same aggregate status/reporting flows that Claude uses today

## Event Identity and Status Materialization

Current status code keys reviewer identity by binary string.

Decision for v1:

- event payloads remain display-oriented and continue using the original configured reviewer token string for identity matching
- parsed harness metadata is used for execution, but a stable original identifier must still be available for status materialization and logs

Practical rule:

- if config entry is `gemini-auto:gemini:0`, the reviewer identity stored in review-phase and reviewer events should remain stable and unambiguous for matching
- implementation may use either:
  - original config token, or
  - a canonical composite key like `gemini-auto:gemini`
- but it must be consistent across phase start, reviewer start, reviewer result, and materialization lookup

Non-goal for v1:

- redesigning all event schemas to store separate `binary` and `harness` fields everywhere

## Wrapper Binaries

### Decision

Use a local nix-packaged `gemini-auto` wrapper in this repo.

Rationale:

- there is no equivalent local multi-account Gemini wrapper system in this repo today
- kloop only needs a stable executable name
- wrapper behavior can stay minimal and deterministic

### Wrapper Responsibilities

Allowed responsibilities:

- select the right base executable
- set required environment variables
- select account/profile if needed

Not allowed:

- injecting `--yolo`
- injecting `--output-format stream-json`
- injecting prompt flags
- injecting model flags

Those flags are owned by kloop so behavior stays explicit and testable.

## Prompt Delivery Decision

Decision for v1:

- use `-p "$(cat \"${promptFile}\")"`

Rationale:

- simplest path consistent with the tested Gemini CLI behavior in this spec
- prompt files already exist in the runner
- no extra stdin-composition logic is required

Risk:

- very large prompts may hit shell argument length limits

Mitigation in v1:

- document the limitation
- treat argument-length failure as a known limitation, not an unsupported silent truncation path

Deferred improvement:

- if prompt size becomes a real issue, switch Gemini command building to stdin-based delivery in a later change without changing config syntax

## Model Selection

Decision for v1:

- no per-binary or per-config model override syntax

Rationale:

- wrapper naming and environment already provide a practical place to encode model choice
- adding model selection into kloop config now would expand the grammar and validation surface unnecessarily

Examples:

- `gemini-auto` may target the default model configured by environment
- a future `gemini-flash-auto` wrapper can represent a different model without changing kloop config grammar

## Config Defaults

No default config change is required.

Existing defaults remain valid because bare names still imply the Claude harness.

Example:

```toml
reviewPhases = [["claude-reviewer-zai"]]
```

continues to behave as Claude.

## Files to Change

| File                   | Required change                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `src/types.ts`         | add `HarnessType`, parsed binary types, explicit parser/validator functions         |
| `src/agents/runner.ts` | centralize harness-aware command building for implementer/reviewer/checkpointer     |
| `src/stream/parse.ts`  | add Gemini normalization and Gemini token extraction support                        |
| `src/cli/view.ts`      | ensure Gemini-normalized init/result logs render correctly when viewing stored logs |
| `src/stream/format.ts` | only adjust if normalization alone is insufficient                                  |
| `modules/default.nix`  | add local `gemini-auto` wrapper package                                             |
| `home-template.nix`    | install `gemini-auto` in `home.packages` if required by current packaging flow      |

## Session Identity Semantics

kloop must treat these as separate concepts:

- `internalSessionId`: kloop-generated identifier used for prompt temp files, result correlation, and any internal bookkeeping
- `harnessSessionId`: session identifier emitted or accepted by the underlying agent CLI

Harness-specific behavior:

- Claude: `harnessSessionId === internalSessionId` because kloop injects it
- Gemini: `harnessSessionId` is unknown at launch and becomes known only after parsing the `init` event

Implementation rule:

- no code path may assume that `harnessSessionId` is known before process start for all harnesses
- no code path may require a start-stop-resume handshake merely to obtain Gemini's session ID

## Functional Definition of Done

The work is functionally complete only if all of the following are true:

### Config parsing

- [ ] Existing Claude-only configs still parse unchanged
- [ ] `binary:harness` works for implementers
- [ ] `binary:harness:flag` works for reviewers
- [ ] `conflictChecker` accepts `binary:harness`
- [ ] invalid harness names fail with a clear error
- [ ] invalid reviewer flags fail with a clear error
- [ ] malformed colon-separated config entries fail with a clear error

### Command execution

- [ ] Claude commands are unchanged in behavior
- [ ] Gemini implementers can run successfully in headless mode
- [ ] Gemini reviewers can run successfully in headless mode
- [ ] Gemini conflict checker can run successfully in headless mode
- [ ] Gemini runs do not attempt `--session-id` injection
- [ ] Gemini runs include `--yolo` and `--output-format stream-json`
- [ ] Gemini `init` events populate `harnessSessionId` without requiring a second launch

### Stream/log behavior

- [ ] `kloop stream` displays Gemini assistant output during live execution
- [ ] Gemini success results are recognized as results, not unknown events
- [ ] Gemini failures are recognized as errors, not successful results
- [ ] Gemini init events surface a session ID into logs/state

### Status/token accounting

- [ ] Gemini runs produce token counts in the same aggregate reporting paths as Claude runs
- [ ] Gemini runs do not break status materialization for phased reviews
- [ ] mixed Claude+Gemini reviewer phases work correctly

### Packaging

- [ ] `gemini-auto` is available as an executable after home-manager activation
- [ ] wrapper does not duplicate semantic flags managed by kloop

## Non-Functional Definition of Done

The work is non-functionally complete only if all of the following are true:

### Backwards compatibility

- [ ] no existing Claude config needs migration
- [ ] no existing Claude loop behavior regresses
- [ ] old reviewer syntax `binary:0|1` still works

### Maintainability

- [ ] harness-specific logic is centralized, not scattered through three separate command call sites
- [ ] user input validation is explicit and does not rely on unchecked type assertions
- [ ] wrapper responsibilities and runner responsibilities are clearly separated

### Observability

- [ ] Gemini logs are inspectable with existing kloop log/view workflows
- [ ] harness-emitted session IDs are retained where useful for debugging without conflating them with kloop internal IDs
- [ ] failure modes from malformed config are actionable

### Simplicity

- [ ] no new config grammar beyond `binary:harness` and `binary:harness:flag`
- [ ] no session resume support is added speculatively
- [ ] no per-model config syntax is added speculatively

## Test Scenarios

At minimum, validate these scenarios:

1. Claude-only legacy config still runs.
2. Gemini-only implementer config runs.
3. Mixed Claude/Gemini reviewer phase runs.
4. Gemini reviewer with `:0` and `:1` semantics behaves correctly.
5. Gemini result success line contributes tokens.
6. Gemini result error line is surfaced as an error.
7. Invalid harness in config fails before execution.
8. Invalid reviewer flag fails before execution.
9. Conflict checker using Gemini runs successfully.

## Known Limitations in v1

- Gemini sessions are fresh per run; kloop does not resume them across iterations.
- Prompt delivery for Gemini may fail for very large prompts because v1 uses shell argument expansion.
- Per-config model override syntax is intentionally unsupported.
- MCP parity is intentionally out of scope.

## Future Extensions

Potential follow-up work, explicitly deferred from this spec:

- stdin-based Gemini prompt delivery for very large prompts
- per-wrapper or per-config model selection
- richer event schemas carrying both binary and harness metadata everywhere
- Gemini session resume support if it proves useful in practice
