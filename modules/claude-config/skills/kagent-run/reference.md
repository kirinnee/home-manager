# KAgent Run Reference

## CLI Commands

### kloop init

Initialize a new kloop run. Requires spec and config files to be written first.

```bash
kloop init --spec ./spec.md --config ./config.yaml
```

| Option               | Description                           |
| -------------------- | ------------------------------------- |
| `--spec <path>`      | Spec file to use                      |
| `--config <path>`    | Config YAML file                      |
| `--workspace <path>` | Workspace directory (defaults to CWD) |

**Config YAML format:**

```yaml
implementers:
  claude-auto-zai: 2 # name: weight
  claude-auto-mm: 1

reviewPhases:
  - - claude-auto-zai # phase 1: reviewers in parallel
    - claude-auto-mm
    - claude-auto-seed
  - - claude-auto-zai # phase 2: reviewers in parallel
    - claude-auto-anthropic
    - claude-auto-gemini
  - - claude-auto-codex # phase 3: reviewers in parallel
    - claude-auto-kimi

maxIterations: 10
implementerTimeout: 30 # minutes
reviewerTimeout: 15 # minutes
conflictCheckThreshold: 3
firstLoopFullReview: true
previousReviewPropagation: 0.75
reviewerFailureLimit: 2
```

| Field                       | Type    | Description                                                     |
| --------------------------- | ------- | --------------------------------------------------------------- |
| `implementers`              | map     | Implementer binary name → weight                                |
| `reviewPhases`              | list    | List of phases, each a list of reviewer names                   |
| `maxIterations`             | number  | Maximum iterations before giving up                             |
| `implementerTimeout`        | number  | Implementer timeout in minutes                                  |
| `reviewerTimeout`           | number  | Reviewer timeout in minutes                                     |
| `conflictCheckThreshold`    | number  | Consecutive failures before conflict check fires                |
| `firstLoopFullReview`       | boolean | Always run all review phases on first iteration (default: true) |
| `previousReviewPropagation` | number  | Probability (0-1) each reviewer sees previous loop reviews      |
| `reviewerFailureLimit`      | number  | Allowed reviewer failures before abort                          |

**Review phase format:**

- Reviewers within a phase run in parallel
- Phases run in sequence — short-circuit on rejection (skip remaining phases)
- When `firstLoopFullReview: true`, the first iteration runs **all reviewers across all phases in parallel** (no short-circuit); subsequent iterations use normal phased short-circuit

**Output:** Prints `Run ID: <id>` which must be captured for subsequent commands.

**Creates:**

- Run directory in `~/.kloop/{runId}/` with frozen copies of spec and config
- Event log at `~/.kloop/{runId}/events.jsonl`

After init, delete the local spec.md and config.yaml — kloop has its own copies.

### kloop run

Execute the kloop run. Requires `tmux` to be installed.

```bash
kloop run -d {runId}
```

| Option         | Description                     |
| -------------- | ------------------------------- |
| `-d, --detach` | Run in background (daemon mode) |

**Exit codes:**

| Code | Status           | Meaning                                    |
| ---- | ---------------- | ------------------------------------------ |
| 0    | `completed`      | All reviewers approved                     |
| 0    | `max_iterations` | Consensus not reached within limit         |
| 1    | `error`          | Runtime error                              |
| 2    | `conflict`       | Conflict checker found spec contradictions |
| 3    | `agent_failure`  | Agent crashed or timed out                 |

### kloop status

Show current run snapshot (derived from events.jsonl).

```bash
kloop status {runId}
kloop status {runId} --json    # machine-readable output
```

### kloop describe

Full history: all loops, verdicts, exit code, timings.

```bash
kloop describe {runId}
kloop describe {runId} --json
```

### kloop ps

List active (running) runs.

```bash
kloop ps
kloop ps -a              # all runs (running + completed)
kloop ps --json          # machine-readable
```

### kloop attach

Attach to a running tmux session.

```bash
kloop attach {runId}
```

Session names follow the pattern: `kloop-{runId}`

### kloop cancel

Cancel an active run (logged as event).

```bash
kloop cancel {runId}
```

### kloop logs

View run log.

```bash
kloop logs {runId}
kloop logs {runId} -f              # follow mode
kloop logs {runId} --since 5m      # entries since 5 minutes ago
```

### kloop view

View agent logs (implementer, reviewer, etc.).

```bash
kloop view {runId} {loop} {role} [ordinal]
kloop view {runId} -f              # follow mode
```

### kloop review

Show reviewer verdicts and reasoning for each iteration.

```bash
kloop review {runId}
```

### kloop rm

Remove run(s) — supports multiple ids and prefix matching.

```bash
kloop rm {runId}
kloop rm {runId} --force           # force remove even if active
```

### kloop metrics

Query run metrics.

```bash
kloop metrics --run {runId}
kloop metrics --run {runId} --json
```

### kloop summary

Generate/show LLM-evaluated run summary.

```bash
kloop summary {runId}
kloop summary {runId} --force      # regenerate
```

## Run Storage

kloop stores all run data in `~/.kloop/{runId}/`:

```
~/.kloop/
└── {runId}/
    ├── events.jsonl          # append-only event log
    ├── spec.md               # frozen spec for this run
    ├── config.yaml           # frozen config for this run
    ├── kloop.log             # run log
    ├── reviews/              # review files per iteration
    ├── verdicts/             # verdict JSON files
    ├── evidence/             # build/test evidence
    └── learnings.md          # accumulated learnings
```

## Tmux Session Naming

Session names follow the pattern:

```
kloop-{runId}
```

## Agent Commands

Agents are invoked via tmux with stream-json output:

```bash
cat "<promptFile>" | <binary> --dangerously-skip-permissions --verbose --print --session-id "<sessionId>" --output-format stream-json 2>&1 | tee "<logFile>" | kloop stream
```

### Spec Isolation

**Reviewer spec isolation:** Reviewers only receive the spec — they do NOT see the original task description, prior learnings, or other context from the orchestrator. This ensures reviewers evaluate against the spec alone.

### Reviewer Change Detection

Reviewers check **all** changes — not just `git diff` of staged changes:

- Staged changes (`git diff --cached`)
- Unstaged changes (`git diff`)
- Untracked files (`git ls-files --others --exclude-standard`)

## Conflict Detection

When `consecutiveFailures` reaches `conflictCheckThreshold`, the conflict checker runs:

1. **Conflict checker runs:** Receives the spec and all review feedback
2. **Outcomes:**
   - `isConflict: true` → run exits with code 2 (conflict), spec needs human revision
   - `isConflict: false` → loop continues (counter resets)
