# Phase 3: Polish

## State Machine

```
[commit_pending] → [prereview] → [push] → [create_pr] → [poll]
    team(H)          team(O)      team(S)    team(S)       team(O)

Poll result:
  Ready (exit 0) → [feedback_check] → completed or → Phase 1
  Merged (exit 6) → completed
  Issues found:
    → [resolve] → clear-loop(sub) → [write_fix] → [running] → resolve_fix? → [push] → [poll]
       team(O)         common(H)         team(S)        common(S)   team(O)         team(S)
```

## State File: `polish-state.json`

```json
{
  "step": "commit_pending | prereview | push | create_pr | poll | resolve | clear | write_fix | run_fix | resolve_fix | feedback_check | completed",
  "pushCycle": 0,
  "lastPollExitCode": null,
  "resolverOutputs": null,
  "postPushActions": null
}
```

## Step Dispatch

| Step             | Agent                | Model  | Type          | File                             | Description                                                |
| ---------------- | -------------------- | ------ | ------------- | -------------------------------- | ---------------------------------------------------------- |
| `commit_pending` | commit-pending-agent | haiku  | team          | `polish/steps/commit-pending.md` | Stage + commit any uncommitted changes                     |
| `prereview`      | prereview-agent      | opus   | team          | `polish/steps/prereview.md`      | CodeRabbit local review (skip if disabled)                 |
| `push`           | push-agent           | sonnet | team          | `polish/steps/push.md`           | Push to remote, handle failures                            |
| `create_pr`      | create-pr-agent      | sonnet | team          | `polish/steps/create-pr.md`      | Create PR with template, post reviewComment                |
| `poll`           | poller-agent         | opus   | team          | `polish/steps/poll.md`           | kloop poll-pr, gather CI/review/threads                    |
| `resolve`        | resolve-agent        | opus   | team          | `polish/steps/resolve.md`        | Read step content, dispatch resolvers (rebase first)       |
| `clear`          | clear-loop           | haiku  | sub (common)  | `common/clear-loop.md`           | Reset kloop                                                |
| `write_fix`      | write-fix-agent      | sonnet | team          | `polish/steps/write-fix-spec.md` | Merge resolver fixes into `.kagent/spec.md`                |
| `run_fix`        | runner-agent         | sonnet | team (common) | `common/run-devloop.md`          | Execute kloop on fix spec                                  |
| `resolve_fix`    | resolve-fix-agent    | opus   | team          | `common/resolve-or-rewrite.md`   | Read step content, handle conflict/max-iter for fix run    |
| `feedback_check` | feedback-check-agent | haiku  | team          | `polish/steps/feedback-check.md` | Read step content, ask for feedback → Phase 1 or completed |

## Step Dispatch Logic

On entry to Polish phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic. This saves context on the main orchestrator.

| Condition                | Action                                                  |
| ------------------------ | ------------------------------------------------------- |
| No `polish-state.json`   | Create it with `step: "commit_pending"`                 |
| `step: "commit_pending"` | Spawn commit-pending-agent (haiku)                      |
| `step: "prereview"`      | Spawn prereview-agent (opus)                            |
| `step: "push"`           | Spawn push-agent (sonnet)                               |
| `step: "create_pr"`      | Spawn create-pr-agent (sonnet)                          |
| `step: "poll"`           | Spawn poller-agent (opus)                               |
| `step: "resolve"`        | Spawn resolve-agent (opus)                              |
| `step: "clear"`          | Spawn clear-loop sub-agent (haiku)                      |
| `step: "write_fix"`      | Spawn write-fix-agent (sonnet)                          |
| `step: "run_fix"`        | Spawn runner-agent (sonnet) via `common/run-devloop.md` |
| `step: "resolve_fix"`    | Spawn resolve-fix-agent (opus)                          |
| `step: "feedback_check"` | Spawn feedback-check-agent (haiku)                      |
| `step: "completed"`      | Done — ticket transition: `ticketTransitions.done`      |

## Push Cycle Flow

The main polish loop:

1. `commit_pending` → `prereview` → `push` → `create_pr` → `poll`
2. If poll finds issues: `resolve` → `clear` → `write_fix` → `run_fix` → `resolve_fix?` → `push` → `poll`
3. If poll is clean (exit 0): → `feedback_check`
4. If PR merged (exit 6): → `completed`

`pushCycle` is incremented each time we push. Checked against `task-state.maxPushCycles`.

## Wave 3 (Post-Push)

Push agent reads `postPushActions` from `polish-state.json`, substitutes `{commit_sha}`, posts replies. Clears `postPushActions` after execution. If `postPushActions` is null: skip (first push).

## Resolver Dispatch

See `polish/steps/resolve.md` for the full resolver dispatch logic including:

1. Rebase resolver runs FIRST (if needed). If it pushed → back to `poll`.
2. Other resolvers run in PARALLEL
3. Wave 1: Execute immediate actions
4. Store code_fixes + post_push_actions in `polish-state.json`

## Ticket Transitions

- On `completed`: execute `ticketTransitions.done`
- On feedback → Phase 1: execute `ticketTransitions.feedback`

## State Transitions

All state writes go through the **polish state-agent** (sub-agent, haiku). Read `polish/state-agent.md` for the state management protocol.

## Critical Rules

1. **NEVER merge the PR** — no agent in this phase may run `gh pr merge` or merge the PR in any way. The user merges manually. This is absolute and non-negotiable.
2. **All state files live in `.kagent/`** — always use `.kagent/` prefix for all state files. Never write state outside `.kagent/`.

## Spawning Pattern

On entry to Polish phase, **NEVER read step files directly** — spawn a teammate and tell it which step file to read and execute the logic. This saves context on the main orchestrator.

```
Task(
  subagent_type: "general-purpose",
  model: "<haiku|sonnet|opus>",
  description: "Run {step} for {ticketId}",
  prompt: "Read {step file} and execute. Working dir: {WORKDIR}. State: {relevant fields}. Report: {expected format}."
)
```
