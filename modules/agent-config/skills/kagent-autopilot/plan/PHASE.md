# Phase 1: Plan

## State Machine

```
[setup] → [repo_setup] → [feedback?] → [write_spec] → SPEC APPROVAL → [write_plans] → PLAN APPROVAL
  team(H)    team(S)        team(H)      team(H)                          team(H)
                            (v2+ only)

→ task-state.currentPhase: "implementation"
→ CONTEXT CLEAR
```

## State File: `plan-state.json`

```json
{
  "step": "setup | repo_setup | feedback | write_spec | write_plans | approved",
  "setupComplete": false,
  "repoSetupComplete": false,
  "specWritten": false,
  "plansWritten": false
}
```

## Step Dispatch

| Step          | Agent             | Model  | Type | File                        | Description                                                                     |
| ------------- | ----------------- | ------ | ---- | --------------------------- | ------------------------------------------------------------------------------- |
| `setup`       | setup-agent       | haiku  | team | `plan/steps/setup.md`       | Mode, worktrunk worktree/branch, .gitignore, create task-state.json (bootstrap) |
| `repo_setup`  | repo-setup-agent  | sonnet | team | `plan/steps/repo-setup.md`  | Org detection, ticket fetch, parent walking, populate repoConfig                |
| `feedback`    | feedback-agent    | haiku  | team | `plan/steps/feedback.md`    | v2+: capture feedback, create new spec version, merge specs                     |
| `write_spec`  | write-spec-agent  | haiku  | team | `plan/steps/write-spec.md`  | Read step content, challenge user, research codebase, write spec                |
| `write_plans` | write-plans-agent | haiku  | team | `plan/steps/write-plans.md` | Read step content, write plans, discover binaries, config approval              |

## Step Dispatch Logic

On entry to Plan phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic.

This saves context on the main orchestrator.

| Condition             | Action                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| No `plan-state.json`  | Create it with `step: "setup"`, spawn setup-agent                                               |
| `step: "setup"`       | Spawn setup-agent (haiku)                                                                       |
| `step: "repo_setup"`  | Spawn repo-setup-agent (sonnet)                                                                 |
| `step: "feedback"`    | Spawn feedback-agent (haiku) — v2+ only                                                         |
| `step: "write_spec"`  | Spawn write-spec-agent (haiku)                                                                  |
| `step: "write_plans"` | Spawn write-plans-agent (haiku)                                                                 |
| `step: "approved"`    | Plans approved — advance `task-state.currentPhase` to `"implementation"`, request context clear |

## Feedback Entry (v2+)

When returning from Phase 3 with feedback:

1. `specVersion` bumped in `task-state.json`
2. `plan-state.json` starts at `step: "feedback"`
3. Feedback step captures input inline, creates v{N+1} directory, merges spec
4. → `write_spec` (re-approve merged spec) → `write_plans` → approval

## Spawning Pattern

On entry to Plan phase, **NEVER read step files directly**. Spawn a teammate and tell it which step file to read and execute the logic. This saves context on the main orchestrator.

```
Task(
  subagent_type: "general-purpose",
  model: "haiku",
  description: "Run {step} for {ticketId}",
  prompt: "Read {step file path} and execute. Working dir: {WORKDIR}. State: {relevant state fields}. Report: {expected format}."
    )
)
```

After setup-agent reports `WORKDIR`, use that reported worktree path for every later phase/step. This may differ from the original working directory when setup created a new worktrunk worktree from `main` or `master`.

Note: For steps that need user interaction (feedback, write_spec), use haiku since they user may have questions and handle complex decisions. For logic is they use sonnet or opus for deeper reasoning.
