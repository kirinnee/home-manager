# Plan State Agent — Sub-Agent (Haiku)

**Sub-agent. Stateless.** Returns result directly to orchestrator.

Manages state transitions for the Plan phase. Reads `plan-state.json` + inspects files to determine next step.

## Agent Context

- Working directory: project root (`.research/` is the state directory, `research/` is the content directory)
- Mode: {assess|update}

## Mode 1: Assess (determine next step)

When prompted: "Assess plan phase state"

### Procedure

1. Read `.research/plan-state.json` (if exists)
2. Read `.research/task-state.json` for topic and domain
3. Check if `research/spec.md` exists
4. Report current state and context

### Report Format

```
CURRENT_STEP: <step from plan-state.json>
CONTEXT:
- topic: <from task-state>
- domain: <from task-state or null>
- specExists: <true|false>
```

### Assessment Logic

| Current Step | Check                            | Findings                       |
| ------------ | -------------------------------- | ------------------------------ |
| `scope`      | Is spec.md present?              | Report whether spec exists yet |
| `write_spec` | Is spec.md present and complete? | Report spec status             |
| `approve`    | Has user been asked?             | Report approval status         |

## Mode 2: Update (write state)

When prompted: "Update plan state: {UPDATES_JSON}"

### Procedure

1. Read `.research/plan-state.json`
2. Apply each field update from {UPDATES_JSON}
3. Write back to `.research/plan-state.json`
4. If `step` changed, append a transition log entry:
   ```bash
   echo "$(date -Iseconds) phase=plan from={old_step} to={new_step}" >> .research/transitions.log
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

- `step` must be one of: `scope`, `write_spec`, `approve`, `completed`

## Important

- Only manage `plan-state.json`
- Do NOT update `task-state.json` (orchestrator handles shared state)
- Do NOT execute any phase steps — just assess and update state
