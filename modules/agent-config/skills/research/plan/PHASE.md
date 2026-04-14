# Phase 1: Plan

## State Machine

```
[scope] → [write_spec] → [approve]
 team(S)    team(S)        inline
```

## State File: `plan-state.json`

```json
{
  "step": "scope | write_spec | approve | completed"
}
```

## Step Dispatch

| Step         | Agent       | Model  | Type   | File                  | Description                                        |
| ------------ | ----------- | ------ | ------ | --------------------- | -------------------------------------------------- |
| `scope`      | scope-agent | sonnet | team   | `plan/steps/scope.md` | Domain detection, clarifying questions, write spec |
| `write_spec` | scope-agent | sonnet | team   | `plan/steps/scope.md` | Continue spec writing (same agent, same file)      |
| `approve`    | —           | —      | inline | —                     | User approves spec via AskUserQuestion             |

## Step Dispatch Logic

On entry to Plan phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic.

| Condition            | Action                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| No `plan-state.json` | Create it with `step: "scope"`, spawn scope-agent                                                            |
| `step: "scope"`      | Spawn scope-agent (sonnet) — reads `plan/steps/scope.md`                                                     |
| `step: "write_spec"` | Spawn scope-agent (sonnet) — reads `plan/steps/scope.md` (same file handles both)                            |
| `step: "approve"`    | Read `research/spec.md`, present to user via AskUserQuestion with options: "Approve" / "Revise — {feedback}" |
| `step: "completed"`  | Phase done — advance `task-state.currentPhase` to `"research"`                                               |

### Inline: approve step

When `step: "approve"`:

1. Read `research/spec.md`
2. Present the spec to the user with `AskUserQuestion`:
   - Option 1: "Approve — start research"
   - Option 2: "Revise — I have feedback"
3. If approved: update plan state to `step: "completed"`
4. If revise: update plan state to `step: "write_spec"`, pass user feedback to scope-agent on next dispatch

## State Transitions

All state writes go through the **plan state-agent** (sub-agent, haiku). Read `plan/state-agent.md` for the state management protocol.

**Bootstrap exceptions:** None.

## Phase Completion

When `step: "completed"`:

1. Update `task-state.json`: `currentPhase: "research"`
2. Create `research-state.json`: `{"step": "explore", "currentCycle": 1, "steeringNotes": []}`
3. Log transition
