# Phase {N}: {Phase Name}

## State Machine

```
[step_a] → [step_b] → [step_c] → [step_d]
  team(H)    inline     team(S)    team(H)
```

## State File: `{phase}-state.json`

```json
{
  "step": "step_a | step_b | step_c | step_d | completed",
  "{phaseField1}": false,
  "{phaseField2}": null
}
```

## Step Dispatch

| Step     | Agent          | Model  | Type   | File                        | Description   |
| -------- | -------------- | ------ | ------ | --------------------------- | ------------- |
| `step_a` | {agent-name}   | haiku  | team   | `{phase}/steps/{step-a}.md` | {description} |
| `step_b` | (orchestrator) | —      | inline | `{phase}/steps/{step-b}.md` | {description} |
| `step_c` | {agent-name}   | sonnet | team   | `{phase}/steps/{step-c}.md` | {description} |
| `step_d` | {agent-name}   | haiku  | team   | `{phase}/steps/{step-d}.md` | {description} |

## Step Dispatch Logic

On entry to {Phase Name} phase, read `{phase}-state.json` and dispatch:

| Condition               | Action                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| No `{phase}-state.json` | Create it with `step: "step_a"`, spawn {agent}                     |
| `step: "step_a"`        | Spawn {agent} ({model})                                            |
| `step: "step_b"`        | Orchestrator reads `{phase}/steps/{step-b}.md` (inline)            |
| `step: "step_c"`        | Spawn {agent} ({model})                                            |
| `step: "step_d"`        | Spawn {agent} ({model})                                            |
| `step: "completed"`     | Phase done — advance `task-state.currentPhase` to `"{next_phase}"` |

## State Transitions

All state writes go through the **{phase} state-agent** (sub-agent, haiku). Read `{phase}/state-agent.md` for the state management protocol.

**Bootstrap exceptions:** {List any steps that write task-state.json directly, or "None."}

## Phase Completion

When all steps are completed:

1. Update `task-state.json`: `currentPhase: "{next_phase}"`
2. {Create next phase's initial state file if needed}
3. {Request context clear if needed}
