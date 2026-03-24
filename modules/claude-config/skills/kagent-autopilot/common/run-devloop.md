# Run Dev-Loop — Team Agent (Sonnet)

Used by: Phase 2 (`running` step), Phase 3 (`run_fix` step)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}

## Agent Report Format

```
EXIT_CODE: <0|1|2|3>
RUN_ID: <latest run ID from .kagent/history/>
STATUS: <completed|max_iterations|error|conflict|agent_failure>
```

**Do NOT update any state files.** Report back to orchestrator only.

## Steps

### 1. Execute Dev-Loop

Run dev-loop as a background bash task and wait for completion:

```bash
dev-loop run 2>&1 | tee .kagent/run.log
```

Use `run_in_background: true` with Bash tool, then wait with TaskOutput (block=true). This blocks until the loop finishes.

**Autopilot defaults:** The setup-run agent initializes dev-loop with:

- `--first-loop-full-review` (all review phases run on first iteration)
- `--previous-review-propagation 0.75` (reviewers see prior loop reviews 75% of the time)
- `--conflict-checker <binary>` (automatic conflict detection after consecutive failures)

### 2. Find Run ID

Check current run info first:

```bash
dev-loop status
```

Or read the run ID from the current run file:

```bash
cat .kagent/current/run.json | jq -r '.id'
```

Fallback — find latest from history:

```bash
ls -t .kagent/history/ | head -1
```

### 3. Determine Status

Read the history file to determine the run status.

**Note:** These are `dev-loop run` exit codes. `dev-loop poll-pr` (used in Phase 3 polling) has different exit codes — see `polish/steps/poll.md`.

| Exit Code | Status in History | Meaning                                      |
| --------- | ----------------- | -------------------------------------------- |
| 0         | `completed`       | All reviewers approved                       |
| 0         | `max_iterations`  | Consensus not reached within limit           |
| 1         | `error`           | Runtime error                                |
| 2         | `conflict`        | Spec contains contradictions (checker found) |
| 3         | `agent_failure`   | Agent crashed or timed out                   |

### 4. Report

Report EXIT_CODE, RUN_ID, and STATUS. Include relevant error details if exit code is non-zero.

For conflict (exit 2), also include the conflict checker's reasoning from `.kagent/current/checkpoint-result.json` if available.

## Important

- **NEVER merge any PR** — no `gh pr merge`, no merging in any way
- Do NOT update any state files (`task-state.json`, `impl-state.json`, `polish-state.json`) — all state files live in `.kagent/`
- Do NOT commit anything
- Do NOT handle exit codes (orchestrator decides next step)
- Just run dev-loop and report the result
