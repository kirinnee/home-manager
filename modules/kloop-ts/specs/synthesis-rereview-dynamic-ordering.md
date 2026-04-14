# Spec: Review Synthesis, Re-Review Gate, and Dynamic Review Ordering

## Overview

Six interconnected features in the kloop dev loop engine:

1. **Synthesis (compacting phase)** — After each loop's reviews complete, a synthesizer agent compacts all raw reviews into a single `review-summary.md`. This replaces raw individual reviews as the primary input for the next loop's implementer and reviewers. The summary deduplicates issues, prioritizes by severity (CRITICAL/HIGH/LOW), tracks confirmed-complete spec items, and compacts learnings.

2. **Re-review gate** — On loop 2+, before running expensive full reviewers, cheap/fast models validate that the previous loop's issues were actually fixed. If any CRITICAL issue remains unfixed, the full review is skipped entirely — saving expensive reviewer tokens. The re-review phase itself has configurable sub-phases with short-circuit on rejection.

3. **Phase re-organization after checkpoint** — After a checkpoint runs with no conflict and `rerankAfterCheckpoint` is enabled, remaining reviewers are re-ranked by "trouble score" (rejections, low completion estimates, errors). The most troublesome reviewers are placed in the next phase. This ensures harsh reviewers catch problems early, and easy reviewers only run when the code is most likely to pass. Computed fresh each checkpoint — not persisted across loops.

4. **`::i` implementer suffix** — Marks an implementer as preferred for loop 1 (full implementation). The weight multiplier is configurable (default 2x).

5. **Implementer retry on crash** — If the implementer exits with code 1, retry with a random re-pick up to a configurable max, with exponential backoff. On exhausted retries, stop the entire loop with "crashed" status.

6. **Implementer self-review** — Before marking implementation complete, the implementer must perform a self-review.

## Loop Lifecycle

```
Loop 1:  implementer (retry on crash, ::i preferred) → [review phases] → synthesis → goto 1
Loop 2+: implementer (retry on crash) → [re-review phases (cheap)]
             ↓ fail → re-synthesize from re-reviewers (their own folders) → goto 1
             ↓ pass  → [review phases]
                         ↓ phase passes (checkpoint, no conflict) → re-organize remaining phases → next phase
                         ↓ all phases done or rejection → synthesis → goto 1
```

### Detailed Pipeline

```
1. Implementer (retry on exit 1, backoff, max retries, self-review)
   → re-review [fail goto 2, pass goto 3]

2. Re-synthesize: synthesize from re-reviewer outputs (rereviewer-{N}/ folders)
   → treat as this loop's synthesis → goto 5

3. Review phases
   → [phase passes (checkpoint, no conflict) goto 4]
   → [any rejection or all phases done goto 5]

4. Checkpoint (no conflict): re-organize remaining phases
   → extract high-rejection reviewers to next phase
   → push remaining back → goto 3

5. Synthesis → goto 1
```

**Re-review is skipped on loop 1** (no previous synthesis to check against).

**Dynamic ordering is computed fresh each checkpoint** (not persisted across loops).

**Synthesis always runs**: after full reviews (step 5), or after re-review fail (step 2).

## Definition of Done

### Config Schema (`src/types.ts`)

- [x] `reReview` config field: `{ enabled: boolean (default: false), phases: string[][] (default: [['claude-haiku:claude']]), timeout: number (default: 5) }`
- [x] `rerankAfterCheckpoint` config field: `boolean (default: false)` — re-ranks remaining reviewers by trouble score after a checkpoint with no conflict
- [x] `synthesis` config field: `{ enabled: boolean (default: true) }`
- [x] `synthesizer?: string`, `reReviewer?: string`, and `reSynthesizer?: string` in the `prompts` sub-object
- [x] `resolvedConfigSchema`, `DEFAULT_CONFIG`, and `.transform()` include all new fields with defaults
- [x] `dynamicReviewOrdering` config field removed (replaced by `rerankAfterCheckpoint`)
- [x] All new fields are optional with backward-compatible defaults
- [x] Config validates correctly with `parseRawConfig()`

### Implementer Retry (`src/types.ts`)

- [x] `implementerRetry` config field: `{ maxRetries: number (default: 2, range 0-10), backoffBaseMs: number (default: 5000, min 0) }`
- [x] On implementer exit code 1: waits `backoffBaseMs * 2^attempt`, re-picks random implementer (weighted selection), retries
- [x] On timeout: does NOT retry (timeout is not a transient crash)
- [x] On exhausted retries (all exit 1): stops the loop with "crashed" status via `CrashedError`, writes `crashed` event
- [x] Each retry attempt emits `IMPLEMENTER_START`/`IMPLEMENTER_END` events with `retryAttempt` and `maxRetries` fields
- [x] Backoff delay does NOT count toward the implementer timeout
- [x] `implementer_retry` event emitted between retries with `loop`, `attempt`, `maxRetries`, `previousBinary`, `newBinary`, `backoffMs`

### `::i` Implementer Suffix (`src/types.ts`)

- [x] `firstIterationPreferred: boolean` field on `ParsedBinary` interface
- [x] `firstIterationWeightMultiplier: number` config field (default: 2, range 1-10)
- [x] `parseImplementerConfig()` recognizes `::i` suffix: `claude-auto-opus::i` → `{ binary: 'claude-auto-opus', harness: 'claude', firstIterationPreferred: true }`
- [x] Without suffix: `parseImplementerConfig('claude-auto-opus')` → `{ ..., firstIterationPreferred: false }`
- [x] `selectImplementer(config, loopNum?)` — on loop 1, models with `firstIterationPreferred: true` get `weight * firstIterationWeightMultiplier`. On loop 2+, normal weighted selection.
- [x] Backward compat: `selectImplementer(config)` without loopNum defaults to loop 1

### Event Types (`src/types.ts`)

- [x] `EVENT_TYPES` includes: `SYNTHESIS_START`, `SYNTHESIS_END`, `RE_REVIEW_PHASE_START`, `RE_REVIEWER_START`, `RE_REVIEWER_END`, `RE_REVIEW_PHASE_END`, `IMPLEMENTER_RETRY`, `CRASHED`
- [x] Event interfaces: `SynthesisStartEvent`, `SynthesisEndEvent`, `ReReviewPhaseStartEvent`, `ReReviewerStartEvent`, `ReReviewerEndEvent`, `ReReviewPhaseEndEvent`, `ImplementerRetryEvent`, `CrashedEvent`
- [x] `ImplementerEndEvent` extended with `retryAttempt?: number` (0-indexed) and `maxRetries?: number`
- [x] `KloopEvent` union includes all new event types

### Materialized Types (`src/types.ts`)

- [x] `MaterializedSynthesis` interface: `{ status, startedAt?, completedAt?, durationMs?, exitCode?, error?, summaryPath?, binary?, harness? }`
- [x] `MaterializedReReviewPhase` interface: mirrors `MaterializedReviewPhase`
- [x] `MaterializedLoop` extended with `synthesis?: MaterializedSynthesis` and `reReviewPhases?: MaterializedReReviewPhase[]`
- [x] `MaterializedAgentState` extended with `retryAttempt?: number` and `retryMax?: number`

### Loop Summary (`src/types.ts`)

- [x] `LoopSummary` extended with `implementerRetryAttempts?: number` and `reReviewPhases?` array

### Paths (`src/deps.ts`)

- [x] `loopSynthesisPath(runId, loopIndex)` → `{kloopHome}/{runId}/loop-{N}/synthesis`
- [x] `loopReReviewPath(runId, loopIndex)` → `{kloopHome}/{runId}/loop-{N}/rereview`

### Synthesizer Prompt (`src/agents/default-prompts.ts`)

- [x] `DEFAULT_SYNTHESIZER_PROMPT` with placeholders: `{specPath}`, `{iteration}`, `{reviewsDir}`, `{verdictsDir}`, `{previousSummaryPath}`, `{summaryOutputPath}`, `{learningsFile}`, `{evidenceDir}`
- [x] Instructs agent to: read all raw reviews + verdicts, deduplicate issues, assign CRITICAL/HIGH/LOW severity, track confirmed-complete spec items, track resolved issues from previous summary, update learnings, write structured `review-summary.md`
- [x] Output format: Confirmed Complete, Issues Requiring Action (grouped by severity with reviewer attribution), Resolved Since Previous Loop, Progress Estimate
- [x] Considers `addressed-reviews.md` if present (evaluates implementer's reasoning)

### Re-Synthesis Prompt (`src/agents/default-prompts.ts`)

- [x] `DEFAULT_RE_SYNTHESIS_PROMPT` with placeholders: `{specPath}`, `{iteration}`, `{previousSummaryPath}`, `{rereviewDir}`, `{verdictsDir}`, `{summaryOutputPath}`, `{learningsFile}`
- [x] Merges previous summary + re-reviewer outputs + verdicts from `{verdictsDir}/rereviewer-*.json`
- [x] Lightweight synthesis — no raw reviews to process, only re-reviewer outputs
- [x] Preserves previous summary structure and severity levels; only changes issue status based on re-reviewer evidence

### Re-Reviewer Prompt (`src/agents/default-prompts.ts`)

- [x] `DEFAULT_RE_REVIEWER_PROMPT` with placeholders: `{specPath}`, `{iteration}`, `{previousSummaryPath}`, `{reviewsDir}`, `{verdictsDir}`, `{evidenceDir}`, `{learningsFile}`, `{reReviewerIndex}`
- [x] Instructs agent to: read previous summary's "Issues Requiring Action", check git diff + evidence, output pass/fail per issue
- [x] Verdict: APPROVE if all CRITICAL and HIGH issues fixed; REJECT if any CRITICAL issue unfixed; APPROVE if only LOW issues remain
- [x] Verdict JSON includes `issuesFixed: string[]` and `issuesRemaining: string[]`

### Implementer Self-Review (`src/agents/default-prompts.ts`)

- [x] `DEFAULT_IMPLEMENTER_PROMPT` includes self-review as step 6 (between evidence capture and addressed-reviews):
  - Run `git diff` and `git diff --staged` to review all changes
  - Check each change against the spec requirements
  - Verify all evidence has been captured
  - Write self-review findings to `{evidenceDir}/self-review.md`
  - Only mark as complete if all critical spec items are addressed
- [x] Addressed-reviews documentation is step 7, learnings is step 8

### Prompt Builders (`src/agents/prompts.ts`)

- [x] `SynthesizerPromptVars` interface and `buildSynthesizerPrompt(template?, vars)` function
- [x] `ReSynthesisPromptVars` interface and `buildReSynthesisPrompt(template?, vars)` function
- [x] `ReReviewerPromptVars` interface and `buildReReviewerPrompt(template?, vars)` function
- [x] `ImplementerPromptVars` includes optional `reviewSummaryPath?: string` (substituted as empty string when undefined)

### Agent Runner (`src/agents/runner.ts`)

- [x] `SynthesizerResult` interface: `{ binary, harness, summaryPath?, inputTokens?, outputTokens?, harnessSessionId? }`
- [x] `ReReviewerResult` interface: `{ reviewerIndex, binary, harness, verdict, reasoning, issuesFixed?, issuesRemaining?, ... }`
- [x] `runSynthesizer()` method: builds prompt, runs via tmux, checks for `review-summary.md`, returns `SynthesizerResult`
- [x] `runReSynthesizer()` method: builds re-synthesis prompt with `rereviewDir`, runs via tmux (session `kloop-{runId}-{iteration}-resynth`), returns `SynthesizerResult`
- [x] `runReReviewerPhase()` and `runReReviewer()` methods: mirror reviewer methods but write to `rereview/` dirs

### Iteration Data (`src/loop/iteration.ts`)

- [x] `reviewSummaryPath: string | null` on `IterationData`
- [x] Computed in `buildIterationData()`: loop 1 = null, loop 2+ = previous loop's `synthesis/review-summary.md`

### Loop Runner (`src/loop/runner.ts`)

- [x] `CrashedError` class thrown when implementer retries exhausted
- [x] `LoopResult` status union includes `'crashed'`
- [x] `runImplementerWithRetry()`: wraps implementer run with retry loop — on exit 1 waits `backoffBaseMs * 2^attempt`, re-picks via `selectImplementer()`, retries up to `maxRetries`. Timeout = no retry. Exhaustion = throws `CrashedError`.
- [x] `runReSynthesisPhase()`: emits `synthesis_start`/`synthesis_end` events, calls `agentRunner.runReSynthesizer()`, displays with `formatReSynthesisStart()`/`formatReSynthesisResult()`
- [x] `getReorganizedPhases()` (renamed from `getDynamicReviewPhases()`): trouble score = `rejections*10 + (100-avgCompletion) + errors*5`, sorts descending, distributes into phases. Guard: `config.rerankAfterCheckpoint`
- [x] Main loop: implementer (with retry) → re-review gate (loop 2+, if enabled) → on fail: re-synthesis → loop; on pass: review phases → checkpoint → reorg → synthesis → loop

### Materializer (`src/status/materialize.ts`)

- [x] `applyEvent()` handles all new event types following existing patterns
- [x] `IMPLEMENTER_RETRY` case (informational, no-op)
- [x] `IMPLEMENTER_END` reads `retryAttempt`/`maxRetries` into `MaterializedAgentState`
- [x] Full materialization for `RE_REVIEW_PHASE_START/END`, `RE_REVIEWER_START/END`, `SYNTHESIS_START/END`
- [x] `markRunningAgentsInterrupted()` handles `reReviewPhases` and `synthesis`

### Verdicts (`src/agents/verdicts.ts`)

- [x] Optional `issuesFixed?: string[]` and `issuesRemaining?: string[]` on `VerdictParseResult`
- [x] Non-breaking: these fields only appear in re-reviewer verdicts

### Default Config (`src/agents/default-config.ts`)

- [x] Generated YAML includes `reReview`, `synthesis`, `implementerRetry`, `rerankAfterCheckpoint`, `firstIterationWeightMultiplier` sections
- [x] `reSynthesizer` prompt template included with placeholder documentation
- [x] Imports `DEFAULT_RE_SYNTHESIS_PROMPT`

### Display (`src/loop/format.ts`)

- [x] `formatReReviewStart()`, `formatReReviewResult()` functions
- [x] `formatSynthesisStart()`, `formatSynthesisResult()` functions
- [x] `formatReSynthesisStart()`, `formatReSynthesisResult()` functions
- [x] `formatDynamicOrdering()` — labels as "reranked review phases"
- [x] `formatImplementerRetry(attempt, maxRetries, backoffMs)` — "implementer retry N/maxRetries (backoff X.Xs)"
- [x] `formatAgentLaunch()` role union: `'impl' | 'reviewer' | 'checkpoint' | 'synthesizer' | 'rereviewer' | 'resynthesizer'`

### CLI Status (`src/cli/status.ts`)

- [x] Config display: `synthesis: on/off`, `re-review: on/off`, `rerank: on/off`, `impl-retry: N`
- [x] Per-phase reviewer listing in config section
- [x] Reranked phase display when phases differ from config (reconstructed from materialized loop data)
- [x] Running phase detection for "re-reviewing", "synthesizing", "re-synthesizing" labels
- [x] Implementer retry info (`retry X/Y`) when present
- [x] `--json` output includes `rerankAfterCheckpoint`, `implementerRetry`, `firstIterationWeightMultiplier`, `reReview`, `synthesis`

### CLI Describe (`src/cli/describe.ts`)

- [x] Config display: `Synthesis: on/off`, `Re-review: on/off`, `Rerank: on/off`, `Impl-retry: N`, `::i weight: Nx`
- [x] `--json` output includes all new config fields
- [x] Synthesis and re-review info displayed when present

### Tests (`src/index.test.ts`)

- [x] `bun run check` passes (`tsc --noEmit && knip && bun test`)
- [x] 50 tests, 120 assertions, 0 failures
- [x] Config parsing: defaults, reReview, rerankAfterCheckpoint, synthesis disabled, implementerRetry custom values, firstIterationWeightMultiplier, all fields explicitly set, defaults match DEFAULT_CONFIG
- [x] `::i` parsing: bare implementer, with `::i`, binary:harness with `::i`, binary:harness without `::i`, empty throws, too many colons throws
- [x] Implementer prompt: missing reviewSummaryPath replaced with empty string
- [x] Re-synthesis prompt: all placeholders substituted, custom template override, unknown placeholders left intact
- [x] Synthesizer prompt: all placeholders substituted, custom template override
- [x] Re-reviewer prompt: all placeholders substituted, custom template override
- [x] Default prompt templates: self-review step present with correct path, addressed-reviews step present, all implementer placeholders present, all re-synthesis placeholders present, re-synthesis describes lightweight merge, self-review ordering before addressed-reviews
- [x] `selectImplementer`: returns valid binary, single implementer always selected, `::i` boost on loop 1 with high multiplier (statistical), no `::i` boost on loop 2+ (statistical), default multiplier is 2
- [x] EVENT_TYPES: IMPLEMENTER_RETRY, CRASHED, synthesis events, re-review events
- [x] Config edge cases: dynamicReviewOrdering silently ignored, implementerRetry boundaries (0, 10, backoffBaseMs=0), firstIterationWeightMultiplier boundaries (1, 10), reSynthesizer prompt optional, all prompts preserved, reReview/synthesis defaults

### Surface Area Changelog (`SURFACE_CHANGELOG.md`)

- [x] `SURFACE_CHANGELOG.md` at project root documents all surface changes
- [x] Structured for mechanical diffing by downstream tools
- [x] Covers: Breaking Changes, New Exports (config, events, types, functions, constants, prompts, runtime files, CLI display, exit statuses, pipeline), Modified Exports, Removed Exports, Breaking for Consumers

---

## Surface Changes (Reference)

This section is a human-readable inventory of the surface changes introduced by this spec. It serves as the author's working notes for the DoD-required `SURFACE_CHANGELOG.md` (see [Surface Area Changelog](#surface-area-changelog-surface_changelogyml) above).

The actual deliverable is the structured `SURFACE_CHANGELOG.md` file written per the schema defined in the DoD. This section is kept for reference during implementation.

### New Directories Created at Runtime

| Directory                     | Created By         | When                                                                   |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------- |
| `{runId}/loop-{N}/synthesis/` | Synthesizer agent  | After each loop's reviews complete (or re-synthesis on re-review fail) |
| `{runId}/loop-{N}/rereview/`  | Re-reviewer agents | During re-review gate on loop 2+                                       |

### New Files Written at Runtime

| File                                                 | Writer                       | Format      | Purpose                                                           |
| ---------------------------------------------------- | ---------------------------- | ----------- | ----------------------------------------------------------------- |
| `{runId}/loop-{N}/synthesis/review-summary.md`       | Synthesizer / re-synthesizer | Markdown    | Structured review summary (replaces raw reviews as primary input) |
| `{runId}/loop-{N}/synthesis/prompt.md`               | Synthesizer agent            | Markdown    | Prompt used for synthesis                                         |
| `{runId}/loop-{N}/synthesis/log`                     | Synthesizer agent            | Stream JSON | Agent output log                                                  |
| `{runId}/loop-{N}/rereview/rereviewer-{N}/prompt.md` | Re-reviewer agent            | Markdown    | Prompt used for re-review                                         |
| `{runId}/loop-{N}/rereview/rereviewer-{N}/log`       | Re-reviewer agent            | Stream JSON | Re-reviewer output log                                            |
| `{runId}/loop-{N}/evidence/self-review.md`           | Implementer                  | Markdown    | Implementer self-review findings                                  |

### New Config Fields

| Field                            | Type         | Default                     | Location        |
| -------------------------------- | ------------ | --------------------------- | --------------- |
| `reReview.enabled`               | `boolean`    | `false`                     | Top-level       |
| `reReview.phases`                | `string[][]` | `[['claude-haiku:claude']]` | Top-level       |
| `reReview.timeout`               | `number`     | `5`                         | Top-level       |
| `rerankAfterCheckpoint`          | `boolean`    | `false`                     | Top-level       |
| `synthesis.enabled`              | `boolean`    | `true`                      | Top-level       |
| `implementerRetry.maxRetries`    | `number`     | `2`                         | Top-level       |
| `implementerRetry.backoffBaseMs` | `number`     | `5000`                      | Top-level       |
| `firstIterationWeightMultiplier` | `number`     | `2`                         | Top-level       |
| `prompts.synthesizer`            | `string?`    | —                           | Under `prompts` |
| `prompts.reReviewer`             | `string?`    | —                           | Under `prompts` |
| `prompts.reSynthesizer`          | `string?`    | —                           | Under `prompts` |

### New Event Types

| Event Type              | Key Fields                                                                              | Emitted When                |
| ----------------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| `synthesis_start`       | `loop`, `binary`, `harness?`                                                            | Synthesizer agent starts    |
| `synthesis_end`         | `loop`, `binary`, `harness?`, `exitCode`, `durationMs`, `error?`, `summaryPath?`        | Synthesizer agent completes |
| `re_review_phase_start` | `loop`, `phase`, `reviewers[]`                                                          | Re-review phase begins      |
| `re_reviewer_start`     | `loop`, `phase`, `reviewer`, `harness?`                                                 | Re-reviewer agent starts    |
| `re_reviewer_end`       | `loop`, `phase`, `reviewer`, `harness?`, `exitCode`, `durationMs`, `error?`, `verdict?` | Re-reviewer agent completes |
| `re_review_phase_end`   | `loop`, `phase`, `shortCircuited`                                                       | Re-review phase ends        |
| `implementer_retry`     | `loop`, `attempt`, `maxRetries`, `previousBinary`, `newBinary`, `backoffMs`             | Implementer crash retry     |

### Modified Event Types

| Event Type        | New Fields                                     | Description                                        |
| ----------------- | ---------------------------------------------- | -------------------------------------------------- |
| `implementer_end` | `retryAttempt?: number`, `maxRetries?: number` | Tracks which retry attempt this is (0 = first try) |

### Removed Config Fields

| Field                           | Replacement             | Notes                           |
| ------------------------------- | ----------------------- | ------------------------------- |
| `dynamicReviewOrdering.enabled` | `rerankAfterCheckpoint` | Simpler boolean, same semantics |

### Pipeline Order Change

**Before**: implementer → review → consensus/checkpoint → loop

**After**: implementer (with retry) → re-review gate (loop 2+) → review phases → checkpoint → re-org remaining phases (if `rerankAfterCheckpoint`) → synthesis → loop

### Breaking for Consumers

| Impact                                                        | Affected Consumers                        | Mitigation                                                        |
| ------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| New event types in `events.jsonl`                             | Any tool parsing event stream             | Must handle unknown event types gracefully; 7 new types added     |
| `dynamicReviewOrdering` removed from config                   | Default config generators, YAML templates | Replace with `rerankAfterCheckpoint` boolean                      |
| `status.yaml` gains `reReviewPhases` and `synthesis` per loop | `kloop status --json`, `kloop show`       | Parse new optional fields; render re-review and synthesis phases  |
| New runtime directories `synthesis/` and `rereview/`          | Run cleanup, archival tools               | Include new dirs in cleanup sweeps                                |
| `crashed` exit status from implementer retry exhaustion       | Run monitors, `/kloop` skill              | Handle new terminal status alongside existing `failed`/`conflict` |
| Implementer self-review prompt change (no code change)        | None (prompt-only)                        | No integration change needed                                      |

---

## Surface Changelog Schema

The `SURFACE_CHANGELOG.md` file follows this structure. Each section is a table. Empty tables are omitted.

```markdown
# Surface Area Changelog

Spec: <spec-name>
Date: <YYYY-MM-DD>

## Breaking Changes

| Category | Symbol | Before | After |
| -------- | ------ | ------ | ----- |

## New Exports

### Config Schema

Full shape of every new config field, including nesting. Include the complete
resolved `Config` type diff — downstream tools that generate, validate, or
display config must know the exact shape.

| Field | Type | Default | Location | Example |
| ----- | ---- | ------- | -------- | ------- |

For nested objects, expand to show full shape:

| Path               | Type         | Default                     | Constraints                         | Example                                        |
| ------------------ | ------------ | --------------------------- | ----------------------------------- | ---------------------------------------------- |
| `reReview`         | `object`     | —                           | —                                   | —                                              |
| `reReview.enabled` | `boolean`    | `false`                     | —                                   | `true`                                         |
| `reReview.phases`  | `string[][]` | `[['claude-haiku:claude']]` | Each phase: `string[]`, min 1 phase | `[['claude:claude'], ['claude-haiku:claude']]` |
| `reReview.timeout` | `number`     | `5`                         | `0.001–120`                         | `10`                                           |

### Prompt Templates

Every new default prompt and every modified prompt. Include the full prompt
text (not a summary) so downstream tools can diff against their custom
overrides and understand what the agent will actually receive.

| Name | Constant | Full Text | Placeholders |
| ---- | -------- | --------- | ------------ |

For modified prompts, show a diff of what changed:

| Name | Section Changed | Before | After |
| ---- | --------------- | ------ | ----- |

### Event Types (events.jsonl)

Every new event written to `events.jsonl`. Include **all fields with types**
so parsers can handle them.

| Event Type | Fields (name: type) | Emitted When | Example JSON |
| ---------- | ------------------- | ------------ | ------------ |

### Materialized Status (status.yaml)

Every change to the `status.yaml` schema.

**New fields on MaterializedLoop:**

| Field | Type | When Present |
| ----- | ---- | ------------ |

**New fields on MaterializedAgentState (implementer):**

| Field | Type | When Present |
| ----- | ---- | ------------ |

### CLI --json Output

Every change to structured JSON output from CLI commands.

| Path | Type | When Present |
| ---- | ---- | ------------ |

### Types & Interfaces

| Name | File | Kind | Notes |
| ---- | ---- | ---- | ----- |

### Functions

| Name | File | Signature | Notes |
| ---- | ---- | --------- | ----- |

### Constants

| Name | File | Notes |
| ---- | ---- | ----- |

### Runtime Directories

| Path Pattern | Created By | When |
| ------------ | ---------- | ---- |

### Runtime Files

| Path Pattern | Writer | Format | Purpose |
| ------------ | ------ | ------ | ------- |

### CLI Display

| Function | File | Notes |
| -------- | ---- | ----- |

### Run Exit Statuses

| Status | Exit Code | Condition |
| ------ | --------- | --------- |

### Pipeline

| Aspect | Before | After |
| ------ | ------ | ----- |

## Modified Exports

(tables per category)

## Removed Exports

| Category | Symbol | Replacement | Notes |
| -------- | ------ | ----------- | ----- |

## Breaking for Consumers

| Impact | Affected Consumers | Mitigation |
| ------ | ------------------ | ---------- |
```

### Rules

1. **Breaking changes** must list every consumer that breaks and the migration path
2. **"New Exports"** lists everything a downstream tool can newly depend on
3. **"Modified Exports"** lists signature or semantic changes to existing exports (new optional fields are "modified", not "new")
4. **"Removed Exports"** lists deleted symbols with their replacement if any
5. **Omit** unchanged exports — this file is a diff, not a full dump
6. **Pipeline** section captures flow changes (new phases, reordering, new exit paths) that aren't expressible as symbol changes
7. **Breaking for consumers** is the actionable summary: which tools break, why, and what they must do
8. The file is **per-spec** — each spec that touches the surface writes its own section or file
