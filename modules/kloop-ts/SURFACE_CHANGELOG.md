# Surface Area Changelog

Spec: interactive-tui-harness
Date: 2026-06-23

## Summary

New `settings.interactive` toggle (default `false`). When `true`, **claude-harness**
agents (all roles) run as INTERACTIVE TUIs instead of `--print`. kloop launches the TUI
detached in tmux, pastes the prompt via bracketed paste, then watches for a marker file
the agent touches when done, captures the pane transcript, and sends `/exit`. Timeout
still applies. Gemini/codex harnesses are unaffected (always `--print`).

```yaml
settings:
  interactive: false # run claude agents as interactive TUIs (no --print)
```

Completion is detected via a `.kloop-done` marker the agent is instructed (prompt suffix)
to `touch` as its last action. Exit-code mapping: marker seen → success; session died
first → crash (retried); deadline hit → timeout.

**Live logs.** Interactive mode has no stream-json to `tee`, so the per-agent `log` is
sourced two ways: during startup the tmux pane is snapshotted to it each tick (so a failed
launch is visible, not dead air); once Claude Code's own session transcript appears
(`~/.claude*/projects/<cwd>/<sessionId>.jsonl`, found via the kloop-supplied `--session-id`
— the `.claude*` glob also covers wrappers with a custom `CLAUDE_CONFIG_DIR`), the `log` is
replaced with a symlink to it. That transcript is the same JSON shape `kloop view` renders,
and since Claude only appends, `kloop view -f` byte-tailing works. `view` now also skips
Claude's bookkeeping line types (`mode`, `attachment`, …).

Trade-off: still **no token counts** in interactive mode (the session transcript has no
`--print`-style `result` summary). For true real-time, `tmux attach -t <agent-session>`
shows the live TUI.

---

Spec: nested-config-role-blocks
Date: 2026-06-21

## Summary

The on-disk config moved from a FLAT layout to a NESTED role-block layout
(`configVersion` bumped 1 → 2). `pools` is now the central registry; every role
references pools by name.

```yaml
configVersion: 2
maxIterations: 7
# ── PROFILES (reusable definitions) ──
pools:                         # the registry (was: poolProfiles)
  claude: { claude: 1 }
lensProfiles: { ... }          # top-level, grouped with pools (was: under reviewer)
# ── PER-PHASE CONFIGS ──
implementer:                   # was: implementers / implementerTimeout / implementerRetry / firstIterationWeightMultiplier
  pools: { claude: 1 }
  timeout: 30
  firstIterationWeightMultiplier: 2
  retry: { maxRetries: 2, backoffBaseMs: 5000 }
reviewer:                      # was: reviewPhases / reviewLenses / reviewerTimeout / firstLoopFullReview / reviewerRetry
  phases: [[ claude ]]
  lenses: [ general ]
  timeout: 15
  firstLoopFullReview: true
  retry: { maxRetries: 2, backoffBaseMs: 5000 }
verifier:    { phases: [[ claude ]], timeout: 5 }   # was: verifyPhases / verifyTimeout / verify
synthesizer: { pool: claude, timeout: 15 }          # was: synthesizer / synthesisTimeout / synthesis
checkpointer:{ pool: claude, threshold: 3 }         # was: conflictChecker / conflictCheckThreshold
# ── SETTINGS ──
settings:                      # was: top-level flat toggles
  synthesis: true
  verify: true
  rerankAfterCheckpoint: true
  previousReviewPropagation: 0.7
  compressSpec: false
  snapshot: false
prompts: { ... }               # unchanged (top-level)
```

The default template (`buildDefaultConfigYaml`) groups keys under banner-commented
sections: **PROFILES** (pools + lensProfiles) · **PER-PHASE CONFIGS** (implementer /
reviewer / verifier / synthesizer / checkpointer) · **SETTINGS** · **PROMPTS**.
`lensProfiles` is top-level (grouped with pools); `flattenNestedConfig` still accepts the
old `reviewer.lensProfiles` placement for back-compat.

Internally the resolved `Config` stays FLAT — a `flattenNestedConfig` input layer
(`src/types.ts`) maps the nested blocks to flat keys, and `nestFlatConfig` does the
inverse for migration. Fully backward compatible: OLD flat configs (and the legacy
`implementer`/`synthesizer` strings, `reviewers`, `reReview`, `synthesis:{enabled}`,
`prompts.reReviewer` aliases) still parse. `migrateConfigObject` restructures a v1 file
into v2 on load (preserving all user values + custom prompts) and persists it. Consumers
that read config raw (dashboard `data.ts`, `kloop show config`) now flatten first.

---

Spec: binary-spec-suffix-syntax
Date: 2026-06-21

## Summary

New trailing-suffix syntax for binary/account specs (reviewers, implementers, types):

| Flag            | New     | Legacy (still parsed) | Meaning                                                                      |
| --------------- | ------- | --------------------- | ---------------------------------------------------------------------------- |
| First-iteration | `bin*`  | `bin::i`              | Preferred on loop 1 (gets `firstIterationWeightMultiplier`)                  |
| Harness         | `bin:h` | `bin:h`               | Explicit harness; guessed from the binary's first word if omitted            |
| No-verdict      | `bin!`  | `bin:0` / `bin:1`     | `!` = IGNORE a no-verdict (pass); no `!` = FAIL (reject) — default unchanged |

Combos in any order: `codex-auto-gpt55:codex*!`. Fully backward compatible — all legacy
forms (`::i`, `:0`, `:1`) still parse. Implemented in `parseImplementerConfig` /
`parseReviewerConfig` via a shared suffix stripper; the dashboard `klBin` strips the new
suffixes for display.

---

Spec: named-pool-profiles
Date: 2026-06-21

## Summary

Added **named, reusable account pools** (`poolProfiles`). A reviewer/verifier type entry
or an `implementers` key may now be a **profile name** that resolves to its pool — in
addition to a bare binary or inline pool. Weights stay as map values (no `:` weight
suffix). Implementers resolve a profile by load-balancing within it after the weighted
type-rotation pick. Fully backward compatible.

## New Config Fields

| Field          | Type                                               | Notes                                                                                 |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `poolProfiles` | `Record<string, Record<string,number>>` (optional) | Named pools, referenced by name from review/verify type entries and implementer keys. |

## New / Changed Exports

| Symbol                              | Kind     | Notes                                                           |
| ----------------------------------- | -------- | --------------------------------------------------------------- |
| `PoolProfiles`                      | type     | `Record<string, Record<string, number>>`                        |
| `resolvePool(entry, profiles?)`     | function | Resolve a type entry (profile name / binary / inline) to a pool |
| `selectFromPool(entry, profiles?)`  | function | Now takes optional `profiles` to resolve a profile name         |
| `reviewTypeLabel(entry, profiles?)` | function | A profile reference now displays as the profile name            |
| `selectImplementer`                 | function | A profile-name implementer key resolves to a pool account       |

---

Spec: matrix-reviews-lens-type-pool
Date: 2026-06-21

## Summary

Reviews are now a **LENS × TYPE** matrix. A _type_ (a `reviewPhases` entry) may be a
single binary or a weighted account **pool** that load-balances per invocation
(separate from implementer type-rotation). A _lens_ is the review focus prompt; the
reviewer prompt is now **plumbing (mechanics) + lens (focus)**. Every type runs every
lens. Fully backward compatible: no `reviewLenses` ⇒ single `general` lens; a string
type ⇒ single-account pool.

## New Config Fields

| Field                    | Type                               | Default       | Notes                                                |
| ------------------------ | ---------------------------------- | ------------- | ---------------------------------------------------- |
| `reviewLenses`           | `string[]`                         | `['general']` | Which lenses run (rows of the matrix).               |
| `lensProfiles`           | `Record<string,string>` (optional) | —             | Override/add lens focus text; merged over built-ins. |
| `reviewPhases[][]` entry | `string \| Record<string,number>`  | —             | A type entry may now be a weighted account pool.     |
| `verifyPhases[][]` entry | `string \| Record<string,number>`  | —             | Verify types may be pools too (no lenses).           |

## New Exports

| Symbol                                                                                           | Kind       | Notes                                          |
| ------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------- |
| `ReviewTypeEntry`                                                                                | type       | `string \| Record<string, number>`             |
| `normalizeReviewType` / `reviewTypeLabel`/`selectFromPool`                                       | functions  | Pool helpers (weighted-random per invocation). |
| `REVIEWER_PLUMBING_PROMPT` / `REVIEW_LENS_PROFILES` / `resolveLensFocus` / `DEFAULT_REVIEW_LENS` | prompt API | Reviewer prompt = plumbing + lens.             |

## Behavior / Events

- `reviewer_start` / `reviewer_end` events gain `reviewerIndex`, `lens`, `reviewType`.
- `MaterializedAgentState` gains `lens`, `reviewType`; dashboards (web + CLI status) show them.
- `buildReviewerPrompt` composes `REVIEWER_PLUMBING_PROMPT` + the lens focus (via `{lensFocus}`); a custom `prompts.reviewer` is still used verbatim.

---

Spec: revert-scratch-promotion-direct-global-writes
Date: 2026-06-21

## Summary

Reverted the scratch-artifact protocol. Agents now write their outputs **directly** to
the global store (`~/.kloop/{runId}/...`) instead of writing to a per-workspace
`.kloop/scratch/` dir with `.meta` companions that the host runner promoted afterward.
Codex agents (workspace-write sandbox) are granted write access to the global store via
`--add-dir`. Also adds reviewer retry-on-transport-failure.

## Breaking Changes

| Category     | Symbol                              | Before                                           | After                                                                    |
| ------------ | ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Paths        | `Paths.scratchDir(cwd)`             | `{cwd}/.kloop/scratch`                           | Removed — no scratch dir; agents write straight to global paths          |
| Agent runner | `AgentRunner.promoteScratchFiles()` | method (scratch → global promotion)              | Removed                                                                  |
| Types        | `ScratchMeta`                       | exported interface                               | Removed                                                                  |
| Types        | `PromotionResult`                   | exported interface                               | Removed                                                                  |
| Prompt vars  | `*PromptVars.scratchDir`            | field on all 6 prompt-var interfaces             | Removed                                                                  |
| Loop runner  | `prepareLoopWorkspace()`            | method (promote-recover + wipe `.kloop/scratch`) | Removed                                                                  |
| Prompts      | Output Protocol / `.meta` blocks    | agents wrote `{artifact}.{ext}` + `.meta` twins  | Removed — prompts name the exact global destination path for each output |
| Codex cmd    | `codex exec --full-auto …`          | workspace-write sandbox, no global write         | adds `--add-dir "{kloopHome}"` so codex can write to `~/.kloop`          |

## New Exports

### Config Fields

| Field                         | Type     | Default | Notes                                                                               |
| ----------------------------- | -------- | ------- | ----------------------------------------------------------------------------------- |
| `reviewerRetry.maxRetries`    | `number` | `2`     | Retry a reviewer that produced NO parseable verdict (transport/crash/timeout), 0-10 |
| `reviewerRetry.backoffBaseMs` | `number` | `5000`  | Base backoff delay, doubles each retry, min 0                                       |

---

Spec: synthesis-verify-dynamic-ordering
Date: 2026-04-13

## Breaking Changes

| Category         | Symbol                              | Before                                  | After                                                                                                              |
| ---------------- | ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Config           | `dynamicReviewOrdering`             | `{ enabled: boolean }`                  | Removed — replaced by `rerankAfterCheckpoint: boolean`                                                             |
| Config           | `reReview`                          | `{ enabled, phases, timeout }`          | Removed — replaced by flat `verify`, `verifyPhases`, `verifyTimeout` (backward compat transform accepts old shape) |
| Config           | `synthesis`                         | `{ enabled: boolean }`                  | `boolean` — flattened (backward compat transform accepts old shape)                                                |
| Config           | `prompts.reReviewer`                | `string?`                               | Removed — replaced by `prompts.verifier` (backward compat transform accepts old key)                               |
| Event types      | `re_review_phase_start`             | emitted as `re_review_phase_start`      | `verify_phase_start` (materializer normalizes old names)                                                           |
| Event types      | `re_reviewer_start`                 | emitted as `re_reviewer_start`          | `verifier_start` (materializer normalizes old names)                                                               |
| Event types      | `re_reviewer_end`                   | emitted as `re_reviewer_end`            | `verifier_end` (materializer normalizes old names)                                                                 |
| Event types      | `re_review_phase_end`               | emitted as `re_review_phase_end`        | `verify_phase_end` (materializer normalizes old names)                                                             |
| Types            | `MaterializedReReviewPhase`         | interface                               | Renamed to `MaterializedVerifyPhase`                                                                               |
| Types            | `MaterializedLoop.reReviewPhases`   | field                                   | Renamed to `MaterializedLoop.verifyPhases`                                                                         |
| Types            | `LoopSummary.reReviewPhases`        | field                                   | Renamed to `LoopSummary.verifyPhases`                                                                              |
| Event types (TS) | `RE_REVIEW_PHASE_START` etc.        | `EVENT_TYPES.RE_REVIEW_*`               | `EVENT_TYPES.VERIFY_PHASE_*` / `EVENT_TYPES.VERIFIER_*`                                                            |
| Interfaces       | `ReReviewPhaseStartEvent` etc.      | 4 interfaces                            | Renamed to `VerifyPhaseStartEvent`, `VerifierStartEvent`, `VerifierEndEvent`, `VerifyPhaseEndEvent`                |
| Prompt builders  | `buildReReviewerPrompt`             | function                                | Renamed to `buildVerifierPrompt`                                                                                   |
| Prompt builders  | `ReReviewerPromptVars`              | interface                               | Renamed to `VerifierPromptVars` (field `reReviewerIndex` → `verifierIndex`)                                        |
| Prompt builders  | `ReSynthesisPromptVars.rereviewDir` | field                                   | Renamed to `ReSynthesisPromptVars.verifyDir`                                                                       |
| Constants        | `DEFAULT_RE_REVIEWER_PROMPT`        | constant                                | Renamed to `DEFAULT_VERIFIER_PROMPT`                                                                               |
| Agent runner     | `ReReviewerResult`                  | interface                               | Renamed to `VerifierResult`                                                                                        |
| Agent runner     | `runReReviewerPhase()`              | method                                  | Renamed to `runVerifierPhase()`                                                                                    |
| Agent runner     | `runReReviewer()`                   | method                                  | Renamed to `runVerifier()`                                                                                         |
| Agent runner     | `getReReviewPhases()`               | method                                  | Renamed to `getVerifyPhases()` — reads `config.verifyPhases` instead of `config.reReview?.phases`                  |
| Loop runner      | `runReReviewGate()`                 | method (private)                        | Renamed to `runVerifyGate()`                                                                                       |
| Format           | `formatReReviewStart()`             | function                                | Renamed to `formatVerifyStart()`                                                                                   |
| Format           | `formatReReviewResult()`            | function                                | Renamed to `formatVerifyResult()`                                                                                  |
| Format           | `formatAgentLaunch` role            | `'rereviewer'`                          | `'verifier'`                                                                                                       |
| Paths            | `loopReReviewPath()`                | `{kloopHome}/{runId}/loop-{N}/rereview` | Renamed to `loopVerifyPath()` → `{kloopHome}/{runId}/loop-{N}/verify`                                              |
| Runtime dirs     | `rereview/rereviewer-{N}/`          | agent output dir                        | `verify/verifier-{N}/`                                                                                             |
| Runtime files    | `verdicts/rereviewer-{N}.json`      | verdict file                            | `verdicts/verifier-{N}.json`                                                                                       |
| CLI labels       | `re-review: on/off`                 | status/describe                         | `verify: on/off`                                                                                                   |
| CLI labels       | `Re-review: on/off`                 | describe                                | `Verify: on/off`                                                                                                   |
| CLI phase label  | `re-reviewing`                      | running phase                           | `verifying`                                                                                                        |

## New Exports

### Config Fields

| Field                            | Type         | Default               | Notes                                                                                       |
| -------------------------------- | ------------ | --------------------- | ------------------------------------------------------------------------------------------- |
| `synthesis`                      | `boolean`    | `true`                | Enable/disable synthesis (flattened from `{ enabled }`)                                     |
| `synthesisTimeout`               | `number`     | `15`                  | Synthesis agent timeout in minutes (was borrowing `reviewerTimeout`)                        |
| `verify`                         | `boolean`    | `true`                | Enable/disable verify gate (renamed from `reReview.enabled`)                                |
| `verifyPhases`                   | `string[][]` | `[['claude:claude']]` | Verify phase reviewer configs (renamed from `reReview.phases`)                              |
| `verifyTimeout`                  | `number`     | `5`                   | Verify agent timeout in minutes (renamed from `reReview.timeout`)                           |
| `rerankAfterCheckpoint`          | `boolean`    | `true`                | Replaces `dynamicReviewOrdering`. Re-ranks reviewers by trouble score after checkpoint runs |
| `implementerRetry.maxRetries`    | `number`     | `2`                   | Max retry attempts on implementer crash (exit code 1), range 0-10                           |
| `implementerRetry.backoffBaseMs` | `number`     | `5000`                | Base backoff delay, doubles each retry, min 0                                               |
| `firstIterationWeightMultiplier` | `number`     | `2`                   | Weight multiplier for `::i` implementers on loop 1, range 1-10                              |
| `prompts.synthesizer`            | `string?`    | -                     | Custom synthesizer prompt template                                                          |
| `prompts.verifier`               | `string?`    | -                     | Custom verifier prompt template (renamed from `prompts.reReviewer`)                         |
| `prompts.reSynthesizer`          | `string?`    | -                     | Custom re-synthesizer prompt template                                                       |

### Event Types

| Event Type           | Key Fields                                                                              | Emitted When                               |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| `verify_phase_start` | `loop`, `phase`, `reviewers[]`                                                          | Verify phase begins (loop 2+)              |
| `verifier_start`     | `loop`, `phase`, `reviewer`, `harness?`                                                 | Verifier agent starts                      |
| `verifier_end`       | `loop`, `phase`, `reviewer`, `harness?`, `exitCode`, `durationMs`, `error?`, `verdict?` | Verifier agent completes                   |
| `verify_phase_end`   | `loop`, `phase`, `shortCircuited`                                                       | Verify phase ends                          |
| `synthesis_start`    | `loop`, `binary`, `harness?`                                                            | Synthesizer agent starts                   |
| `synthesis_end`      | `loop`, `binary`, `harness?`, `exitCode`, `durationMs`, `error?`, `summaryPath?`        | Synthesizer agent completes                |
| `implementer_retry`  | `loop`, `attempt`, `maxRetries`, `previousBinary`, `newBinary`, `backoffMs`             | Implementer crash retry (between attempts) |
| `crashed`            | `loop`, `exitCode`, `error`                                                             | Implementer retries exhausted              |

### Types & Interfaces

| Name                                   | File                    | Kind             | Notes                                                              |
| -------------------------------------- | ----------------------- | ---------------- | ------------------------------------------------------------------ |
| `VerifyPhaseStartEvent`                | `src/types.ts`          | interface        | Event for verify phase start                                       |
| `VerifierStartEvent`                   | `src/types.ts`          | interface        | Event for verifier start                                           |
| `VerifierEndEvent`                     | `src/types.ts`          | interface        | Event for verifier end                                             |
| `VerifyPhaseEndEvent`                  | `src/types.ts`          | interface        | Event for verify phase end                                         |
| `SynthesisStartEvent`                  | `src/types.ts`          | interface        | Event for synthesis start                                          |
| `SynthesisEndEvent`                    | `src/types.ts`          | interface        | Event for synthesis end                                            |
| `ImplementerRetryEvent`                | `src/types.ts`          | interface        | Event for implementer retry                                        |
| `CrashedEvent`                         | `src/types.ts`          | interface        | Event for implementer crash                                        |
| `MaterializedVerifyPhase`              | `src/types.ts`          | interface        | Materialized state for verify phases                               |
| `MaterializedSynthesis`                | `src/types.ts`          | interface        | Materialized state for synthesis                                   |
| `VerifierPromptVars`                   | `src/agents/prompts.ts` | interface        | Template variables for verifier prompt                             |
| `SynthesizerPromptVars`                | `src/agents/prompts.ts` | interface        | Template variables for synthesizer prompt                          |
| `ReSynthesisPromptVars`                | `src/agents/prompts.ts` | interface        | Template variables for re-synthesis prompt                         |
| `VerifierResult`                       | `src/agents/runner.ts`  | interface        | Result from verifier agent (verdict, issuesFixed, issuesRemaining) |
| `SynthesizerResult`                    | `src/agents/runner.ts`  | interface        | Result from synthesizer agent (summaryPath)                        |
| `CrashedError`                         | `src/loop/runner.ts`    | class (internal) | Thrown when implementer retries exhausted                          |
| `ParsedBinary.firstIterationPreferred` | `src/types.ts`          | field            | `::i` suffix flag on implementer config                            |

### Functions

| Name                      | File                    | Signature                                  | Notes                                                            |
| ------------------------- | ----------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `buildVerifierPrompt`     | `src/agents/prompts.ts` | `(template?, vars) => string`              | Build verifier prompt (renamed from `buildReReviewerPrompt`)     |
| `buildSynthesizerPrompt`  | `src/agents/prompts.ts` | `(template?, vars) => string`              | Build synthesizer prompt                                         |
| `buildReSynthesisPrompt`  | `src/agents/prompts.ts` | `(template?, vars) => string`              | Build re-synthesis prompt                                        |
| `runVerifierPhase`        | `src/agents/runner.ts`  | `(params) => Promise<VerifierResult[]>`    | Run verify phase (renamed from `runReReviewerPhase`)             |
| `runVerifier`             | `src/agents/runner.ts`  | `(params) => Promise<VerifierResult>`      | Run single verifier (renamed from `runReReviewer`)               |
| `getVerifyPhases`         | `src/agents/runner.ts`  | `() => string[][]`                         | Get verify phases from config (renamed from `getReReviewPhases`) |
| `runSynthesizer`          | `src/agents/runner.ts`  | `(params) => Promise<SynthesizerResult>`   | Run synthesizer agent                                            |
| `runReSynthesizer`        | `src/agents/runner.ts`  | `(params) => Promise<SynthesizerResult>`   | Run re-synthesis agent                                           |
| `formatVerifyStart`       | `src/loop/format.ts`    | `() => void`                               | Display verify gate start (renamed from `formatReReviewStart`)   |
| `formatVerifyResult`      | `src/loop/format.ts`    | `(passed, results) => void`                | Display verify gate result (renamed from `formatReReviewResult`) |
| `formatSynthesisStart`    | `src/loop/format.ts`    | `() => void`                               | Display synthesis start                                          |
| `formatSynthesisResult`   | `src/loop/format.ts`    | `(summaryCreated, durationMs) => void`     | Display synthesis result                                         |
| `formatReSynthesisStart`  | `src/loop/format.ts`    | `() => void`                               | Display re-synthesis start                                       |
| `formatReSynthesisResult` | `src/loop/format.ts`    | `(summaryCreated, durationMs) => void`     | Display re-synthesis result                                      |
| `formatImplementerRetry`  | `src/loop/format.ts`    | `(attempt, maxRetries, backoffMs) => void` | Display retry attempt/backoff                                    |

### Constants

| Name                          | File                            | Notes                                                                |
| ----------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `DEFAULT_VERIFIER_PROMPT`     | `src/agents/default-prompts.ts` | Verifier prompt template (renamed from `DEFAULT_RE_REVIEWER_PROMPT`) |
| `DEFAULT_SYNTHESIZER_PROMPT`  | `src/agents/default-prompts.ts` | Synthesizer prompt template                                          |
| `DEFAULT_RE_SYNTHESIS_PROMPT` | `src/agents/default-prompts.ts` | Re-synthesis prompt template                                         |

### Prompt Templates

| Name                  | Constant                      | Placeholders                                                                                                                                     | Notes                                                                            |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Synthesizer           | `DEFAULT_SYNTHESIZER_PROMPT`  | `{specPath}`, `{iteration}`, `{reviewsDir}`, `{verdictsDir}`, `{previousSummaryPath}`, `{summaryOutputPath}`, `{learningsFile}`, `{evidenceDir}` | Compacts all raw reviews into structured `review-summary.md`                     |
| Verifier              | `DEFAULT_VERIFIER_PROMPT`     | `{specPath}`, `{iteration}`, `{previousSummaryPath}`, `{reviewsDir}`, `{verdictsDir}`, `{evidenceDir}`, `{learningsFile}`, `{verifierIndex}`     | Checks if previous issues were fixed (renamed from `DEFAULT_RE_REVIEWER_PROMPT`) |
| Re-synthesizer        | `DEFAULT_RE_SYNTHESIS_PROMPT` | `{specPath}`, `{iteration}`, `{previousSummaryPath}`, `{verifyDir}`, `{verdictsDir}`, `{summaryOutputPath}`, `{learningsFile}`                   | Merges previous synthesis + verifier outputs (lightweight)                       |
| Implementer (updated) | `DEFAULT_IMPLEMENTER_PROMPT`  | `{specPath}`, `{iteration}`, `{reviewsDir}`, `{evidenceDir}`, `{learningsFile}`, `{reviewSummaryPath}`                                           | Added self-review step (step 6), addressed-reviews (step 7)                      |

### Runtime Directories

| Path Pattern                            | Created By                   | When                                       |
| --------------------------------------- | ---------------------------- | ------------------------------------------ |
| `{runId}/loop-{N}/synthesis/`           | Synthesizer / re-synthesizer | After reviews complete or verify gate fail |
| `{runId}/loop-{N}/verify/`              | Verifier agents              | During verify gate on loop 2+              |
| `{runId}/loop-{N}/verify/verifier-{N}/` | Individual verifier agent    | Per-verifier output                        |

### Runtime Files

| Path Pattern                                     | Writer                       | Format      | Purpose                                                 |
| ------------------------------------------------ | ---------------------------- | ----------- | ------------------------------------------------------- |
| `{runId}/loop-{N}/synthesis/review-summary.md`   | Synthesizer / re-synthesizer | Markdown    | Structured review summary (primary input for next loop) |
| `{runId}/loop-{N}/synthesis/prompt.md`           | Synthesizer agent            | Markdown    | Prompt used for synthesis                               |
| `{runId}/loop-{N}/synthesis/log`                 | Synthesizer agent            | Stream JSON | Agent output log                                        |
| `{runId}/loop-{N}/verify/verifier-{N}/prompt.md` | Verifier agent               | Markdown    | Prompt used for verify                                  |
| `{runId}/loop-{N}/verify/verifier-{N}/log`       | Verifier agent               | Stream JSON | Verifier output log                                     |
| `{runId}/loop-{N}/verdicts/verifier-{N}.json`    | Verifier agent               | JSON        | Verdict with issuesFixed/issuesRemaining                |
| `{runId}/loop-{N}/evidence/self-review.md`       | Implementer                  | Markdown    | Implementer self-review findings                        |
| `{runId}/loop-{N}/evidence/addressed-reviews.md` | Implementer                  | Markdown    | How implementer addressed previous reviews              |

### Paths (`src/deps.ts`)

| Name                                     | Pattern                                     | Notes                                                     |
| ---------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `loopSynthesisPath(runId, loopIndex)`    | `{kloopHome}/{runId}/loop-{N}/synthesis`    | Synthesis output dir                                      |
| `loopVerifyPath(runId, loopIndex)`       | `{kloopHome}/{runId}/loop-{N}/verify`       | Verify agent output dir (renamed from `loopReReviewPath`) |
| `loopCheckpointerPath(runId, loopIndex)` | `{kloopHome}/{runId}/loop-{N}/checkpointer` | Checkpointer output dir                                   |

### CLI Display

| Function                  | File                 | Notes                                                                                                |
| ------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `formatVerifyStart`       | `src/loop/format.ts` | "verify gate -- checking previous issues..."                                                         |
| `formatVerifyResult`      | `src/loop/format.ts` | "verify: passed/failed"                                                                              |
| `formatSynthesisStart`    | `src/loop/format.ts` | "synthesizing reviews..."                                                                            |
| `formatSynthesisResult`   | `src/loop/format.ts` | "synthesis -- review-summary.md written/failed"                                                      |
| `formatReSynthesisStart`  | `src/loop/format.ts` | "re-synthesizing from verifier outputs..."                                                           |
| `formatReSynthesisResult` | `src/loop/format.ts` | "re-synthesis -- review-summary.md updated/failed"                                                   |
| `formatImplementerRetry`  | `src/loop/format.ts` | "implementer retry N/max (backoff X.Xs)"                                                             |
| `formatAgentLaunch`       | `src/loop/format.ts` | Role union: `'impl' \| 'reviewer' \| 'checkpoint' \| 'synthesizer' \| 'verifier' \| 'resynthesizer'` |

### CLI Status (`src/cli/status.ts`)

| Display         | Format                                                                     | Notes                       |
| --------------- | -------------------------------------------------------------------------- | --------------------------- |
| Config line     | `synthesis: on/off \| verify: on/off \| rerank: on/off \| impl-retry: N`   | Summary of feature flags    |
| Phase label     | `verifying`                                                                | When verify gate is running |
| `--json` output | `verify`, `verifyPhases`, `verifyTimeout`, `synthesis`, `synthesisTimeout` | Flat config fields          |

### CLI Describe (`src/cli/describe.ts`)

| Display         | Format                                                                                     | Notes                    |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| Config line     | `Synthesis: on/off \| Verify: on/off \| Rerank: on/off \| Impl-retry: N \| ::i weight: Nx` | Feature flags            |
| Verdict label   | `REJECTED (verify gate)`                                                                   | When verify gate rejects |
| `--json` output | `verify`, `verifyPhases`, `verifyTimeout`, `synthesis`, `synthesisTimeout`                 | Flat config fields       |

### Run Exit Statuses

| Status    | Exit Code | Condition                                              |
| --------- | --------- | ------------------------------------------------------ |
| `crashed` | 1         | Implementer retry exhausted (all attempts exit code 1) |

### Pipeline

| Aspect            | Before                         | After                                                                                                                                            |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loop 1            | implementer → review → loop    | implementer (retry on crash, `::i` preferred) → review phases → synthesis → loop                                                                 |
| Loop 2+           | implementer → review → loop    | implementer (retry on crash) → verify gate (cheap) → [fail: re-synthesis → loop] → [pass: review phases] → checkpoint → reorg → synthesis → loop |
| Implementer       | Single run, failure → continue | Retry on exit 1 with backoff, throw `CrashedError` on exhaustion                                                                                 |
| Verify fail path  | N/A (new)                      | Runs `runReSynthesisPhase` (lighter, reads verifier outputs), skips expensive reviewers                                                          |
| Checkpoint reorg  | `getDynamicReviewPhases`       | `getReorganizedPhases` — trouble score sorts reviewers, guarded by `rerankAfterCheckpoint`                                                       |
| `::i` weight      | Hardcoded `weight * 2`         | `weight * config.firstIterationWeightMultiplier`                                                                                                 |
| Synthesis timeout | Borrowed `reviewerTimeout`     | Dedicated `synthesisTimeout` (default 15)                                                                                                        |
| Verify timeout    | Was `reReview.timeout`         | Flat `verifyTimeout` (default 5)                                                                                                                 |

### Materializer (`src/status/materialize.ts`)

| Feature                          | Notes                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `VERIFY_PHASE_START/END`         | Creates/completes `MaterializedVerifyPhase` in `loop.verifyPhases`                                      |
| `VERIFIER_START/END`             | Updates verifier agent state within verify phase                                                        |
| `SYNTHESIS_START/END`            | Creates/completes `MaterializedSynthesis` in `loop.synthesis`                                           |
| `IMPLEMENTER_RETRY`              | Informational no-op                                                                                     |
| `IMPLEMENTER_END`                | Reads `retryAttempt`/`maxRetries` into `MaterializedAgentState`                                         |
| `markRunningAgentsInterrupted()` | Handles `verifyPhases` and `synthesis`                                                                  |
| Legacy event normalization       | `LEGACY_EVENT_MAP` translates `re_review_*`/`re_reviewer_*` → `verify_*`/`verifier_*` before processing |

### Verdicts (`src/agents/verdicts.ts`)

| Field             | Type        | Notes                              |
| ----------------- | ----------- | ---------------------------------- |
| `issuesFixed`     | `string[]?` | Issues confirmed fixed by verifier |
| `issuesRemaining` | `string[]?` | Issues still unfixed per verifier  |

### Iteration Data (`src/loop/iteration.ts`)

| Field               | Type             | Notes                                                          |
| ------------------- | ---------------- | -------------------------------------------------------------- |
| `reviewSummaryPath` | `string \| null` | Previous loop's `synthesis/review-summary.md` (null on loop 1) |

## Modified Exports

### Config Fields

| Field     | Change                                                           | Notes                                                   |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `prompts` | Added `synthesizer`, `verifier`, `reSynthesizer` optional fields | Custom prompt templates for all synthesis/verify agents |

### Types & Interfaces

| Name                     | File                    | Change                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config`                 | `src/types.ts`          | Added `synthesis` (bool), `synthesisTimeout`, `verify`, `verifyPhases`, `verifyTimeout`, `rerankAfterCheckpoint`, `implementerRetry`, `firstIterationWeightMultiplier`. Removed `dynamicReviewOrdering`, `reReview`, `synthesis: { enabled }` |
| `ImplementerEndEvent`    | `src/types.ts`          | Added optional `retryAttempt`, `maxRetries`                                                                                                                                                                                                   |
| `MaterializedAgentState` | `src/types.ts`          | Added optional `retryAttempt`, `retryMax`                                                                                                                                                                                                     |
| `MaterializedLoop`       | `src/types.ts`          | Added `synthesis?: MaterializedSynthesis`, `verifyPhases?: MaterializedVerifyPhase[]`                                                                                                                                                         |
| `LoopSummary`            | `src/types.ts`          | Added optional `implementerRetryAttempts`, `verifyPhases`                                                                                                                                                                                     |
| `KloopEvent`             | `src/types.ts`          | Union extended with all new event types                                                                                                                                                                                                       |
| `LoopResult`             | `src/loop/runner.ts`    | Added `'crashed'` to status union                                                                                                                                                                                                             |
| `ImplementerPromptVars`  | `src/agents/prompts.ts` | Added optional `reviewSummaryPath?: string`                                                                                                                                                                                                   |

### Event Types

| Event Type        | Change                                            |
| ----------------- | ------------------------------------------------- |
| `implementer_end` | New optional fields: `retryAttempt`, `maxRetries` |

### Functions

| Name                    | File                 | Change                                                                        |
| ----------------------- | -------------------- | ----------------------------------------------------------------------------- |
| `selectImplementer`     | `src/types.ts`       | Uses `config.firstIterationWeightMultiplier` instead of hardcoded 2           |
| `formatAgentLaunch`     | `src/loop/format.ts` | Role union extended with `'verifier'`, `'resynthesizer'` (was `'rereviewer'`) |
| `formatDynamicOrdering` | `src/loop/format.ts` | Label changed from "dynamic review ordering" to "reranked review phases"      |

## Removed Exports

| Category            | Symbol                       | Replacement                                 | Notes                                                           |
| ------------------- | ---------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Config              | `dynamicReviewOrdering`      | `rerankAfterCheckpoint`                     | Object `{ enabled: boolean }` → flat `boolean`                  |
| Config              | `reReview`                   | `verify` + `verifyPhases` + `verifyTimeout` | Nested object → three flat fields (transform accepts old shape) |
| Config              | `synthesis: { enabled }`     | `synthesis: boolean`                        | Nested object → flat boolean (transform accepts old shape)      |
| Config              | `prompts.reReviewer`         | `prompts.verifier`                          | Renamed (transform accepts old key)                             |
| Types               | `MaterializedReReviewPhase`  | `MaterializedVerifyPhase`                   | Renamed                                                         |
| Types               | `ReReviewPhaseStartEvent`    | `VerifyPhaseStartEvent`                     | Renamed                                                         |
| Types               | `ReReviewerStartEvent`       | `VerifierStartEvent`                        | Renamed                                                         |
| Types               | `ReReviewerEndEvent`         | `VerifierEndEvent`                          | Renamed                                                         |
| Types               | `ReReviewPhaseEndEvent`      | `VerifyPhaseEndEvent`                       | Renamed                                                         |
| Types               | `ReReviewerPromptVars`       | `VerifierPromptVars`                        | Renamed, field `reReviewerIndex` → `verifierIndex`              |
| Types               | `ReReviewerResult`           | `VerifierResult`                            | Renamed                                                         |
| Constants           | `DEFAULT_RE_REVIEWER_PROMPT` | `DEFAULT_VERIFIER_PROMPT`                   | Renamed                                                         |
| Functions           | `buildReReviewerPrompt`      | `buildVerifierPrompt`                       | Renamed                                                         |
| Functions           | `runReReviewerPhase`         | `runVerifierPhase`                          | Renamed                                                         |
| Functions           | `runReReviewer`              | `runVerifier`                               | Renamed                                                         |
| Functions           | `getReReviewPhases`          | `getVerifyPhases`                           | Renamed                                                         |
| Functions           | `formatReReviewStart`        | `formatVerifyStart`                         | Renamed                                                         |
| Functions           | `formatReReviewResult`       | `formatVerifyResult`                        | Renamed                                                         |
| Functions (private) | `getDynamicReviewPhases`     | `getReorganizedPhases`                      | Renamed                                                         |
| Functions (private) | `runReReviewGate`            | `runVerifyGate`                             | Renamed                                                         |
| Functions (private) | `groupReReviewersByPhase`    | `groupVerifiersByPhase`                     | Renamed                                                         |
| Functions (private) | `findReReviewer`             | `findVerifier`                              | Renamed (materializer)                                          |
| Paths               | `loopReReviewPath`           | `loopVerifyPath`                            | Renamed, dir `rereview/` → `verify/`                            |
| Event strings       | `re_review_phase_start`      | `verify_phase_start`                        | Renamed (materializer handles both)                             |
| Event strings       | `re_reviewer_start`          | `verifier_start`                            | Renamed (materializer handles both)                             |
| Event strings       | `re_reviewer_end`            | `verifier_end`                              | Renamed (materializer handles both)                             |
| Event strings       | `re_review_phase_end`        | `verify_phase_end`                          | Renamed (materializer handles both)                             |

## Backward Compatibility

| Area                        | Old Shape                                                | New Shape                                                           | Migration                                                    |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Config `reReview`           | `{ enabled: bool, phases: string[][], timeout: number }` | `verify: bool`, `verifyPhases: string[][]`, `verifyTimeout: number` | Zod transform resolves both; 122 `~/.kloop` configs migrated |
| Config `synthesis`          | `{ enabled: bool }`                                      | `boolean`                                                           | Zod transform accepts both `true` and `{ enabled: true }`    |
| Config `prompts.reReviewer` | `reReviewer: string`                                     | `verifier: string`                                                  | Transform maps old key to new                                |
| Event names                 | `re_review_*`, `re_reviewer_*`                           | `verify_phase_*`, `verifier_*`                                      | `LEGACY_EVENT_MAP` in materializer normalizes before switch  |
| Runtime dirs                | `rereview/rereviewer-{N}/`                               | `verify/verifier-{N}/`                                              | Old runs keep old dirs; describe/status check both           |

## Breaking for Consumers

| Impact                                                             | Affected Consumers                                                                 | Mitigation                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `reReview` removed from config (flat fields instead)               | `kloop init` (generates config.yaml), `/kloop` skill, any tool parsing config.yaml | Use `verify: true`, `verifyPhases: [...]`, `verifyTimeout: N` instead. Old shape still parsed via transform. |
| `synthesis` flattened from `{ enabled }` to `boolean`              | Config generators, YAML templates                                                  | Use `synthesis: true` instead of `synthesis: { enabled: true }`. Old shape still parsed.                     |
| `prompts.reReviewer` → `prompts.verifier`                          | Custom prompt configs                                                              | Old key still parsed via transform.                                                                          |
| `re_review_*` / `re_reviewer_*` events renamed                     | Event stream consumers (watchers, materializers)                                   | Materializer normalizes old names. External consumers should handle both.                                    |
| `dynamicReviewOrdering` removed from config                        | Config parsers, YAML templates                                                     | Use `rerankAfterCheckpoint: true`.                                                                           |
| `reReview` / `synthesis: { enabled }` removed from `--json` output | `kloop status --json`, `kloop describe --json`, any JSON consumer                  | Use new flat fields: `verify`, `verifyPhases`, `verifyTimeout`, `synthesis` (bool), `synthesisTimeout`.      |
| New `synthesisTimeout` field                                       | Config parsers that reject unknown fields                                          | Optional with default 15 — only breaks strict-unknown-field validators.                                      |
| New event types in `events.jsonl`                                  | Any tool parsing event stream                                                      | Must handle unknown event types gracefully; 8 new types added.                                               |
| `LoopResult.status` now includes `'crashed'`                       | CLI exit code handlers, status renderers                                           | Handle `'crashed'` like `'failed'` with specific messaging.                                                  |
| `MaterializedLoop.verifyPhases` (was `reReviewPhases`)             | Tools reading `status.yaml`                                                        | Field renamed; old runs may have `reReviewPhases` in cached status files.                                    |
