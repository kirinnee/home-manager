# Spec: kloop CLI Polish

## Objective

Fix table alignment, add human-friendly time formatting, show checkpointer info everywhere, add `summary`/`review` subcommands, and generate LLM-evaluated summaries.

---

## 1. `ps` / `ps -a` — Fix table alignment

**Problem:** Manual `padEnd`/`padStart` with ANSI color codes breaks alignment because picocolors escape sequences are counted as characters.

**Fix:** Use `cli-table3` (or equivalent) for proper column-aligned tables that handle ANSI escape codes correctly. Columns:

| RUN ID | WORKSPACE | STATUS | LOOP | VERDICT | AGE | DURATION |
| ------ | --------- | ------ | ---- | ------- | --- | -------- |

- WORKSPACE: truncate with `…` prefix if too long, `~` for HOME
- VERDICT: color-coded, truncate with `…` if >20 chars
- AGE: human time (see §2)
- DURATION: human time (see §2)

**Files:** `src/cli/ps.ts`

---

## 2. `status` — Human-friendly times + checkpointer

### Duration format (used everywhere)

Show the largest non-zero units from: days, hours, minutes, seconds. Examples:

- `2d 3h 12m`
- `1h 24m 6s`
- `45m 2s`
- `12s`

### Age format ("how long ago")

- If older than 2 days: show date like `Mar 26` (or `Mar 26, 14:30`)
- If <= 2 days: show `Xd Yh ago` (e.g. `1d 3h ago`, `4h 12m ago`, `23m ago`)

### What to add to `status` output

1. **Header line** — show both `started` and `duration`:

   ```
   Run: abc123  [RUNNING]  started 2h 15m ago  (running for 1h 30m)
   ```

   For completed:

   ```
   Run: abc123  [COMPLETED]  started Mar 26, 14:30  ran for 2d 1h 12m  completed 3h ago
   ```

2. **Checkpointer info** — in the current iteration section, show checkpoint status:
   - If checkpoint ran: `checkpoint: spec_auto_fixed (45%)  spec was auto-fixed, 3 criteria remaining`
   - Show the full summary text (not truncated)
   - Color by outcome: `conflict_found` = red, `spec_auto_fixed` = green, `spec_compressed` = blue, `no_action` = dim

**Files:** `src/cli/status.ts`

---

## 3. `describe` — Same time formatting + checkpointer, no truncation

Same time formatting as §2. Show **all** loop iterations in full detail (not truncated). Add:

- **Run header**: started date, total duration, completed age (same as status)
- **Per-iteration**: show duration + when it ran
- **Checkpointer info per iteration**: show full summary text, not truncated. Include:
  - outcome (color-coded)
  - progress percent
  - summary text (full, no slice)

**Files:** `src/cli/describe.ts`

---

## 4. `metrics` — Add checkpointer rows + phase label

### Add checkpointer samples

The checkpointer already emits metrics to `metrics.jsonl`. Ensure they appear in the raw table with `agent=checkpointer`.

### Add `phase` label for grouping

Each sample already has `phaseIdx`. Add a derived `phase` label:

- `impl` for `agent=implementer`
- `review` for `agent=reviewer`
- `checkpoint` for `agent=checkpointer`

This allows queries like:

```
kloop metrics "sum by (phase)"
kloop metrics "avg by (phase, binary)"
```

### Raw table update

Replace `pidx` column with `phase` column showing `impl`, `review`, or `checkpoint`.

**Files:** `src/cli/metrics.ts`

---

## 5. Summary MD — LLM-evaluated run summary

Generate `{runDir}/summary.md` using an LLM to evaluate what happened in each phase/reviewer/agent. The summary should be a short narrative of what the loop did.

### Format:

```markdown
# Run Summary: {runId}

## Overview

- **Status**: completed (consensus)
- **Duration**: 2d 3h 12m
- **Iterations**: 5 / 10
- **Started**: Mar 26, 14:30
- **Completed**: Mar 28, 17:42

## Iteration 1 (45m)

**Implementer** (claude): Implemented the base API endpoints for user authentication...
**Review** (claude-reviewer): Approved with minor suggestions on error handling...
**Checkpoint**: spec_auto_fixed — 3 of 5 criteria met, updated spec to reflect...

## Iteration 2 (1h 12m)

...
```

### Implementation

- Read all loop summary JSONs + learnings + spec
- Feed to the configured implementer binary via `--print` / prompt
- Save as `{runDir}/summary.md`
- This should be callable via `kloop summary [id]` (see §6)

**Files:** new `src/cli/summary.ts`, `src/loop/format.ts` (helper)

---

## 6. New subcommands: `summary` and `review`

### `kloop summary [id]`

- Generates (or re-generates) the LLM-evaluated summary.md for a run
- If already exists, asks to regenerate (or `--force` to overwrite)
- Prints the summary to stdout
- Optional `--run <id>` or positional `[id]` to specify run (defaults to current workspace)

### `kloop review [id]`

- Shows the reviewer verdicts + reasoning for each iteration
- Per iteration, shows each reviewer's verdict, reasoning, and completion estimate
- No truncation — show full reasoning text
- Optional `[id]` defaults to current workspace

### CLI registration

Add both commands to `src/cli/index.ts`:

```typescript
program.command('summary [id]').description('Generate/show LLM-evaluated run summary')...
program.command('review [id]').description('Show reviewer verdicts and reasoning for each iteration')...
```

**Files:** new `src/cli/summary.ts`, new `src/cli/review.ts`, `src/cli/index.ts`

---

## Implementation Notes

### Shared time formatting

Extract into a shared utility (e.g., `src/loop/format.ts` which already exists):

```typescript
export function formatDurationHuman(ms: number): string {
  // returns "2d 3h 12m", "45m 2s", "12s" etc.
}

export function formatAgeHuman(date: Date): string {
  // returns "Mar 26" if > 2 days, else "1d 3h ago", "4h 12m ago" etc.
}
```

### Table library

Use `cli-table3` (already commonly available) or implement a simple table that strips ANSI for width calculation. Check package.json first — if a table lib is already a dependency, use it.

### Checkpointer data sources

- **Events**: `CHECKPOINT` events in events.jsonl have `outcome`, `summary`
- **Loop summaries**: `summary.json` has `checkpoint.outcome`, `checkpoint.summary`, `checkpoint.progressPercent`
- **Metrics**: checkpointer metrics in `loop-{N}/metrics.jsonl` with `agent=checkpointer`
