# Phase 2: Implementation

## State Machine

```
Per plan (loops over subPlans):
  clear-loop(sub) → [setup_run] → [running] → resolve_or_rewrite? → [commit] → next plan
                      team(H)       common(S)    inline/common        team(H)

  on conflict/max_iter:
    → orchestrator prompts user inline
    → [rewrite-spec] → [running] → ...
       team(O)          common(S)
```

All plans done → task-state.currentPhase: "polish"

````

## State File: `impl-state.json`

```json
{
  "step": "clear | setup_run | running | resolve_or_rewrite | commit | next_plan | completed",
  "devLoopInitialized": false,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "conflictContext": null,
  "ticketTransitioned": false
}
````

## Step Dispatch

| Step                 | Agent                    | Model  | Type             | File                                         | Description                                           |
| -------------------- | ------------------------ | ------ | ---------------- | -------------------------------------------- | ----------------------------------------------------- |
| `clear`              | clear-loop               | haiku  | **sub (common)** | `common/clear-loop.md`                       | Phase 2 (between plans), Phase 3 (before fix cycle)   |
| `setup_run`          | setup-run-agent          | haiku  | team             | `implementation/steps/setup-run.md`          | Copy plan → `.kagent/spec.md`, init dev-loop          |
|                      |
| `running`            | runner-agent             | sonnet | team (common)    | `common/run-devloop.md`                      | Execute dev-loop, report exit code                    |
| `resolve_or_rewrite` | resolve-or-rewrite-agent | opus   | team             | `implementation/steps/resolve-or-rewrite.md` | Read step content, prompt user, dispatch rewrite-spec |
| `rewrite_spec`       | rewrite-spec-agent       | opus   | team             | `implementation/steps/rewrite-spec.md`       | Rewrite spec with user feedback                       |
| `commit`             | commit-agent             | haiku  | team             | `implementation/steps/commit.md`             | Commit per conventions, include ticket ID             |

## Step Dispatch Logic

On entry to Implementation phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic. This saves context on the main orchestrator.

| Condition                    | Action                                                                  |
| ---------------------------- | ----------------------------------------------------------------------- |
| No `impl-state.json`         | Create it with `step: "clear"`                                          |
| `step: "clear"`              | Spawn clear-loop sub-agent (haiku)                                      |
| `step: "setup_run"`          | Spawn setup-run-agent (haiku)                                           |
| `step: "running"`            | Spawn runner-agent (sonnet) via `common/run-devloop.md`                 |
| `step: "resolve_or_rewrite"` | Spawn resolve-or-rewrite-agent (opus)                                   |
| `step: "commit"`             | Spawn commit-agent (haiku)                                              |
| `step: "next_plan"`          | Increment `currentSubPlanIndex`, reset to `step: "clear"` for next plan |
| `step: "completed"`          | All plans done — advance `task-state.currentPhase` to `"polish"`        |

## Per-Plan Loop

For each sub-plan in `task-state.subPlans`:

1. `clear` — Clean up from previous run
2. `setup_run` — Copy current plan to `.kagent/spec.md`, init dev-loop
3. `running` — Execute dev-loop
4. Check exit code:
   - **Exit 0 (completed):** → `commit`
   - **Exit 0 (max_iterations) or Exit 2 (conflict):** → `resolve_or_rewrite` → `rewrite_spec` → back to `running`
   - **Exit 1 (error):** → `failed`
5. `commit` — Commit the sub-plan's changes
6. `next_plan` — Move to next sub-plan or `completed`

## Ticket Transition

On first `setup_run` per spec version (when `ticketTransitioned: false`):

- Execute `ticketTransitions.start` via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`
- Set `ticketTransitioned: true` in `impl-state.json`

## State Transitions

All state writes go through the **implementation state-agent** (sub-agent, haiku). Read `implementation/state-agent.md` for the state management protocol.

## Spawning Pattern

on entry to Implementation phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic. this saves context on the main orchestrator.

```
Task(
  subagent_type: "general-purpose",
  model: "<haiku|sonnet|opus>",
  description: "Run {step} for {ticketId}",
  prompt: "Read {step file} and execute. Working dir: {WORKDIR}. State: {relevant fields}. Report: {expected format}."
)
```

## Phase Completion

When all sub-plans are completed:

1. Update `task-state.json`: `currentPhase: "polish"`
2. Create `polish-state.json` with initial state
3. Proceed to Phase 3
