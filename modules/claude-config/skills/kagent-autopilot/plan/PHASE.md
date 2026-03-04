# Phase 1: Plan

## State Machine

```
[setup] → [repo_setup] → [feedback?] → [write_spec] → SPEC APPROVAL → [write_plans] → PLAN APPROVAL
  team(H)    team(S)        inline        inline                          inline
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

| Step          | Agent            | Model  | Type   | File                        | Description                                                      |
| ------------- | ---------------- | ------ | ------ | --------------------------- | ---------------------------------------------------------------- |
| `setup`       | setup-agent      | haiku  | team   | `plan/steps/setup.md`       | Mode, branch, .gitignore, create task-state.json (bootstrap)     |
| `repo_setup`  | repo-setup-agent | sonnet | team   | `plan/steps/repo-setup.md`  | Org detection, ticket fetch, parent walking, populate repoConfig |
| `feedback`    | (orchestrator)   | —      | inline | `plan/steps/feedback.md`    | v2+: capture feedback, create new spec version, merge specs      |
| `write_spec`  | (orchestrator)   | —      | inline | `plan/steps/write-spec.md`  | Challenge user, research codebase, write task-spec.md            |
| `write_plans` | (orchestrator)   | —      | inline | `plan/steps/write-plans.md` | Research, write plans, discover binaries, config approval        |

## Step Dispatch Logic

On entry to Plan phase, read `plan-state.json` and dispatch:

| Condition             | Action                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| No `plan-state.json`  | Create it with `step: "setup"`, spawn setup-agent                                               |
| `step: "setup"`       | Spawn setup-agent (haiku)                                                                       |
| `step: "repo_setup"`  | Spawn repo-setup-agent (sonnet)                                                                 |
| `step: "feedback"`    | Orchestrator reads `plan/steps/feedback.md` (inline) — only for v2+                             |
| `step: "write_spec"`  | Orchestrator reads `plan/steps/write-spec.md` (inline)                                          |
| `step: "write_plans"` | Orchestrator reads `plan/steps/write-plans.md` (inline)                                         |
| `step: "approved"`    | Plans approved — advance `task-state.currentPhase` to `"implementation"`, request context clear |

## Feedback Entry (v2+)

When returning from Phase 3 with feedback:

1. `specVersion` bumped in `task-state.json`
2. `plan-state.json` starts at `step: "feedback"`
3. Feedback step captures input inline, creates v{N+1} directory, merges spec
4. → `write_spec` (re-approve merged spec) → `write_plans` → approval

## Spawning Pattern

```
Task(
  subagent_type: "general-purpose",
  model: "<haiku|sonnet>",
  description: "Run {step} for {ticketId}",
  prompt: "Read plan/steps/{step}.md and execute. Working dir: {WORKDIR}. State: {relevant state fields}."
)
```

## State Transitions

All state writes go through the **plan state-agent** (sub-agent, haiku). Read `plan/state-agent.md` for the state management protocol.

**Bootstrap exceptions:** `plan/steps/setup.md` creates `task-state.json` (initial bootstrap). `plan/steps/repo-setup.md` writes `repoConfig` to `task-state.json`. These are the only steps that write to `task-state.json` directly.

## Context Clear

After plan approval:

1. Update `task-state.json`: `currentPhase: "implementation"`
2. Request context clear from user
3. On re-invocation, orchestrator reads `task-state.json` and enters Phase 2
