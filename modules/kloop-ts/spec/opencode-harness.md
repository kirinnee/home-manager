# OpenCode CLI Harness Support

## Summary

Add OpenCode CLI (`opencode`) as a first-class harness type for kloop alongside the existing Claude Code and Gemini harnesses, with support for environment-based model selection.

The core additions are:

- a new `opencode` harness type with its own command construction and stream normalization
- environment-aware wrapper packaging that controls which provider/model combination is used
- stream event normalization from opencode's step-based JSON format into kloop's existing internal event shapes
- token extraction from opencode's `step_finish` events

This spec follows the patterns established by the Gemini integration spec.

## Motivation

- Model diversity: OpenCode supports multiple providers (OpenAI, DeepSeek, Groq, OpenRouter) through a single CLI
- Environment-based model control: different wrappers can target different providers/models via environment variables without changing kloop config
- Cost optimization: can target cheaper models (GPT-5-nano, DeepSeek) for review phases
- Already installed: `opencode` CLI v1.3.17 is in the nix profile

## Scope

In scope:

- `opencode` as a new `HarnessType` value
- harness-aware command building for opencode
- opencode stream event normalization for `kloop stream`
- opencode token extraction from `step_finish` events
- per-environment wrapper packaging (`opencode-auto`, `opencode-gpt53-codex`, etc.)
- environment variable interface for model/provider selection

Out of scope:

- adding arbitrary new harness types beyond `claude`, `gemini`, and `opencode`
- per-agent model override syntax in kloop config (use wrappers instead)
- opencode session resume across loop iterations
- changing overall loop, review, or verdict semantics
- opencode agent/permission configuration management (handled by project-level `opencode.json` or defaults)

## Design Principles

1. Follow established patterns from Gemini integration.
2. Environment controls the model, wrapper controls the environment. kloop config stays harness-agnostic.
3. OpenCode permissions are config-based, not flag-based. kloop does not manage opencode's permission model.
4. Token extraction from `step_finish` events, not `result` events, because opencode emits tokens per step.
5. Fresh sessions per run in v1.

## Feature Parity Matrix

Tested with `opencode` CLI v1.3.17 on 2026-04-07.

| Capability           | Claude Code                      | OpenCode CLI                                    | Parity       | Decision                                                                 |
| -------------------- | -------------------------------- | ----------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| Non-interactive mode | `--print`                        | `run` subcommand                                | ✅ Full      | Supported via `opencode run`                                             |
| Auto-approve tools   | `--dangerously-skip-permissions` | Config-based permissions (no CLI flag)          | ⚠️ Partial   | opencode auto-approves in-project tools; external_directory auto-rejects |
| Stream JSON output   | `--output-format stream-json`    | `--format json`                                 | ✅ Full      | Supported                                                                |
| Session ID injection | `--session-id <uuid>`            | `--session <id>` for continue                   | ❌ Different | Not used by kloop in v1 (fresh sessions)                                 |
| Session ID capture   | Returned/injected by CLI         | Emitted in every event as `sessionID`           | ✅ Full      | Captured from first event                                                |
| Session resumption   | `--session-id` reconnects        | `--session` / `--continue`                      | ⚠️ Partial   | Not used by kloop in v1                                                  |
| Model selection      | `--model <model>`                | `-m provider/model`                             | ✅ Full      | Supported via environment-controlled wrapper                             |
| Verbose output       | `--verbose`                      | `--print-logs` / `--log-level`                  | ⚠️ Partial   | Not required for headless mode                                           |
| MCP support          | `--mcp-config`                   | `opencode mcp` subcommand                       | ⚠️ Partial   | Out of scope in v1                                                       |
| Token counting       | `result.*tokens`                 | `step_finish.part.tokens.*`                     | ✅ Full      | Supported via normalization/aggregation                                  |
| Context file         | `CLAUDE.md`                      | `OPENCODE.md`                                   | ✅ Full      | Harness-native behavior                                                  |
| Stdin piping         | prompt over stdin                | supported (reads stdin when no message args)    | ✅ Full      | v1 uses stdin piping                                                     |
| Provider selection   | N/A (single provider)            | env vars (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`) | ✅ Full      | Supported via wrapper environment                                        |
| Tool use events      | inline in assistant content      | separate `tool_use` events                      | ✅ Full      | Normalized into assistant stream                                         |

## Stream JSON Event Comparison

### Claude Code Events

```jsonc
{"type":"system","subtype":"init","session_id":"...","tools":[...]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
{"type":"user","message":{"role":"user","content":"..."}}
{"type":"result","result":{"cost_usd":0.01,"duration_ms":5000,"session_id":"...","input_tokens":1000,"output_tokens":500}}
```

### OpenCode CLI Events

```jsonc
{"type":"step_start","timestamp":1775549358771,"sessionID":"ses_...","part":{"id":"...","messageID":"msg_...","sessionID":"ses_...","snapshot":"...","type":"step-start"}}
{"type":"text","timestamp":1775549359916,"sessionID":"ses_...","part":{"id":"...","messageID":"msg_...","sessionID":"ses_...","type":"text","text":"...","time":{"start":...,"end":...},"metadata":{...}}}
{"type":"tool_use","timestamp":1775549375428,"sessionID":"ses_...","part":{"id":"...","messageID":"msg_...","sessionID":"ses_...","type":"tool","tool":"bash","callID":"call_...","state":{"status":"completed","input":{...},"output":"...","metadata":{...}},"title":"...","time":{"start":...,"end":...},"metadata":{...}}}
{"type":"step_finish","timestamp":1775549375468,"sessionID":"ses_...","part":{"id":"...","reason":"stop","snapshot":"...","messageID":"msg_...","sessionID":"ses_...","type":"step-finish","tokens":{"total":10091,"input":9959,"output":52,"reasoning":80,"cache":{"write":0,"read":0}},"cost":0.01927625}}
```

Key structural differences from Claude/Gemini:

1. opencode wraps all payload data inside a `part` field
2. opencode emits `step_start`/`step_finish` pairs per agent step (a single run may have multiple steps)
3. Text content comes as `type: "text"` events, not inside message objects
4. Tool use comes as `type: "tool_use"` events with `state.status`
5. Tokens are per-step in `step_finish.part.tokens`, not per-run
6. Session ID is `sessionID` (camelCase), not `session_id` (snake_case)
7. opencode emits an error event as `{"type":"error","timestamp":...,"sessionID":"...","error":{...}}`

### Normalization Rules

1. opencode `step_start` maps to kloop `system` init semantics (captures `sessionID`).
2. opencode `text` maps to kloop `assistant` with text content block.
3. opencode `tool_use` maps to kloop `assistant` with tool_use content block.
4. opencode `step_finish` with `reason: "stop"` is the terminal event — aggregate tokens across all `step_finish` events for the run.
5. opencode `step_finish` with `reason: "tool-calls"` is an intermediate step — not terminal.
6. opencode `error` event maps to kloop `error`.
7. opencode tool error (`state.status: "error"`) is surfaced as a tool result error, not a run error.
8. Total tokens for a run are the sum of all `step_finish.part.tokens` values across steps.

## Config Format

### No Config Format Changes

The config format established by the Gemini spec is reused directly:

```toml
implementers = { "opencode-auto:opencode" = 1 }
reviewPhases = [["opencode-auto:opencode:1", "claude-auto-zai:claude:0"]]
conflictChecker = "opencode-auto:opencode"
```

### Notation

Same colon-separated format:

```text
binary:harness          implementers and conflictChecker
binary:harness:flag     reviewers only
```

Where `harness` can now also be `opencode`.

### Validation Rules

Updated accepted harness values:

- `claude`
- `gemini`
- `opencode`

### Backwards Compatibility

All existing forms remain valid. No changes to legacy parsing.

## Internal Types

**File: `src/types.ts`**

```typescript
export type HarnessType = 'claude' | 'gemini' | 'opencode';
```

The `parseHarness` function must be updated to accept `'opencode'`.

No other type changes are required — `ParsedBinary`, `ReviewerBinary`, and all event types remain the same.

## Command Construction

**File: `src/agents/runner.ts`**

### OpenCode Command

```bash
cat "${promptFile}" | opencode-auto run --format json -m "${model}" 2>&1 | tee "${logFile}" | kloop stream
```

### Command Builder Decisions

1. kloop always generates its own `internalSessionId` for temp files and bookkeeping.
2. OpenCode does not receive a session ID from kloop in v1 (fresh sessions).
3. The model flag `-m` is set by the wrapper's environment, not by kloop directly.
4. OpenCode reads prompt from stdin when no positional message args are given.
5. `--format json` is owned by kloop's command builder, not by the wrapper.
6. OpenCode permissions are managed by project-level config (`opencode.json` or defaults), not by kloop.
7. kloop does not pass `--session` or `--continue` flags in v1.

### Why OpenCode Permissions Don't Need a CLI Flag

- opencode's `run` subcommand operates non-interactively
- in-project tool calls (bash, edit, read within the project directory) are auto-approved by the default `build` agent permissions
- `external_directory` access is auto-rejected, but kloop runs within the project directory
- if a project needs different permissions, it configures them via `opencode.json` in the project root
- kloop should not manage opencode's permission model

### Session Identity

- `internalSessionId`: kloop-generated, used for prompt files and bookkeeping
- `harnessSessionId`: captured from the first opencode event's `sessionID` field
- opencode includes `sessionID` in every event, so capture is reliable from any event type

## Environment-Based Model Selection

### Design

kloop does not know about models. Wrappers do.

Each wrapper is a nix-packaged script that sets environment variables and calls `opencode run` with the correct `-m` flag. The wrapper's name encodes the intent.

### Wrapper Naming Convention

| Wrapper Name           | Provider | Model                          | Environment Variables       |
| ---------------------- | -------- | ------------------------------ | --------------------------- |
| `opencode-auto`        | openai   | `openai/gpt-5.3-codex`         | `OPENAI_API_KEY` (from env) |
| `opencode-gpt53-codex` | openai   | `openai/gpt-5.3-codex`         | `OPENAI_API_KEY`            |
| `opencode-gpt54-pro`   | openai   | `openai/gpt-5.4-pro`           | `OPENAI_API_KEY`            |
| `opencode-deepseek`    | deepseek | `deepseek/deepseek-chat`       | `DEEPSEEK_API_KEY`          |
| `opencode-groq-llama`  | groq     | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY`              |

### Wrapper Template

```bash
#!/usr/bin/env bash
# opencode-auto — targets openai/gpt-5.3-codex
exec opencode run --format json -m "openai/gpt-5.3-codex" "$@"
```

The wrapper is intentionally thin:

- selects the model via `-m`
- passes through all arguments
- relies on environment variables already being set (API keys)
- does NOT inject `--format json` (owned by kloop) — wait, see correction below

**Correction**: Since `--format json` is owned by kloop's command builder, and the wrapper passes through all args, kloop will add `--format json` itself. But the wrapper already includes `--format json` in the model-specific templates above. This is a conflict.

### Refined Wrapper Design

The wrapper must NOT include `--format json`:

```bash
#!/usr/bin/env bash
# opencode-auto — targets openai/gpt-5.3-codex
# Usage: called by kloop with additional flags
exec opencode run -m "openai/gpt-5.3-codex" "$@"
```

kloop's command builder constructs:

```bash
cat "${promptFile}" | opencode-auto --format json 2>&1 | tee "${logFile}" | kloop stream
```

This way:

- the wrapper only owns the `-m` model selection
- kloop owns `--format json` and stdin piping
- the wrapper is reusable outside kloop (it's just `opencode run -m <model>`)

### Wrapper Responsibilities

Allowed:

- select the model via `-m provider/model`
- set required environment variables (API keys) if needed
- select the `opencode` binary path

Not allowed:

- injecting `--format json`
- injecting prompt flags
- injecting session flags
- injecting `--agent` or other semantic flags that kloop manages

### Why Environment-Based, Not Config-Based

- kloop config already has a clean `binary:harness` format — adding a third dimension for model would complicate parsing
- wrappers are the natural extension point: different names = different models
- environment variables for API keys are already required by opencode
- this matches how `claude-auto-zai` vs `claude-auto-mm` work (different binaries, different accounts)
- adding a model to kloop config would require `binary:harness:model` or structured objects — premature for v1

## Stream Normalization

**File: `src/stream/parse.ts`**

### Normalization Order

1. **opencode error event** — must come first to prevent false matches
2. **opencode step_start** → kloop `system` init (captures `sessionID`)
3. **opencode text** → kloop `assistant` with text content block
4. **opencode tool_use** → kloop `assistant` with tool_use content block
5. **opencode step_finish** → accumulate tokens (do not emit a terminal `result` yet)
6. **Final aggregation** — after stream ends, emit a synthetic `result` event with aggregated tokens

### Illustrative Shape

```typescript
function normalizeEvent(obj: unknown): StreamEvent {
  const o = obj as Record<string, unknown>;

  // ... existing Claude and Gemini cases ...

  // === OpenCode error event ===
  if (o.type === 'error' && o.error && o.sessionID) {
    const error = o.error as { message?: string };
    return { type: 'error', error: { message: error.message ?? 'Unknown error' } };
  }

  // === OpenCode step_start → system init ===
  if (o.type === 'step_start' && o.sessionID) {
    return {
      type: 'system',
      subtype: 'init',
      session_id: o.sessionID as string,
      tools: [],
    };
  }

  // === OpenCode text → assistant ===
  if (o.type === 'text' && o.part) {
    const part = o.part as Record<string, unknown>;
    return {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: part.text as string }],
      },
    };
  }

  // === OpenCode tool_use → assistant tool_use ===
  if (o.type === 'tool_use' && o.part) {
    const part = o.part as Record<string, unknown>;
    const state = part.state as Record<string, unknown> | undefined;
    const toolName = part.tool as string;
    const callId = part.callID as string;
    const input = (state?.input ?? {}) as Record<string, unknown>;

    return {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: callId,
            name: toolName,
            input,
          },
        ],
      },
    };
  }

  // === OpenCode step_finish → accumulate tokens ===
  // Note: step_finish events do NOT emit a StreamEvent directly.
  // Instead, tokens are accumulated and a synthetic result is emitted at stream end.
  if (o.type === 'step_finish' && o.part) {
    const part = o.part as Record<string, unknown>;
    const tokens = part.tokens as Record<string, unknown> | undefined;
    if (tokens) {
      // Return a special internal event for token accumulation
      // The stream processor will aggregate these
      return {
        type: 'result',
        result: {
          input_tokens: tokens.input_tokens as number | undefined,
          output_tokens: tokens.output_tokens as number | undefined,
          duration_ms: undefined, // opencode does not provide per-step duration in the same way
        },
      };
    }
  }

  return { type: 'unknown', raw: obj };
}
```

### Token Aggregation

opencode emits tokens per `step_finish` event. kloop needs total tokens for the run.

Approach:

- `extractTokensFromContent` must aggregate tokens from ALL `step_finish` events in the log file
- sum `input_tokens` and `output_tokens` across all steps
- the last `step_finish` with `reason: "stop"` confirms the run completed successfully
- reasoning tokens (`tokens.reasoning`) are ignored for kloop's accounting (only input + output matter)

Updated `extractTokensFromContent`:

```typescript
function extractTokensFromContent(content: string): TokenCounts {
  const result: TokenCounts = { inputTokens: 0, outputTokens: 0 };
  let foundTokens = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);

      // OpenCode step_finish tokens (aggregate across steps)
      if (parsed.type === 'step_finish' && parsed.part?.tokens) {
        const tokens = parsed.part.tokens;
        if (typeof tokens.input_tokens === 'number') {
          result.inputTokens = (result.inputTokens ?? 0) + tokens.input_tokens;
          foundTokens = true;
        }
        if (typeof tokens.output_tokens === 'number') {
          result.outputTokens = (result.outputTokens ?? 0) + tokens.output_tokens;
          foundTokens = true;
        }
        continue;
      }

      if (parsed.type === 'result') {
        // Claude token format
        const usage = parsed.usage;
        if (usage && typeof usage.input_tokens === 'number') {
          result.inputTokens = usage.input_tokens;
        }
        if (usage && typeof usage.output_tokens === 'number') {
          result.outputTokens = usage.output_tokens;
        }

        // Gemini token format
        const stats = parsed.stats;
        if (stats) {
          if (typeof stats.input_tokens === 'number' && result.inputTokens === undefined) {
            result.inputTokens = stats.input_tokens;
          }
          if (typeof stats.output_tokens === 'number' && result.outputTokens === undefined) {
            result.outputTokens = stats.output_tokens;
          }
        }

        break; // Claude/Gemini result event is terminal
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (!foundTokens) {
    // No opencode tokens found; if Claude/Gemini tokens were found, they're already set
    // If nothing was found, return empty
    if (result.inputTokens === 0 && result.outputTokens === 0) {
      return {};
    }
  }

  return result;
}
```

## Harness Session ID Extraction

**File: `src/stream/parse.ts`**

opencode includes `sessionID` in every event. The extraction function should be updated:

```typescript
function extractHarnessSessionIdFromContent(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);

      // Gemini init event
      if (parsed.type === 'init' && typeof parsed.session_id === 'string') {
        return parsed.session_id;
      }

      // OpenCode: sessionID is in every event
      if (typeof parsed.sessionID === 'string' && !parsed.sessionID.startsWith('internal-')) {
        return parsed.sessionID;
      }
    } catch {
      // Skip malformed lines
    }
  }
  return undefined;
}
```

## Prompt Delivery

Decision for v1:

- use stdin piping: `cat "${promptFile}" | opencode-auto --format json`

Rationale:

- opencode reads from stdin when no positional message args are given
- this avoids shell argument length limits
- matches the existing Claude/Gemini stdin pattern

## Files to Change

| File                   | Required Change                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`         | add `'opencode'` to `HarnessType` union; update `parseHarness` validator                                                         |
| `src/agents/runner.ts` | add opencode branch to `buildAgentCommand`                                                                                       |
| `src/stream/parse.ts`  | add opencode event normalization; update `extractTokensFromContent` for aggregation; update `extractHarnessSessionIdFromContent` |
| `src/cli/view.ts`      | ensure opencode-normalized events render correctly when viewing stored logs (may already work)                                   |
| `modules/default.nix`  | add `opencode-auto` wrapper package (and optionally other model-specific wrappers)                                               |

## Wrapper Packaging

### Decision

Package opencode wrappers in `modules/default.nix` alongside the existing kloop binary.

### Wrapper Implementation

Each wrapper is a shell script that calls `opencode run -m <model>` with arguments passthrough:

```nix
# In modules/default.nix
opencode-auto = pkgs.writeShellScriptBin "opencode-auto" ''
  exec ${pkgs.opencode}/bin/opencode run -m "openai/gpt-5.3-codex" "$@"
'';
```

### Naming Convention

- `opencode-auto` — default, targets `openai/gpt-5.3-codex`
- Additional wrappers can be added later for different providers/models without changing kloop code

### Separation of Concerns

| Concern            | Owner       | Mechanism                          |
| ------------------ | ----------- | ---------------------------------- |
| Model selection    | Wrapper     | `-m provider/model` flag           |
| API key            | Environment | `OPENAI_API_KEY`, etc.             |
| JSON output format | kloop       | `--format json` in command builder |
| Prompt delivery    | kloop       | stdin piping                       |
| Permission config  | Project     | `opencode.json` in project root    |
| Session management | kloop       | fresh sessions in v1               |

## Session Identity Semantics

Follows the same model as Gemini:

- `internalSessionId`: kloop-generated identifier for temp files and bookkeeping
- `harnessSessionId`: captured from opencode events' `sessionID` field

Harness-specific behavior:

- Claude: `harnessSessionId === internalSessionId` because kloop injects it
- Gemini: `harnessSessionId` is captured from `init` event
- OpenCode: `harnessSessionId` is captured from any event's `sessionID` field (available immediately)

## Functional Definition of Done

The work is functionally complete only if all of the following are true:

### Config parsing

- [ ] Existing Claude-only and Gemini configs still parse unchanged
- [ ] `binary:opencode` works for implementers
- [ ] `binary:opencode:flag` works for reviewers
- [ ] `conflictChecker` accepts `binary:opencode`
- [ ] `opencode` is accepted as a valid harness type

### Command execution

- [ ] OpenCode implementers can run successfully in headless mode
- [ ] OpenCode reviewers can run successfully in headless mode
- [ ] OpenCode conflict checker can run successfully in headless mode
- [ ] OpenCode commands include `--format json`
- [ ] OpenCode commands do not attempt `--session-id` injection
- [ ] OpenCode commands pipe prompt via stdin

### Stream/log behavior

- [ ] `kloop stream` displays opencode text output during live execution
- [ ] `kloop stream` displays opencode tool use during live execution
- [ ] opencode `step_finish` tokens are aggregated into run totals
- [ ] opencode error events are recognized as errors
- [ ] opencode session IDs are captured into logs/state

### Status/token accounting

- [ ] OpenCode runs produce token counts in the same aggregate reporting paths as Claude runs
- [ ] OpenCode runs do not break status materialization for phased reviews
- [ ] mixed Claude/Gemini/OpenCode reviewer phases work correctly

### Packaging

- [ ] `opencode-auto` is available as an executable after home-manager activation
- [ ] wrapper targets the correct default model (`openai/gpt-5.3-codex`)
- [ ] wrapper does not duplicate semantic flags managed by kloop

## Non-Functional Definition of Done

### Backwards compatibility

- [ ] no existing Claude or Gemini config needs migration
- [ ] no existing Claude or Gemini loop behavior regresses
- [ ] old reviewer syntax `binary:0|1` still works
- [ ] all existing stream normalization continues to work for Claude and Gemini

### Maintainability

- [ ] opencode normalization follows the same pattern as Gemini (additive, not restructuring)
- [ ] token aggregation is explicit and handles multi-step opencode runs
- [ ] wrapper responsibilities and runner responsibilities are clearly separated

### Observability

- [ ] OpenCode logs are inspectable with existing kloop log/view workflows
- [ ] harness-emitted session IDs are retained where useful for debugging
- [ ] per-step tokens are aggregated correctly for display

### Simplicity

- [ ] no new config grammar beyond existing `binary:harness` and `binary:harness:flag`
- [ ] no session resume support is added speculatively
- [ ] no per-model config syntax is added speculatively
- [ ] wrappers are shell scripts, not complex nix derivations

## Test Scenarios

At minimum, validate these scenarios:

1. Claude-only legacy config still runs.
2. Gemini config still runs.
3. OpenCode-only implementer config runs.
4. Mixed Claude/Gemini/OpenCode reviewer phase runs.
5. OpenCode reviewer with `:0` and `:1` semantics behaves correctly.
6. OpenCode multi-step run aggregates tokens correctly across `step_finish` events.
7. OpenCode error event is surfaced as an error.
8. OpenCode tool use events are normalized and displayable.
9. Invalid harness in config fails before execution.
10. `opencode-auto` wrapper correctly invokes opencode with the right model.
11. Conflict checker using OpenCode runs successfully.

## Known Limitations in v1

- OpenCode sessions are fresh per run; kloop does not resume them across iterations.
- OpenCode permissions are project-level config, not CLI-flag controllable. External directory access is auto-rejected in non-interactive mode.
- Per-config model override syntax is intentionally unsupported. Use wrapper naming instead.
- MCP parity is intentionally out of scope.
- reasoning tokens from opencode (`tokens.reasoning`) are not tracked separately by kloop.

## Future Extensions

Potential follow-up work, explicitly deferred from this spec:

- wrapper parameterization for model selection without creating new wrapper scripts
- opencode session resume support if it proves useful in practice
- richer event schemas for opencode-specific metadata (cost, cache stats)
- per-step cost aggregation for more granular reporting
- opencode agent selection (`--agent` flag) for specialized review/checkpoint agents
