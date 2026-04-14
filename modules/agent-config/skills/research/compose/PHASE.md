# Phase 4: Compose

## State Machine

```
[synthesize] → [present]
   team(O)      inline
```

## State File: `compose-state.json`

```json
{
  "step": "synthesize | present | completed"
}
```

## Step Dispatch

| Step         | Agent            | Model | Type   | File                          | Description          |
| ------------ | ---------------- | ----- | ------ | ----------------------------- | -------------------- |
| `synthesize` | synthesize-agent | opus  | team   | `compose/steps/synthesize.md` | Compose final report |
| `present`    | —                | —     | inline | —                             | Show report to user  |

## Step Dispatch Logic

On entry to Compose phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic.

| Condition               | Action                                                          |
| ----------------------- | --------------------------------------------------------------- |
| No `compose-state.json` | Create it with `step: "synthesize"`, spawn synthesize-agent     |
| `step: "synthesize"`    | Spawn synthesize-agent (opus)                                   |
| `step: "present"`       | Present report to user (inline — see below)                     |
| `step: "completed"`     | Phase done — advance `task-state.currentPhase` to `"completed"` |

### Inline: present step

When `step: "present"`:

1. Read `research/report.md`
2. Present to user: "Research complete. Report written to `research/report.md`."
3. Show the executive summary section
4. Update compose state to `step: "completed"`

## State Transitions

All state writes go through the **compose state-agent** (sub-agent, haiku). The compose phase is simple enough that the orchestrator can write `compose-state.json` directly if preferred.

**Bootstrap exceptions:** Orchestrator may write `compose-state.json` directly (simple 1-field state).

## Phase Completion

When `step: "completed"`:

1. Update `task-state.json`: `currentPhase: "completed"`
2. Log transition
3. Report to user: research is done
