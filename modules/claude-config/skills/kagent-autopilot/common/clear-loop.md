# Clear Loop — Sub-Agent (Haiku)

**Sub-agent. Stateless.** Returns result directly to orchestrator.

Used by: Phase 2 (between plans, before rewrite), Phase 3 (before fix cycle)

## Agent Context

- Working directory: {WORKDIR}

## Task

Clean up dev-loop state and stale files to prepare for a fresh run.

## Steps

### 1. Check Dev-Loop Status

```bash
dev-loop status 2>&1 || true
```

### 2. Cancel Active Run

If dev-loop reports an active run:

```bash
dev-loop cancel
```

This archives the current run to `.kagent/history/`.

### 3. Remove Stale Files

```bash
rm -f .kagent/spec.md .kagent/conflict.md rb-review.md
```

### 4. Report

```
RESULT: cleared
DEV_LOOP_WAS_ACTIVE: <true|false>
FILES_CLEANED: <list of files removed>
```

## Important

- **NEVER merge any PR** — no `gh pr merge`, no merging in any way
- Do NOT update any state files (`task-state.json`, `impl-state.json`, `polish-state.json`) — all state files live in `.kagent/`
- Do NOT commit anything
- Do NOT modify code files
- Only clean up dev-loop state and stale files in `.kagent/`
