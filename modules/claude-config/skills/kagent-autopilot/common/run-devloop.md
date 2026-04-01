# Run kloop — Team Agent (Sonnet)

Used by: Phase 2 (`running` step), Phase 3 (`run_fix` step)

## Agent Context

- Working directory: {WORKDIR}
- Task ID: {ticketId}
- kloop Run ID: {kloopRunId}

## Agent Report Format

```
EXIT_CODE: <0|1|2|3>
KLOOP_RUN_ID: {kloopRunId}
STATUS: <completed|max_iterations|error|conflict|agent_failure>
```

**Do NOT update any state files.** Report back to orchestrator only.

## Steps

### 1. Execute kloop

Run kloop as a background bash task and wait for completion:

```bash
kloop run {kloopRunId} 2>&1 | tee .kagent/run.log
```

Use `run_in_background: true` with Bash tool, then wait with TaskOutput (block=true). This blocks until the loop finishes.

**Autopilot defaults:** The setup-run agent initializes kloop with:

- `firstLoopFullReview: true` (all review phases run on first iteration)
- `previousReviewPropagation: 0.75` (reviewers see prior loop reviews 75% of the time)
- `conflictCheckThreshold` (automatic conflict detection after consecutive failures)

### 2. Determine Status

Check run status:

```bash
kloop status {kloopRunId} --json
```

Or get full history:

```bash
kloop describe {kloopRunId} --json
```

| Exit Code | Status           | Meaning                                      |
| --------- | ---------------- | -------------------------------------------- |
| 0         | `completed`      | All reviewers approved                       |
| 0         | `max_iterations` | Consensus not reached within limit           |
| 1         | `error`          | Runtime error                                |
| 2         | `conflict`       | Spec contains contradictions (checker found) |
| 3         | `agent_failure`  | Agent crashed or timed out                   |

### 3. Report

Report EXIT_CODE, KLOOP_RUN_ID, and STATUS. Include relevant error details if exit code is non-zero.

For conflict (exit 2), also include the conflict checker's reasoning if available in the kloop describe output.

## Important

- **NEVER merge any PR** — no `gh pr merge`, no merging in any way
- Do NOT update any state files (`task-state.json`, `impl-state.json`, `polish-state.json`) — all state files live in `.kagent/`
- Do NOT commit anything
- Do NOT handle exit codes (orchestrator decides next step)
- Just run kloop and report the result
