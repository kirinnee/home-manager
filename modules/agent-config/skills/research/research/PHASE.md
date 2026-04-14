# Phase 2: Research (Repeatable Cycles)

## State Machine

```
[explore] → [review] → [checkpoint]
 team(O)     team(S)     inline
         ↑_______________|  (cycle back if user says "go deeper")
```

## State File: `research-state.json`

```json
{
  "step": "explore | review | checkpoint | completed",
  "currentCycle": 1,
  "steeringNotes": []
}
```

## Step Dispatch

| Step         | Agent           | Model  | Type   | File                                | Description                            |
| ------------ | --------------- | ------ | ------ | ----------------------------------- | -------------------------------------- |
| `explore`    | explore-agent   | opus   | team   | `research/steps/explore.md`         | Creative open-ended research           |
| `review`     | cross-ref-agent | sonnet | team   | `research/steps/cross-reference.md` | Cross-reference findings, gap analysis |
| `checkpoint` | —               | —      | inline | —                                   | User decides: go deeper or move on     |

## Step Dispatch Logic

On entry to Research phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic.

| Condition                | Action                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| No `research-state.json` | Create it with `step: "explore", currentCycle: 1, steeringNotes: []`, spawn explore-agent                                   |
| `step: "explore"`        | Spawn explore-agent (opus). Provide: spec, reputation guide, evidence format, prior findings (if cycle > 1), steering notes |
| `step: "review"`         | Spawn cross-ref-agent (sonnet). Provide: spec, all findings from all cycles                                                 |
| `step: "checkpoint"`     | Present review to user (inline — see below)                                                                                 |
| `step: "completed"`      | Phase done — advance `task-state.currentPhase` to `"verify"`                                                                |

### Agent Prompts

**explore-agent prompt includes:**

- The research spec (`research/spec.md`)
- Path to reputation system guide: `<skill-dir>/common/reputation-system.md`
- Path to evidence format guide: `<skill-dir>/common/evidence-format.md`
- Path to finding template: `<skill-dir>/templates/finding-template.md`
- Current cycle number
- Steering notes from previous checkpoint (if any)
- If cycle > 1: "Prior findings exist in `research/findings/`. Read them to avoid duplication and build on what's known."

**cross-ref-agent prompt includes:**

- The research spec (`research/spec.md`)
- Current cycle number
- Instruction to read ALL files in `research/findings/`

### Inline: checkpoint step

When `step: "checkpoint"`:

1. Read `research/review-cycle-{N}.md` (where N = currentCycle)
2. Present the review summary to the user with `AskUserQuestion`:
   - Option 1: "Good enough — move to verification"
   - Option 2: "Go deeper" (user provides focus area in description)
   - Option 3: "Explore new angle" (user provides direction in description)
3. If "Good enough": update research state to `step: "completed"`
4. If "Go deeper" or "Explore new angle":
   - Append user's notes to `steeringNotes` array
   - Increment `currentCycle`
   - Set `step: "explore"`
   - Dispatch to explore-agent with new steering notes

## State Transitions

All state writes go through the **research state-agent** (sub-agent, haiku). Read `research/state-agent.md` for the state management protocol.

**Bootstrap exceptions:** None.

## Phase Completion

When `step: "completed"`:

1. Update `task-state.json`: `currentPhase: "verify"`
2. Create `verify-state.json`: `{"step": "init_verify"}`
3. Log transition
