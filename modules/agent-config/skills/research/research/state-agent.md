# Research State Agent — Sub-Agent (Haiku)

**Sub-agent. Stateless.** Returns result directly to orchestrator.

Manages state transitions for the Research phase. Reads `research-state.json` + inspects findings to determine context.

## Agent Context

- Working directory: project root (`.research/` is the state directory, `research/` is the content directory)
- Mode: {assess|update}

## Mode 1: Assess (determine next step)

When prompted: "Assess research phase state"

### Procedure

1. Read `.research/research-state.json` (if exists)
2. List `research/findings/` to count threads
3. Check for `research/review-cycle-{N}.md` files
4. Report current state and context

### Report Format

```
CURRENT_STEP: <step from research-state.json>
CONTEXT:
- currentCycle: <N>
- threadCount: <number of files in findings/>
- reviewsExist: <list of review-cycle files>
- steeringNotes: <summary of steering notes>
```

### Assessment Logic

| Current Step | Check                              | Findings                 |
| ------------ | ---------------------------------- | ------------------------ |
| `explore`    | Any new threads since last review? | Report thread count      |
| `review`     | Does review-cycle-{N}.md exist?    | Report review status     |
| `checkpoint` | Has user been asked?               | Report checkpoint status |

## Mode 2: Update (write state)

When prompted: "Update research state: {UPDATES_JSON}"

### Procedure

1. Read `.research/research-state.json`
2. Apply each field update from {UPDATES_JSON}
3. Write back to `.research/research-state.json`
4. If `step` changed, append a transition log entry:
   ```bash
   echo "$(date -Iseconds) phase=research cycle={currentCycle} from={old_step} to={new_step}" >> .research/transitions.log
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

- `step` must be one of: `explore`, `review`, `checkpoint`, `completed`
- `currentCycle` must be a positive integer
- `steeringNotes` must be an array of strings

## Important

- Only manage `research-state.json`
- Do NOT update `task-state.json` (orchestrator handles shared state)
- Do NOT execute any phase steps — just assess and update state
