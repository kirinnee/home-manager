# Dev Loop Reference

## CLI Commands

### dev-loop init

Initialize a new dev-loop session.

```bash
dev-loop init [--claude CMD] [--max-loops N] [--reviewers "cmd1,cmd2"] [--dir PATH]
```

| Option        | Default                                    | Description                       |
| ------------- | ------------------------------------------ | --------------------------------- |
| `--claude`    | `claude` or `$DEV_LOOP_CLAUDE`             | Executor binary                   |
| `--max-loops` | `10`                                       | Maximum iterations                |
| `--reviewers` | `claude-reviewer` or `$DEV_LOOP_REVIEWERS` | Comma-separated reviewer binaries |
| `--dir`       | `.kagent`                                  | Directory for dev-loop state      |

**Creates:**

- `.kagent/` directory
- `.kagent/spec.md` (template)
- `.kagent/loop-state.json`

### dev-loop run

Execute the dev-loop. Should be run inside tmux.

```bash
dev-loop run [--dir PATH]
```

**Requires:** `loop-state.json` with status `pending_approval` or `running`

**Creates:**

- `.kagent/reviews/` - Review files from each reviewer
- `.kagent/verdicts/` - Verdict files (APPROVED/REJECTED)
- `.kagent/sessions.json` - Session tracking
- `.kagent/learnings.md` - Learnings from implementer

### dev-loop status

Show current loop status.

```bash
dev-loop status [--dir PATH]
```

**Output includes:**

- Status (pending_approval, running, completed, max_loops_reached)
- Phase (init, implementing, reviewing, checking, done, stopped)
- Current iteration / max
- Reviewer verdicts
- Session IDs

### dev-loop cancel

Remove all dev-loop state.

```bash
dev-loop cancel [--dir PATH]
```

**Removes:** entire `.kagent/` directory

### dev-loop logs

View session history and logs.

```bash
dev-loop logs [--dir PATH]
```

## State Files

### loop-state.json

```json
{
  "loop": 2,
  "max_loops": 10,
  "status": "running",
  "phase": "reviewing",
  "claude": "claude-personal",
  "reviewers": ["claude-reviewer-anthropic", "claude-reviewer-gemini"],
  "learnings": [{ "iteration": 1, "content": "- Fixed import order\n- Added missing types" }]
}
```

| Field       | Type     | Description                           |
| ----------- | -------- | ------------------------------------- |
| `loop`      | number   | Current iteration (0 = not started)   |
| `max_loops` | number   | Maximum iterations before giving up   |
| `status`    | string   | Overall status                        |
| `phase`     | string   | Current phase within iteration        |
| `claude`    | string   | Executor binary name                  |
| `reviewers` | string[] | Reviewer binary names                 |
| `learnings` | object[] | Accumulated learnings from iterations |

**Status values:**

- `pending_approval` - Waiting for user to approve spec
- `running` - Loop is executing
- `completed` - All reviewers approved
- `max_loops_reached` - Hit iteration limit

**Phase values:**

- `init` - Just initialized
- `starting` - About to start first iteration
- `implementing` - Executor is working
- `reviewing` - Reviewers are working (parallel)
- `checking` - Counting verdicts
- `done` - Successfully completed
- `stopped` - Stopped due to max loops

### sessions.json

Tracks all agent sessions for debugging/inspection.

```json
[
  {
    "iteration": 1,
    "role": "implementer",
    "name": "claude-personal",
    "session_id": "abc123-def456",
    "config_dir": "/Users/me/.claude-personal",
    "time": "2025-01-15T10:30:00-08:00"
  },
  {
    "iteration": 1,
    "role": "reviewer",
    "name": "claude-reviewer-anthropic",
    "session_id": "xyz789-uvw012",
    "config_dir": "/Users/me/.claude-reviewer-anthropic",
    "time": "2025-01-15T10:35:00-08:00"
  }
]
```

### Verdict Files

Each reviewer writes to `.kagent/verdicts/<reviewer-name>.txt`:

```
APPROVED
```

or

```
REJECTED
```

Must be exactly one of these values (whitespace trimmed).

## Environment Variables

| Variable                | Default           | Description                                  |
| ----------------------- | ----------------- | -------------------------------------------- |
| `DEV_LOOP_CLAUDE`       | `claude`          | Fallback executor binary                     |
| `DEV_LOOP_REVIEWERS`    | `claude-reviewer` | Fallback reviewer binaries (comma-separated) |
| `DEV_LOOP_TIMEOUT_MINS` | `20`              | Timeout per agent invocation                 |

## Directory Structure

```
.kagent/
├── spec.md              # The specification (do not modify after approval)
├── loop-state.json      # Current state
├── sessions.json        # Session tracking
├── learnings.md         # Implementer learnings (current iteration)
├── reviews/             # Review files
│   ├── claude-reviewer-anthropic.md
│   └── claude-reviewer-gemini.md
└── verdicts/            # Verdict files
    ├── claude-reviewer-anthropic.txt
    └── claude-reviewer-gemini.txt
```

## Config Directory Resolution

Each claude binary has its own config directory:

- `claude` → `~/.claude`
- `claude-personal` → `~/.claude-personal`
- `claude-reviewer-anthropic` → `~/.claude-reviewer-anthropic`

Sessions are stored at:

```
<config-dir>/projects/<project-hash>/<session-id>.jsonl
```

Where `<project-hash>` is the current directory with `/` and `.` replaced by `-`.

## tmux Commands

```bash
# Check if session exists
tmux has-session -t "dev-loop-<UID>" 2>/dev/null && echo "running" || echo "ended"

# Attach to session
tmux attach -t "dev-loop-<UID>"

# Detach from session
# Press: Ctrl+B, then D

# Kill session
tmux kill-session -t "dev-loop-<UID>"

# List all sessions
tmux ls
```

## Polling Commands

```bash
# Check status
dev-loop status --dir .kagent

# Check if tmux session alive
tmux has-session -t "dev-loop-$SESSION_UID" 2>/dev/null && echo "running" || echo "ended"

# Wait 5 minutes
sleep 300
```
