# KAgent Run Reference

## CLI Commands

### dev-loop init

Initialize a new dev-loop project.

```bash
dev-loop init \
  [--implementers <weighted_list>] \
  [--review-phases <phase_list>] \
  [--conflict-checker <binary>] \
  [--conflict-check-threshold <n>] \
  [--first-loop-full-review] \
  [--previous-review-propagation <0-1>] \
  [--max-iterations <n>] \
  [--implementer-timeout <mins>] \
  [--reviewer-timeout <mins>]
```

| Option                          | Default                              | Description                                       |
| ------------------------------- | ------------------------------------ | ------------------------------------------------- |
| `--implementers`                | `claude-auto-zai:2,claude-auto-mm:1` | Weighted implementer list (name:weight pairs)     |
| `--review-phases`               | see below                            | Pipe-separated review phases                      |
| `--conflict-checker`            | (none)                               | Binary to check for spec conflicts                |
| `--conflict-check-threshold`    | `3`                                  | Consecutive failures before conflict check        |
| `--first-loop-full-review`      | enabled                              | Always run all review phases on first iteration   |
| `--previous-review-propagation` | `0.75`                               | Probability each reviewer sees prior loop reviews |
| `--max-iterations`              | `10`                                 | Maximum iterations before giving up               |
| `--implementer-timeout`         | `30`                                 | Implementer timeout in minutes                    |
| `--reviewer-timeout`            | `15`                                 | Reviewer timeout in minutes                       |

**Default review phases:**

```
"claude-auto-zai:1,claude-auto-mm:1,claude-auto-seed:0|claude-auto-zai:1,claude-auto-anthropic:1,claude-auto-gemini:0|claude-auto-codex:1,claude-auto-kimi:0"
```

- Phase 1: `claude-auto-zai`, `claude-auto-mm`, `claude-auto-seed` (parallel)
- Phase 2: `claude-auto-zai`, `claude-auto-anthropic` (parallel)
- Phase 3: `claude-auto-codex`, `claude-auto-kimi` (parallel)

**Review phase format:** `"phase1|phase2|phase3"`

- Reviewers within a phase run in parallel
- Phases run in sequence — short-circuit on rejection (skip remaining phases)
- When `--first-loop-full-review` is set, the first iteration runs **all reviewers across all phases in parallel** (no short-circuit); subsequent iterations use normal phased short-circuit

**noVerdictAsFailure suffix:** Append `:0` or `:1` after reviewer name:

| Suffix | Behavior                     | Use for            |
| ------ | ---------------------------- | ------------------ |
| `:1`   | No verdict = failure/reject  | Critical reviewers |
| `:0`   | No verdict = success/approve | Optional/tolerant  |

Default is `:1` if suffix omitted.

**Creates:**

- `.kagent/` directory
- `.kagent/spec.md` (template)
- `.kagent/config.json` (configuration)
- `.kagent/history/` directory

### dev-loop run

Execute the dev-loop. Requires `tmux` to be installed.

```bash
dev-loop run
```

**Exit codes:**

| Code | Status           | Meaning                                    |
| ---- | ---------------- | ------------------------------------------ |
| 0    | `completed`      | All reviewers approved                     |
| 0    | `max_iterations` | Consensus not reached within limit         |
| 1    | `error`          | Runtime error                              |
| 2    | `conflict`       | Conflict checker found spec contradictions |
| 3    | `agent_failure`  | Agent crashed or timed out                 |

**Requires:** `.kagent/config.json` to exist (run `dev-loop init` first)

**Creates during execution:**

- `.kagent/current/run.json` - Run state
- `.kagent/current/sessions/` - Individual session files
- `.kagent/current/verdicts/` - Verdict JSON files
- `.kagent/current/evidence/` - Build/test evidence from implementer
- `.kagent/current/learnings.md` - Learnings from implementer
- `.kagent/current/reviews/` - Review files from reviewers
- `.kagent/logs/{runId}/` - Agent log files
- `.kagent/reviews/{runId}/` - Persistent copies of reviews and verdicts
- `.kagent/current/checkpoint-result.json` - Checkpointer output (if conflict check triggered)

### dev-loop status

Show current loop status.

```bash
dev-loop status
```

**Output includes:**

- Config (implementers, review phases, max iterations, timeouts)
- Run ID, status, iteration, phase, start time
- Learnings (most recent 3)
- Current iteration sessions with status, role, binary, verdict

### dev-loop attach

Attach to a running tmux session (interactive selector).

```bash
dev-loop attach
```

Lists running tmux sessions and lets you attach to one.

### dev-loop cancel

Cancel the active run, kill tmux sessions, and archive.

```bash
dev-loop cancel
```

**Does:** Cancels the current run, kills associated tmux sessions, archives run to history. If no active run, cleans up the latest historical run's tmux sessions.

### dev-loop history

View run history.

```bash
dev-loop history              # List past runs (default)
dev-loop history list         # List past runs
dev-loop history show <runId> # Show details of a specific run
dev-loop history clear        # Clear all history
```

### dev-loop logs

View agent logs.

```bash
dev-loop logs                 # Interactive log selector (default)
dev-loop logs list            # List all logs
dev-loop logs view <logName>  # View a specific log (e.g., impl-1, rev-1-0)
dev-loop logs clear [runId]   # Clear logs (optionally for a specific run)
```

### dev-loop remove

Remove dev-loop state (preserves history).

```bash
dev-loop remove
```

### dev-loop poll-pr

Poll a PR for CI and review status. Used by kagent-autopilot for automated PR cycles.

```bash
dev-loop poll-pr
```

**Exit codes:**

| Code | Meaning                        |
| ---- | ------------------------------ |
| 0    | Pass — PR is ready             |
| 1    | CI failure                     |
| 2    | Changes requested (reviews)    |
| 4    | Conflict / behind base branch  |
| 5    | Blocked (checks pending, etc.) |
| 6    | Merged / closed                |

### dev-loop metrics

Query run metrics.

```bash
dev-loop metrics              # Show all metrics for latest run
dev-loop metrics <query>      # Query specific metrics
```

Returns statistics about the current or latest run (iteration counts, verdict distributions, timing, etc.).

## State Files

### config.json

Stored at `.kagent/config.json`. Created by `dev-loop init`.

```json
{
  "implementers": ["claude-auto-zai", "claude-auto-mm"],
  "implementerWeights": [2, 1],
  "reviewPhases": [
    ["claude-auto-zai", "claude-auto-mm", "claude-auto-seed"],
    ["claude-auto-zai", "claude-auto-anthropic"],
    ["claude-auto-codex", "claude-auto-kimi"]
  ],
  "noVerdictAsFailure": {
    "claude-auto-zai": true,
    "claude-auto-mm": true,
    "claude-auto-seed": false,
    "claude-auto-anthropic": true,
    "claude-auto-codex": true,
    "claude-auto-kimi": false
  },
  "conflictChecker": "claude-auto-zai",
  "conflictCheckThreshold": 3,
  "firstLoopFullReview": true,
  "previousReviewPropagation": 0.75,
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15
}
```

| Field                       | Type       | Description                                                     |
| --------------------------- | ---------- | --------------------------------------------------------------- |
| `implementers`              | string[]   | Implementer binary names                                        |
| `implementerWeights`        | number[]   | Weights corresponding to implementers (same length)             |
| `reviewPhases`              | string[][] | Array of phases, each phase is an array of reviewer names       |
| `noVerdictAsFailure`        | object     | Map of reviewer name → bool (true = no verdict = reject)        |
| `conflictChecker`           | string?    | Binary used for conflict detection                              |
| `conflictCheckThreshold`    | number     | Consecutive failures before conflict check fires                |
| `firstLoopFullReview`       | boolean    | Always run all review phases on first iteration (default: true) |
| `previousReviewPropagation` | number     | Probability (0-1) each reviewer sees previous loop reviews      |
| `maxIterations`             | number     | Maximum iterations before giving up                             |
| `implementerTimeout`        | number     | Implementer timeout in minutes                                  |
| `reviewerTimeout`           | number     | Reviewer timeout in minutes                                     |

### current/run.json

Stored at `.kagent/current/run.json`. Created when `dev-loop run` starts.

```json
{
  "id": "a1b2c3d4",
  "spec": ".kagent/spec.md",
  "status": "running",
  "iteration": 2,
  "phase": "reviewing",
  "startedAt": "2025-02-15T10:30:00.000Z",
  "learnings": ["Fixed import order", "Added missing types"],
  "consecutiveFailures": 1
}
```

| Field                 | Type     | Description                           |
| --------------------- | -------- | ------------------------------------- |
| `id`                  | string   | Short UUID run identifier             |
| `spec`                | string   | Path to spec file                     |
| `status`              | string   | Overall run status                    |
| `iteration`           | number   | Current iteration (0 = not started)   |
| `phase`               | string   | Current phase within iteration        |
| `startedAt`           | string   | ISO datetime when run started         |
| `learnings`           | string[] | Accumulated learnings from iterations |
| `consecutiveFailures` | number   | Consecutive failure count             |

**Status values:**

| Status           | Exit Code | Meaning                                   |
| ---------------- | --------- | ----------------------------------------- |
| `running`        | —         | Loop is executing                         |
| `completed`      | 0         | All reviewers approved                    |
| `max_iterations` | 0         | Consensus not reached within limit        |
| `cancelled`      | —         | User cancelled the run                    |
| `error`          | 1         | Run failed due to error                   |
| `conflict`       | 2         | Conflict detected (checkper found issues) |
| `agent_failure`  | 3         | Agent crashed or timed out                |

**Phase values:**

- `implementing` - Implementer agent is working
- `reviewing` - Reviewer agents are working (in parallel within current phase)
- `conflict_checking` - Conflict checker is analyzing the spec
- `done` - Iteration/run completed

### checkpoint-result.json

Created at `.kagent/current/checkpoint-result.json` when the conflict checker runs.

```json
{
  "isConflict": true,
  "reasoning": "Spec requires both nullable and non-nullable for the same field",
  "suggestedFix": "Clarify the nullability requirement for the user field"
}
```

| Field          | Type    | Description                                    |
| -------------- | ------- | ---------------------------------------------- |
| `isConflict`   | boolean | Whether a conflict was detected                |
| `reasoning`    | string  | Conflict checker's analysis                    |
| `suggestedFix` | string? | Optional suggestion for resolving the conflict |

### Session Files

Individual session files stored at `.kagent/current/sessions/{sessionId}.json`.

```json
{
  "id": "abc123-def456-...",
  "iteration": 1,
  "role": "reviewer",
  "reviewerIndex": 0,
  "reviewPhase": 0,
  "binary": "claude-auto-zai",
  "tmuxSession": "devloop-a1b2c3d4-e5f6g7h8-1-rev-0",
  "status": "completed",
  "verdict": "approved",
  "startedAt": "2025-02-15T10:35:00.000Z",
  "completedAt": "2025-02-15T10:42:00.000Z"
}
```

| Field           | Type    | Description                                      |
| --------------- | ------- | ------------------------------------------------ |
| `id`            | string  | Full UUID session identifier                     |
| `iteration`     | number  | Iteration number (1-based)                       |
| `role`          | string  | `implementer`, `reviewer`, or `conflict_checker` |
| `reviewerIndex` | number? | Reviewer index (only for reviewer role)          |
| `reviewPhase`   | number? | Which review phase (0-based)                     |
| `binary`        | string? | Which binary was used                            |
| `tmuxSession`   | string  | Tmux session name                                |
| `status`        | string  | `running`, `completed`, or `error`               |
| `verdict`       | string? | `approved` or `rejected` (only for reviewers)    |
| `startedAt`     | string  | ISO datetime                                     |
| `completedAt`   | string? | ISO datetime (set when session finishes)         |

### Verdict Files

Each reviewer writes a JSON verdict to `.kagent/current/verdicts/{iteration}-{reviewerIndex}.json`:

```json
{
  "verdict": "approved",
  "reasoning": "All acceptance criteria met, tests pass, build succeeds",
  "completionEstimate": 100
}
```

| Field                | Type    | Description                         |
| -------------------- | ------- | ----------------------------------- |
| `verdict`            | string  | `approved` or `rejected`            |
| `reasoning`          | string  | Detailed reasoning for the verdict  |
| `completionEstimate` | number? | 0-100 percentage of spec completion |

**noVerdictAsFailure behavior:**

- `:1` (default): no verdict file, timeout, or non-zero exit code → treated as `rejected`
- `:0`: no verdict file, timeout, or non-zero exit code → treated as `approved`
- Verdict files, if present, always take precedence regardless of exit code

### History Files

Archived runs stored at `.kagent/history/{runId}.json`.

```json
{
  "id": "a1b2c3d4",
  "spec": ".kagent/spec.md",
  "config": {
    "implementers": ["claude-auto-zai"],
    "reviewPhases": [["claude-auto-zai", "claude-auto-mm"]],
    "...": "..."
  },
  "status": "completed",
  "iterations": 3,
  "startedAt": "2025-02-15T10:30:00.000Z",
  "completedAt": "2025-02-15T11:15:00.000Z",
  "summary": [
    {
      "iteration": 1,
      "reviewerVerdicts": [{ "index": 0, "verdict": "rejected", "binary": "claude-auto-zai", "phase": 0 }],
      "learnings": [],
      "sessions": [{ "role": "implementer" }, { "role": "reviewer", "reviewerIndex": 0 }]
    }
  ]
}
```

## Conflict Detection + Checkpointer

When `consecutiveFailures` reaches `conflictCheckThreshold`, the conflict checker binary runs:

1. **Spec backup:** Current spec is backed up to `.kagent/spec-backup.md`
2. **Conflict checker runs:** The `--conflict-checker` binary receives the spec and all review feedback
3. **checkpoint-result.json:** Written with `isConflict`, `reasoning`, and optionally `suggestedFix`
4. **Outcomes:**
   - `isConflict: true` → run exits with code 2 (conflict), spec needs human revision
   - `isConflict: false` → loop continues (counter resets)

## Directory Structure

```
.kagent/
├── spec.md                  # The specification (edit before running)
├── spec-backup.md           # Backup before conflict check (if triggered)
├── config.json              # Configuration (implementers, review phases, limits)
├── current/                 # Active run state (removed after archiving)
│   ├── run.json             # Current run state
│   ├── checkpoint-result.json  # Conflict checker output
│   ├── sessions/            # Individual session records
│   │   └── {sessionId}.json
│   ├── verdicts/            # Verdict files per iteration
│   │   └── {iteration}-{reviewerIndex}.json
│   ├── evidence/            # Build/test evidence from implementer
│   │   └── evidence.md
│   ├── learnings.md         # Implementer learnings (current run)
│   └── reviews/             # Review files (current iteration, cleared each loop)
│       └── reviewer-{index}.md
├── history/                 # Archived runs
│   └── {runId}.json
├── logs/                    # Agent output logs
│   └── {runId}/
│       ├── impl-{iteration}.log
│       └── rev-{iteration}-{reviewerIndex}.log
└── reviews/                 # Persistent review copies
    └── {runId}/
        ├── review-{iteration}-{index}-{binary}.md
        └── verdict-{iteration}-{index}-{binary}.json
```

## Tmux Session Naming

Session names follow the pattern:

```
devloop-{dirHash}-{runId}-{iteration}-{role}[-{reviewerIndex}]
```

Examples:

- `devloop-a1b2c3d4-e5f6g7h8-1-impl` (implementer, iteration 1)
- `devloop-a1b2c3d4-e5f6g7h8-1-rev-0` (reviewer 0, iteration 1, phase 0)

## Agent Commands

Agents are invoked via tmux with stream-json output:

```bash
cat "<promptFile>" | <binary> --dangerously-skip-permissions --verbose --print --session-id "<sessionId>" --output-format stream-json 2>&1 | tee "<logFile>" | dev-loop stream
```

### Spec Isolation

**Reviewer spec isolation:** Reviewers only receive `.kagent/spec.md` as their spec — they do NOT see the original task description, prior learnings, or other context from the orchestrator. This ensures reviewers evaluate against the spec alone.

### Reviewer Change Detection

Reviewers check **all** changes — not just `git diff` of staged changes:

- Staged changes (`git diff --cached`)
- Unstaged changes (`git diff`)
- Untracked files (`git ls-files --others --exclude-standard`)
