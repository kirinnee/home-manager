---
name: kagent-autopilot
description: 'End-to-end task completion from ticket to merged PR, or push-to-merge for manual implementations. Use when running /kagent-autopilot, automating ticket workflow, wanting hands-off task completion, or needing autonomous PR cycles.'
argument-hint: '[TICKET_ID]'
---

# KAgent Autopilot — Autonomous Ticket to PR

Two modes:

- **Autopilot mode**: Takes a ticket and autonomously implements it through to a merge-ready PR using `dev-loop` (kagent-run). After spec approval, fully autonomous except **spec conflict** (exit 2) and **push failure**.
- **Manual mode**: You already implemented the code. Autopilot handles the push → CI/review → fix loop, fixing issues directly without dev-loop.

## Subagent Architecture

The orchestrator (you) handles phases directly and spawns subagents via Task tool when needed:

```
ORCHESTRATOR (you)
├── Direct: setup, sub_planning, run_spec, pushing
├── Spawns: runner agent (long dev-loop execution)
├── Spawns: prereview agent (fresh context for CodeRabbit)
├── Spawns: poller agent (gathers PR context)
└── Spawns: resolvers IN PARALLEL (ci, review, coderabbit, thread, rebase)
```

**Why subagents for these?**

- **Runner**: Long-running (30+ min), needs isolation
- **Prereview**: Needs fresh context for objective CodeRabbit analysis
- **Poller**: Gathers ALL PR context, returns structured report
- **Resolvers**: Each handles a specific issue type with focused context

## Glossary

| Term           | Scope                            | Description                                                              |
| -------------- | -------------------------------- | ------------------------------------------------------------------------ |
| **Iteration**  | Inner (dev-loop, autopilot only) | One implement-then-review pass. Controlled by `maxIterations`.           |
| **Push cycle** | Outer (both modes)               | One round: commit, push, CI/review check. Controlled by `maxPushCycles`. |
| **Sub-plan**   | Autopilot only (RARE)            | Only for large/multi-bounded-context tasks. Most tasks use single plan.  |
| **Conflict**   | Dev-loop exit 2 (autopilot only) | The spec contains contradictory or ambiguous requirements.               |

## State Machine

```
Autopilot mode:
  [setup] ──→ approved ──→ sub_planning? ──→ run_spec ──→ running ──→ prereview ──→ pushing ──→ polling ──→ completed
      │                          │              │            │  (agent)     │  (agent)      │    │  (agent)    │
      │                          │              │            │             │               │    │             │
      │                          │              │            └─────────────┴───────────────┴────┘
      │                          │              │                          (feedback from CI/reviews → spawn resolvers → fix)
      │                          │              │
      └──────────────────────────┴──────────────┴──────────────────────────────────────────────────────────────┐
                                                                                                               │
                                                                                                               ▼
                                                                                                    ┌────────────────┐
                                                                                                    │   completed    │
                                                                                                    └───────┬────────┘
                                                                                                            │ "I have feedback"
                                                                                                            ▼
                                                                                                    ┌────────────────┐
                                                                                                    │    feedback    │──→ approved (with v{N+1})
                                                                                                    └────────────────┘          │
                                                                                                                                └──→ (loops back through entire flow)

Manual mode:
  [setup] ──→ prereview ──→ pushing ──→ polling ──→ completed
                 │  (agent)    │           │  (agent)
                 └─────────────┴───────────┴───────────┘
                 (feedback from CI/reviews → spawn resolvers → fix)
```

Note: `sub_planning?` is optional — only for large/multi-context tasks. Most tasks skip directly to `run_spec`.

## Key State Fields (`.kagent/task-state.json`)

| Field                 | Type        | Description                                                                                                        |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `phase`               | string      | Current state: approved, sub_planning, run_spec, running, prereview, pushing, polling, feedback, completed, failed |
| `mode`                | string      | `"autopilot"` (dev-loop) or `"manual"` (direct fixes)                                                              |
| `ticketId`            | string/null | Ticket ID (PE-1234, CU-abc123). Null in manual mode if no ticket.                                                  |
| `specVersion`         | number      | Current spec version (1, 2, 3...). Increments when user provides feedback after completion.                        |
| `pushCycle`           | number      | Current push cycle (0-indexed, incremented after push)                                                             |
| `maxPushCycles`       | number      | Outer loop limit (default 5)                                                                                       |
| `prNumber`            | number/null | GitHub PR number                                                                                                   |
| `lastRunId`           | string/null | Most recent dev-loop run ID (autopilot only)                                                                       |
| `devLoopInitialized`  | boolean     | Whether `dev-loop init` has been run (autopilot only)                                                              |
| `specDir`             | string/null | Path to spec version directory, e.g., `spec/PE-1234/v1`. Null in manual mode.                                      |
| `subPlans`            | array/null  | Sub-plan files for large tasks. Each item: `{id, file, status}`. Null if single plan.                              |
| `currentSubPlanIndex` | number/null | Current sub-plan index (0-indexed). Null if not using sub-plans                                                    |

Full schema with all fields is in `phases/setup.md`.

## Spec Directory Structure (Versioned)

```
spec/
└── <task-id>/                  # e.g., "PE-1234" or "CU-abc123"
    ├── v1/                     # Version 1
    │   ├── task-spec.md        # Original spec
    │   ├── plans/              # Sub-plans (if needed)
    │   │   └── phase-1.md
    │   └── feedback.md         # Created when user provides feedback after completion
    ├── v2/                     # Version 2 (created from v1 spec + v1 feedback)
    │   ├── task-spec.md        # Combined spec
    │   └── ...
    └── ...
```

**Why versioned?** After PR completion, you may have learnings that warrant changes. Versioning preserves the original spec, captures feedback, and creates a new iteration.

## Phase Dispatch

**On invocation, read `.kagent/task-state.json` and dispatch accordingly:**

| Condition               | Action                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| File does not exist     | Read `phases/setup.md` (handled by orchestrator)                                                     |
| `phase: "approved"`     | Read `phases/sub-planning.md` (handled by orchestrator)                                              |
| `phase: "sub_planning"` | Read `phases/sub-planning.md` (handled by orchestrator)                                              |
| `phase: "run_spec"`     | Read `phases/run-spec.md` (handled by orchestrator)                                                  |
| `phase: "running"`      | **Spawn runner agent** — see [Runner Agent](#runner-agent) below                                     |
| `phase: "prereview"`    | **Spawn prereview agent** — see [Prereview Agent](#prereview-agent) below                            |
| `phase: "pushing"`      | Read `phases/pushing.md` (handled by orchestrator)                                                   |
| `phase: "polling"`      | **Spawn poller agent** → **spawn resolvers in parallel** — see [Polling Phase](#polling-phase) below |
| `phase: "feedback"`     | Read `phases/feedback.md` (handled by orchestrator) — post-completion iteration                      |
| `phase: "completed"`    | Report: "Task completed. PR #{prNumber}. Say 'I have feedback' to iterate further."                  |
| `phase: "failed"`       | Report status and last error. Offer to retry — if yes, dispatch to appropriate phase based on mode.  |

## Resumption After Context Clear

If context runs low during long phases (spec planning, sub-planning, running), ask the user:

```
Context is getting long. Please clear context and run:
/kagent-autopilot

I'll resume from `.kagent/task-state.json`.
```

The state file contains everything needed to resume: current phase, spec version, PR number, sub-plan progress, etc. On re-invocation, read the state and dispatch to the appropriate phase.

## Phase Agents

Agents are spawned for long-running or context-isolated tasks. Each agent reads its phase file for full instructions.

| Phase       | Agent     | Description                                        |
| ----------- | --------- | -------------------------------------------------- |
| `running`   | Runner    | Executes dev-loop, reports exit code/status        |
| `prereview` | Prereview | Runs CodeRabbit CLI, fixes findings (fights back!) |
| `polling`   | Poller    | Gathers PR context → orchestrator spawns resolvers |

### Spawning Pattern

```
Task(
  subagent_type: "general-purpose",
  description: "Run dev-loop for {ticketId}",
  prompt: "Read phases/running.md and execute. Working dir: {WORKDIR}. Report: exit_code, run_id, status."
)
```

**Key point:** Agents read their phase file for full context. The prompt just provides working directory and expected report format.

### Polling Phase (Three-Wave Model)

```
POLLER → gathers context → returns actions_needed
    │
    ▼
WAVE 1: Immediate actions (close threads, post replies) — no code changes
    │
    ▼
WAVE 2: Code fixes (merged into ONE spec) → dev-loop or direct apply → commit & push
    │
    ▼
WAVE 3: Post-push replies with commit SHA
    │
    ▼
LOOP TO POLLING
```

See `phases/polling.md` for full details.

### Resolver Agents

After poller returns, spawn resolvers IN PARALLEL based on `actions_needed`:

| Action               | Resolver              | Description                                 |
| -------------------- | --------------------- | ------------------------------------------- |
| `ci_fix`             | `ci-resolver`         | Fix failing CI checks                       |
| `human_review`       | `review-resolver`     | Address human review feedback               |
| `coderabbit_threads` | `coderabbit-resolver` | Handle CodeRabbit AI comments (fight back!) |
| `other_threads`      | `thread-resolver`     | Handle non-CodeRabbit conversations         |
| `rebase`             | `rebase-resolver`     | Handle branch behind/conflicts              |

All resolvers are in `phases/resolvers/`. Each returns: `immediate_actions`, `code_fixes`, `post_push_actions`.

### Priority Order for Code Fixes

| Priority | Source        | Reason                         |
| -------- | ------------- | ------------------------------ |
| 1        | CI failures   | Must pass before anything else |
| 2        | Human reviews | Blocking merge                 |
| 3        | CodeRabbit    | Nice to have, AI feedback      |

### Feedback Phase (Post-Completion Iteration)

Triggered when `phase: "completed"` and user provides feedback. See `phases/feedback.md` for details.

**Flow:**

1. Capture user's feedback in chat (iteratively clarify if needed)
2. Write to `spec/<task-id>/v{N}/feedback.md`
3. Create `spec/<task-id>/v{N+1}/task-spec.md` — combine original spec + feedback
4. Update state: `phase: "approved"`, `specVersion: N+1`, `specDir: "spec/<task-id>/v{N+1}"`
5. Dispatch to `phases/sub-planning.md` (or `run-spec.md` if skipping sub-plans)

This allows continuous iteration even after PR is "done" — learnings from the implementation can be fed back into the spec.

## Orchestrator Responsibilities

The orchestrator (you) handles:

1. **State management** — Read/write `.kagent/task-state.json` at every phase transition
2. **Direct phase execution** — setup, sub_planning, run_spec, pushing
3. **Spawning subagents** — runner, prereview, poller, resolvers via Task tool
4. **Processing agent reports** — Update state based on agent findings
5. **Resolver orchestration** — Spawn resolvers in parallel, execute three-wave model:
   - **Wave 1**: Execute immediate_actions (close threads, post replies)
   - **Wave 2**: Merge code_fixes into ONE spec, run dev-loop or apply directly
   - **Wave 3**: Execute post_push_actions with commit SHA
6. **User interaction** — AskUserQuestion for spec approval, conflicts, failures

## Spawning Subagents

Use the Task tool to spawn subagents:

```
Task(
  subagent_type: "general-purpose",
  description: "Run dev-loop for PE-1234",
  prompt: "<agent prompt from above with variables substituted>"
)
```

For resolvers, spawn IN PARALLEL with `run_in_background: true`:

```
Task(
  subagent_type: "general-purpose",
  description: "Fix CI failures for PR #42",
  prompt: "<resolver prompt>",
  run_in_background: true
)
```

After all resolvers complete, aggregate results and proceed.

## Rules

1. **Auto-detect ticket** — only ask if not found in argument, branch, or worktree
2. **Auto-detect ticket system** — PE = Jira, CU = ClickUp
3. **Require spec approval** — before entering autonomous loop (autopilot only)
4. **Challenge before building** — iteratively clarify specs and sub-plans in chat (not AskUserQuestion), be devil's advocate
5. **Firm spec = firm commitment** — don't proceed until all ambiguities resolved
6. **Fully autonomous after approval** — only stop for spec conflict (exit 2) or push failure
7. **Delegate to dev-loop** — don't duplicate its implement-then-review logic (autopilot only)
8. **State file required** — read/write `.kagent/task-state.json` at every phase transition
9. **Committed spec files** — `spec/<task-id>/v{N}/task-spec.md` (versioned) + `plans/*.md` (phases) — autopilot only
10. **Check commit conventions** — look for CONTRIBUTING.md, commitlint, recent git log
11. **Include ticket ID** — in commits, branches, PRs (when available)
12. **Never push to main/master**
13. **Never force push**
14. **Always use dev-loop poll-pr** — NEVER use `gh pr watch` in polling phase
15. **Three-wave execution** — immediate actions → code fixes (merged) → post-push actions
16. **One combined spec** — merge all resolver fixes into ONE spec before dev-loop
17. **Priority merging** — CI(1) > Review(2) > CodeRabbit(3), drop lower priority overlaps
18. **Fight CodeRabbit** — evaluate their comments critically, don't blindly accept
19. **Never close threads without note** — always post explanation with signature first

## Prerequisites

- Git repository with remote configured
- `gh` CLI installed and authenticated
- For Jira: `acli` installed and authenticated (`acli jira auth`)
- For ClickUp: ClickUp MCP server configured
- `dev-loop` CLI and `tmux` (autopilot mode only)
