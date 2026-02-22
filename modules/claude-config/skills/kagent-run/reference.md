# KAgent Run Reference

## CLI Commands

### dev-loop init

Initialize a new dev-loop project.

```bash
dev-loop init [--implementer <binary>] [--reviewers <list>] [--max-iterations <n>] [--implementer-timeout <mins>] [--reviewer-timeout <mins>]
```

| Option                  | Default               | Description                         |
| ----------------------- | --------------------- | ----------------------------------- |
| `--implementer`         | `claude`              | Implementer binary name             |
| `--reviewers`           | `claude-reviewer-zai` | Comma-separated reviewer binaries   |
| `--max-iterations`      | `10`                  | Maximum iterations before giving up |
| `--implementer-timeout` | `30`                  | Implementer timeout in minutes      |
| `--reviewer-timeout`    | `15`                  | Reviewer timeout in minutes         |

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

### dev-loop status

Show current loop status.

```bash
dev-loop status
```

**Output includes:**

- Config (implementer, reviewers, max iterations, timeouts)
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

## State Files

### config.json

Stored at `.kagent/config.json`. Created by `dev-loop init`.

```json
{
  "implementer": "claude",
  "reviewers": ["claude-reviewer-zai"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15,
  "conflictCheckThreshold": 3
}
```

| Field                    | Type     | Description                                                      |
| ------------------------ | -------- | ---------------------------------------------------------------- |
| `implementer`            | string   | Implementer binary name                                          |
| `reviewers`              | string[] | Reviewer binary names                                            |
| `maxIterations`          | number   | Maximum iterations before giving up                              |
| `implementerTimeout`     | number   | Implementer timeout in minutes                                   |
| `reviewerTimeout`        | number   | Reviewer timeout in minutes                                      |
| `conflictCheckThreshold` | number   | Consecutive failures before conflict abort (not yet implemented) |

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
  "consecutiveFailures": 0
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

- `running` - Loop is executing
- `completed` - Run finished (either all approved or max iterations)
- `cancelled` - User cancelled the run
- `failed` - Run failed due to error
- `conflict` - Conflict detected (consecutive failures exceeded threshold)

**Phase values:**

- `implementing` - Implementer agent is working
- `reviewing` - Reviewer agents are working (in parallel)
- `done` - Iteration/run completed

### Session Files

Individual session files stored at `.kagent/current/sessions/{sessionId}.json`.

```json
{
  "id": "abc123-def456-...",
  "iteration": 1,
  "role": "reviewer",
  "reviewerIndex": 0,
  "binary": "claude-reviewer-zai",
  "tmuxSession": "devloop-a1b2c3d4-e5f6g7h8-1-rev-0",
  "status": "completed",
  "verdict": "approved",
  "startedAt": "2025-02-15T10:35:00.000Z",
  "completedAt": "2025-02-15T10:42:00.000Z"
}
```

| Field           | Type    | Description                                   |
| --------------- | ------- | --------------------------------------------- |
| `id`            | string  | Full UUID session identifier                  |
| `iteration`     | number  | Iteration number (1-based)                    |
| `role`          | string  | `implementer` or `reviewer`                   |
| `reviewerIndex` | number? | Reviewer index (only for reviewer role)       |
| `binary`        | string? | Which binary was used                         |
| `tmuxSession`   | string  | Tmux session name                             |
| `status`        | string  | `running`, `completed`, or `error`            |
| `verdict`       | string? | `approved` or `rejected` (only for reviewers) |
| `startedAt`     | string  | ISO datetime                                  |
| `completedAt`   | string? | ISO datetime (set when session finishes)      |

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

If verdict file is missing or unparseable, the system falls back to parsing review text, then defaults to `rejected`.

### History Files

Archived runs stored at `.kagent/history/{runId}.json`.

```json
{
  "id": "a1b2c3d4",
  "spec": ".kagent/spec.md",
  "config": { "implementer": "claude", "reviewers": ["claude-reviewer-zai"], "...": "..." },
  "status": "completed",
  "iterations": 3,
  "startedAt": "2025-02-15T10:30:00.000Z",
  "completedAt": "2025-02-15T11:15:00.000Z",
  "summary": [
    {
      "iteration": 1,
      "reviewerVerdicts": [{ "index": 0, "verdict": "rejected", "binary": "claude-reviewer-zai" }],
      "learnings": [],
      "sessions": [{ "role": "implementer" }, { "role": "reviewer", "reviewerIndex": 0 }]
    }
  ]
}
```

## Directory Structure

```
.kagent/
├── spec.md                  # The specification (edit before running)
├── config.json              # Configuration (implementer, reviewers, limits)
├── current/                 # Active run state (removed after archiving)
│   ├── run.json             # Current run state
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
- `devloop-a1b2c3d4-e5f6g7h8-1-rev-0` (reviewer 0, iteration 1)

## Agent Commands

Agents are invoked via tmux with stream-json output:

```bash
cat "<promptFile>" | <binary> --dangerously-skip-permissions --verbose --print --session-id "<sessionId>" --output-format stream-json 2>&1 | tee "<logFile>" | dev-loop stream
```
