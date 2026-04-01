# Clear Loop — Sub-Agent (Haiku)

**Sub-agent. Stateless.** Returns result directly to orchestrator.

Used by: Phase 2 (between plans, before rewrite), Phase 3 (before fix cycle)

## Agent Context

- Working directory: {WORKDIR}
- kloop Run ID (if known): {kloopRunId}

## Task

Clean up kloop state and stale files to prepare for a fresh run.

## Steps

### 1. Check for Active Runs

```bash
kloop ps 2>&1 || true
```

### 2. Cancel Active Run

If kloop reports an active run (or a runId was provided):

```bash
kloop cancel {kloopRunId}
```

### 3. Remove Stale Files

```bash
rm -f .kagent/spec.md .kagent/conflict.md rb-review.md
```

### 4. Report

```
RESULT: cleared
KLOOP_WAS_ACTIVE: <true|false>
FILES_CLEANED: <list of files removed>
```

## Important

- **NEVER merge any PR** — no `gh pr merge`, no merging in any way
- Do NOT update any state files (`task-state.json`, `impl-state.json`, `polish-state.json`) — all state files live in `.kagent/`
- Do NOT commit anything
- Do NOT modify code files
- Only clean up kloop state and stale files in `.kagent/`
