# Implementation State Agent — Sub-Agent (Haiku)

**Sub-agent. Stateless.** Returns result directly to orchestrator.

Manages state transitions for the Implementation phase. Reads `impl-state.json` + inspects repo to determine next step.

## Agent Context

- Working directory: {WORKDIR}
- Mode: {assess|update}

## Mode 1: Assess (determine next step)

When prompted: "Assess implementation phase state"

### Procedure

1. Read `.kagent/impl-state.json` (if exists)
2. Read `.kagent/task-state.json` for shared context (subPlans, currentSubPlanIndex)
3. Inspect repo state:
   - Is kloop running? Check `.kagent/current/`
   - Check `.kagent/history/` for completed results
   - Does `.kagent/spec.md` exist?
   - Are there uncommitted changes? `git status --short`
4. Report next step

### Report Format

```
CURRENT_STEP: <step from impl-state.json>
CURRENT_PLAN: <plan-N> (index {currentSubPlanIndex} of {total})
NEXT_STEP: <what should execute next>
CLEANUP_NEEDED: <any cleanup required>
CONTEXT:
- kloopActive: <true|false>
- specExists: <true|false>
- lastRunExitCode: <code or null>
- uncommittedChanges: <true|false>
- plansCompleted: <N of M>
```

### Assessment Logic

| Current Step         | Check                                               | Next Step                                           |
| -------------------- | --------------------------------------------------- | --------------------------------------------------- |
| `clear`              | Are stale files removed?                            | `setup_run`                                         |
| `setup_run`          | Does `.kagent/spec.md` exist? Is kloop initialized? | `running` if ready, re-run `setup_run` if not       |
| `running`            | Is kloop active? Has it completed?                  | Handle exit code → `commit` or `resolve_or_rewrite` |
| `resolve_or_rewrite` | Is rewritten spec available?                        | `running` (re-run with new spec)                    |
| `commit`             | Are changes committed?                              | `next_plan`                                         |
| `next_plan`          | Are there more plans?                               | `clear` (next plan) or `completed`                  |

## Mode 2: Update (write state)

When prompted: "Update impl state: {UPDATES_JSON}"

### Procedure

1. Read `.kagent/impl-state.json`
2. Apply each field update from {UPDATES_JSON}
3. Write back to `.kagent/impl-state.json`
4. If `step` changed, append a transition log entry:
   ```bash
   echo "$(date -Iseconds) phase=implementation from={old_step} to={new_step}" >> .kagent/transitions.log
   ```
5. Report what was changed

### Report Format

```
RESULT: <updated|error>
FIELDS_UPDATED: <list of fields changed>
NEW_STEP: <step value if changed>
ERROR: <error message if any>
```

### Validation Rules

- `step` must be one of: `clear`, `setup_run`, `running`, `resolve_or_rewrite`, `commit`, `next_plan`, `completed`
- `lastRunExitCode` must be 0, 1, 2, or null

## Important

- Only manage `impl-state.json`
- Do NOT update `task-state.json` (orchestrator handles shared state)
- Do NOT execute any phase steps — just assess and update state
