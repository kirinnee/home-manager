---
name: kagent-autopilot
description: 'End-to-end task completion from ticket to merged PR, or push-to-merge for manual implementations. Use when running /kagent-autopilot, automating ticket workflow, wanting hands-off task completion, or needing autonomous PR cycles.'
argument-hint: '[TICKET_ID | manual]'
---

# KAgent Autopilot — Autonomous Ticket to PR

## Mode Selection

- **Default (autopilot)**: `/kagent-autopilot` or `/kagent-autopilot PE-1234` — Takes a ticket and autonomously implements it through to a merge-ready PR using `dev-loop`. Two approval checkpoints (spec + plans), then fully autonomous except **spec conflict** (exit 2) and **push failure**.
- **Manual mode**: `/kagent-autopilot manual` — You already implemented the code. Autopilot handles the push → CI/review → fix loop, fixing issues directly without dev-loop.

## Orchestrator Model

```
ORCHESTRATOR (you = team lead)
├── INLINE (user-facing only):
│   ├── planning — spec writing (spawns Explore subagents for research)
│   ├── sub_planning — plan writing (spawns Explore subagents for research)
│   └── feedback — captures feedback, creates new spec version
│
├── [CONTEXT CLEAR after both approvals]
│
├── TEAM MEMBERS (spawned via Task tool with team_name):
│   ├── setup-agent (haiku) — mode + branch + .gitignore
│   ├── repo-setup-agent (sonnet) — org detection, ticket detection, repoConfig
│   ├── state-agent (haiku) — resume assessment + all state writes
│   ├── run-spec-agent (haiku) — prepares spec file for dev-loop
│   ├── runner-agent (sonnet) — executes dev-loop
│   ├── prereview-agent (sonnet) — CodeRabbit local review
│   ├── pushing-agent (sonnet) — commit, push, PR, cleanup review.md
│   ├── poller-agent (sonnet) — gathers PR context
│   └── resolver-agents (sonnet/opus) — fix issues (ci, review, coderabbit, thread, rebase)
│
└── State: ALL writes go through state-agent (orchestrator never writes task-state.json directly)
```

**Why this model?**

- **Inline phases** need user interaction (clarification, approval)
- **Team members** are spawned for isolated, well-defined tasks
- **State-agent** is a single entry point for all state management, ensuring consistency
- **Context clear** between approvals and execution prevents context rot

## Glossary

| Term           | Scope                            | Description                                                                    |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| **Iteration**  | Inner (dev-loop, autopilot only) | One implement-then-review pass. Controlled by `maxIterations`.                 |
| **Push cycle** | Outer (both modes)               | One round: commit, push, CI/review check. Controlled by `maxPushCycles`.       |
| **Plan**       | Autopilot only                   | Implementation plan for a portion of the task. Every task has at least 1 plan. |
| **Conflict**   | Dev-loop exit 2 (autopilot only) | The spec contains contradictory or ambiguous requirements.                     |

## State Machine

```
Autopilot mode:
  [generic_setup] → [repo_setup] → [planning] → [SPEC APPROVAL] → [sub_planning] → [PLAN+CONFIG APPROVAL] → [CONTEXT CLEAR]
   team member       team member     inline                          inline
   mode+branch       repo+ticket     WHAT spec                       HOW plans

  → [run_spec] → [running] → [prereview] → [pushing] → [polling] → [completed]
     team member   team member  team member   team member  team member
     prepare spec  dev-loop     coderabbit    push+PR      CI/review
                                    ↑                            ↓
                                    └────────────────────────────┘
                                   (fix cycle: resolvers → push)

Manual mode:
  [generic_setup] → [repo_setup] → [prereview] → [pushing] → [polling] → [completed]
   team member       team member     team member   team member  team member
                                        ↑                            ↓
                                        └────────────────────────────┘
                                       (fix cycle: resolvers → push)

Feedback loop (from completed):
  [completed] → "I have feedback" → [feedback] → new spec v{N+1} → [SPEC RE-APPROVAL]
                                      inline
  → [sub_planning] → [PLAN+CONFIG APPROVAL] → [CONTEXT CLEAR] → (execution loop)
     inline
```

## Phase Dispatch

**On invocation, read `.kagent/task-state.json` and dispatch accordingly:**

| Phase          | Action                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No state file  | Spawn setup-agent (team member, haiku)                                                                                  |
| `repo_setup`   | Spawn repo-setup-agent (team member, sonnet)                                                                            |
| `planning`     | Orchestrator reads `phases/planning.md` (inline)                                                                        |
| `approved`     | Orchestrator reads `phases/sub-planning.md` (inline)                                                                    |
| `sub_planning` | Orchestrator reads `phases/sub-planning.md` (inline)                                                                    |
| `run_spec`     | Spawn state-agent (resume mode) → spawn run-spec team member (haiku)                                                    |
| `running`      | Spawn state-agent (resume mode) → spawn runner team member (sonnet)                                                     |
| `prereview`    | Spawn state-agent (resume mode) → spawn prereview team member (opus)                                                    |
| `pushing`      | Spawn state-agent (resume mode) → spawn pushing team member (sonnet)                                                    |
| `polling`      | Spawn state-agent (resume mode) → spawn poller team member (opus) → resolvers                                           |
| `feedback`     | Orchestrator reads `phases/feedback.md` (inline)                                                                        |
| `completed`    | Report: "Task completed. PR #{prNumber}. Say 'I have feedback' to iterate." Ticket transition: `ticketTransitions.done` |
| `failed`       | Report status and last error. Offer retry from appropriate phase.                                                       |

**Note:** For execution phases (`run_spec` through `polling`), state-agent (resume mode) is always spawned first on re-invocation to assess state before dispatching.

## Key State Fields (`.kagent/task-state.json`)

### Top-level state (dynamic — changes during execution)

| Field                    | Type        | Description                                                |
| ------------------------ | ----------- | ---------------------------------------------------------- |
| `version`                | number      | State schema version                                       |
| `phase`                  | string      | Current phase (see enum below)                             |
| `mode`                   | string      | `"autopilot"` or `"manual"`                                |
| `rawArgument`            | string/null | Raw CLI argument (passed to repo-setup for interpretation) |
| `ticketId`               | string/null | Detected ticket ID (PE-1234, CU-abc123)                    |
| `ticketTitle`            | string/null | From ticket system                                         |
| `ticketBody`             | string/null | From ticket system                                         |
| `ticketStatus`           | string/null | Current status on taskboard                                |
| `branch`                 | string      | Current branch name                                        |
| `prNumber`               | number/null | GitHub PR number                                           |
| `specVersion`            | number/null | Current spec version (1, 2...)                             |
| `specDir`                | string/null | Path to current spec dir (e.g., `spec/PE-1234/v1`)         |
| `pushCycle`              | number      | Current push cycle (0-indexed)                             |
| `maxPushCycles`          | number      | Outer loop limit (default 5)                               |
| `lastRunId`              | string/null | Dev-loop run ID                                            |
| `lastRunExitCode`        | number/null | Dev-loop exit code                                         |
| `lastRunStatus`          | string/null | Dev-loop status                                            |
| `lastError`              | string/null | Last error message                                         |
| `conflictContext`        | string/null | Conflict details                                           |
| `devLoopInitialized`     | boolean     | Whether dev-loop init ran                                  |
| `subPlans`               | array       | Always an array (min 1 entry) — never null                 |
| `currentSubPlanIndex`    | number      | Current plan index (starts 0)                              |
| `implementer`            | string      | Claude binary for implementation                           |
| `reviewers`              | array       | Reviewer binaries                                          |
| `maxIterations`          | number      | Inner loop limit                                           |
| `implementerTimeout`     | number      | Minutes                                                    |
| `reviewerTimeout`        | number      | Minutes                                                    |
| `conflictCheckThreshold` | number      | Consecutive failures before conflict check                 |
| `conflictChecker`        | string      | Conflict checker binary                                    |
| `repoConfig`             | object      | Nested repo config (see below)                             |
| `teamName`               | string/null | Team name for this session                                 |

### `repoConfig` (immutable per session — from SETUP.md or repos/\*.md)

| Field                     | Type        | Description                                                  |
| ------------------------- | ----------- | ------------------------------------------------------------ |
| `org`                     | string      | Organization identifier                                      |
| `baseBranch`              | string      | Base branch for PRs and prereview (main/master)              |
| `ticketSystem`            | string/null | `"jira"` or `"clickup"`                                      |
| `ticketPattern`           | string/null | Regex for ticket ID extraction from branch/arg               |
| `ticketFetchAccess`       | string/null | `"cli"` or `"mcp"` — how to fetch ticket details             |
| `ticketFetchCommand`      | string/null | CLI command template or MCP tool name for fetching           |
| `ticketTransitions`       | object/null | `{ start, done, feedback }` — transition action/status names |
| `ticketTransitionAccess`  | string/null | `"cli"` or `"mcp"` — how to transition                       |
| `ticketTransitionCommand` | string/null | CLI command template or MCP tool name for transitioning      |
| `coderabbit`              | boolean     | Whether CodeRabbit is active                                 |
| `prereviewEnabled`        | boolean     | Whether to run local prereview                               |
| `reReviewComment`         | string/null | Comment to post requesting re-review                         |
| `reviewComment`           | string/null | Initial review request comment                               |

### Phase enum

`repo_setup`, `planning`, `approved`, `sub_planning`, `run_spec`, `running`, `prereview`, `pushing`, `polling`, `feedback`, `completed`, `failed`

Full schema with all fields is in `phases/setup.md` (initial state) and `phases/resume.md` (per-phase checks).

## Spec Directory Structure (Versioned)

```
spec/
└── <task-id>/                  # e.g., "PE-1234" or "CU-abc123"
    ├── v1/                     # Version 1
    │   ├── task-spec.md        # Original spec (WHAT)
    │   ├── plans/              # Implementation plans (HOW)
    │   │   ├── plan-1.md
    │   │   └── plan-2.md
    │   └── feedback.md         # Created when user provides feedback after completion
    ├── v2/                     # Version 2 (created from v1 spec + v1 feedback)
    │   ├── task-spec.md        # Combined spec
    │   ├── plans/
    │   └── ...
    └── ...
```

**Why versioned?** After PR completion, you may have learnings that warrant changes. Versioning preserves the original spec, captures feedback, and creates a new iteration.

## Phase Agents

All execution phases are team members. Each reads its phase file for instructions.

| Phase           | Agent            | Model  | Description                                          |
| --------------- | ---------------- | ------ | ---------------------------------------------------- |
| `generic_setup` | setup-agent      | haiku  | Mode + branch + .gitignore + initial state           |
| `repo_setup`    | repo-setup-agent | sonnet | Org detection, ticket detection, populate repoConfig |
| (resume/state)  | state-agent      | haiku  | Resume assessment + all state writes                 |
| `run_spec`      | run-spec-agent   | haiku  | Copy plan to spec, init dev-loop, ticket transition  |
| `running`       | runner-agent     | sonnet | Execute dev-loop, handle exit codes                  |
| `prereview`     | prereview-agent  | opus   | CodeRabbit review, fix true positives                |
| `pushing`       | pushing-agent    | sonnet | Commit, push, create/update PR, cleanup review.md    |
| `polling`       | poller-agent     | opus   | Gather PR context, report actions needed             |

### Spawning Pattern

```
Task(
  subagent_type: "general-purpose",
  model: "<haiku|sonnet|opus>",
  description: "Run {phase} for {ticketId}",
  prompt: "Read phases/{phase}.md and execute. Working dir: {WORKDIR}. State: {relevant state fields}. Report: {expected report format}."
)
```

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

| Action               | Resolver            | Model  | Description                                          |
| -------------------- | ------------------- | ------ | ---------------------------------------------------- |
| `ci_fix`             | ci-resolver         | sonnet | Fix failing CI checks                                |
| `human_review`       | review-resolver     | opus   | Address human review feedback                        |
| `coderabbit_threads` | coderabbit-resolver | opus   | Handle CodeRabbit AI comments (push back reasonably) |
| `other_threads`      | thread-resolver     | opus   | Handle non-CodeRabbit conversations                  |
| `rebase`             | rebase-resolver     | sonnet | Handle branch behind/conflicts                       |

All resolvers are in `phases/resolvers/`. Each returns: `immediate_actions`, `code_fixes`, `post_push_actions`, `summary`.

**CodeRabbit resolver:** Only spawn if `repoConfig.coderabbit` is `true`.

### Priority Order for Code Fixes

| Priority | Source        | Reason                         |
| -------- | ------------- | ------------------------------ |
| 1        | CI failures   | Must pass before anything else |
| 2        | Human reviews | Blocking merge                 |
| 3        | CodeRabbit    | Nice to have, AI feedback      |

### Feedback Phase (Post-Completion Iteration)

Triggered when `phase: "completed"` and user provides feedback. See `phases/feedback.md` for details.

**Full loop:**

1. Capture user's feedback in chat (iteratively clarify if needed)
2. Write to `spec/<task-id>/v{N}/feedback.md`
3. Create `spec/<task-id>/v{N+1}/task-spec.md` — combine original spec + feedback
4. Present merged spec to user for re-approval via `AskUserQuestion`
5. Update state: `phase: "approved"`, `specVersion: N+1`, `specDir: "spec/<task-id>/v{N+1}"`
6. Full field reset: pushCycle→0, devLoopInitialized→false, subPlans→[], etc.
7. Smart detect prNumber: keep if PR open, null if merged
8. Ticket transition: `ticketTransitions.feedback`
9. Dispatch to sub-planning (new plans for updated spec)
10. After plan approval → context clear → execution

## Resumption After Context Clear

On every re-invocation (after context clear, or manual resume):

1. Orchestrator reads `task-state.json`
2. Spawns **state-agent** (resume mode) with the full state JSON
3. State-agent inspects: git status, PR status (if prNumber set), dev-loop state, branch state, pending changes
4. Reports: current phase assessment, what was last completed, what to do next, any cleanup needed
5. Orchestrator dispatches accordingly

See `phases/resume.md` for per-phase resume checks.

## Orchestrator Responsibilities

The orchestrator (you) handles:

1. **Phase dispatch** — Read state, spawn appropriate agent or run inline
2. **Inline phases** — planning, sub_planning, feedback (user-facing)
3. **Spawning team members** — setup, repo-setup, state, run-spec, runner, prereview, pushing, poller, resolvers
4. **Processing agent reports** — Update state via state-agent based on findings
5. **Resolver orchestration** — Spawn resolvers in parallel, execute three-wave model:
   - **Wave 1**: Execute immediate_actions (close threads, post replies)
   - **Wave 2**: Merge code_fixes into ONE spec, run dev-loop or apply directly
   - **Wave 3**: Execute post_push_actions with commit SHA
6. **User interaction** — AskUserQuestion for spec approval, plan+config approval, conflicts, failures
7. **State management** — All state writes delegated to state-agent (never write task-state.json directly)
8. **Ticket transitions** — At phase boundaries (via state-agent + repoConfig)

## Rules

1. **Auto-detect ticket** — only ask if not found in argument, branch, or worktree
2. **Auto-detect ticket system** — via `repoConfig.ticketSystem` (populated by repo-setup from repo config files)
3. **Require spec approval** — before entering autonomous loop (autopilot only)
4. **Challenge before building** — iteratively clarify specs and plans in chat (not AskUserQuestion), be devil's advocate
5. **Firm spec = firm commitment** — don't proceed until all ambiguities resolved
6. **Fully autonomous after approval** — only stop for spec conflict (exit 2) or push failure
7. **Delegate to dev-loop** — don't duplicate its implement-then-review logic (autopilot only)
8. **Task specs describe WHAT, plans describe HOW** — neither contains exact code
9. **Always use sub-plans** — minimum 1 plan per task (no single-spec branching)
10. **Transition ticket status at phase boundaries** — autopilot only, using `repoConfig.ticketTransitions`
11. **After both approvals, request context clear before execution**
12. **Manual mode: skip ticket transitions entirely** — no planning/sub-planning phases
13. **On re-invocation, spawn state-agent (resume mode)** before dispatching to execution phases
14. **Only planning, sub-planning, and feedback run inline** — all other phases are team members
15. **Feedback loop: re-approve merged spec → new sub-plans → context clear → execute**
16. **ALL state writes go through the state-agent** — orchestrator never writes task-state.json directly
17. **Pushing agent cleans up review.md** before pushing
18. **Committed spec files** — `spec/<task-id>/v{N}/task-spec.md` (versioned) + `plans/*.md` — autopilot only
19. **Check commit conventions** — look for CONTRIBUTING.md, commitlint, recent git log
20. **Include ticket ID** — in commits, branches, PRs (when available)
21. **Never push to main/master**
22. **Never force push**
23. **Always use dev-loop poll-pr** — NEVER use `gh pr watch` in polling phase
24. **Three-wave execution** — immediate actions → code fixes (merged) → post-push actions
25. **One combined spec** — merge all resolver fixes into ONE spec before dev-loop
26. **Priority merging** — CI(1) > Review(2) > CodeRabbit(3), drop lower priority overlaps
27. **Push back on CodeRabbit reasonably** — evaluate their comments critically but professionally; CodeRabbit AI often produces false positives
28. **Never close threads without note** — always post explanation with signature first

## Prerequisites

- Git repository with remote configured
- `gh` CLI installed and authenticated
- For Jira: `acli` installed and authenticated (`acli jira auth`)
- For ClickUp: ClickUp MCP server configured
- `dev-loop` CLI (autopilot mode only)
