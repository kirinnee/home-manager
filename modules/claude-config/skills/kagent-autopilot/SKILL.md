---
name: kagent-autopilot
description: 'End-to-end task completion from ticket to merged PR. Use when running /kagent-autopilot, automating ticket workflow, wanting hands-off task completion, or needing autonomous PR cycles.'
argument-hint: '[TICKET_ID | --phase impl | --phase polish]'
---

# KAgent Autopilot — Autonomous Ticket to PR

## User Entry Points

```
/kagent-autopilot              → Phase 1 (full flow)
/kagent-autopilot PE-1234      → Phase 1 with ticket
/kagent-autopilot --phase impl → Phase 2 (plans already exist)
/kagent-autopilot --phase polish → Phase 3 (code already written)
```

No separate "manual" mode. Starting from Phase 3 = the old manual flow.

## Agent Taxonomy

| Type           | Spawning                        | State transition            | Purpose                               |
| -------------- | ------------------------------- | --------------------------- | ------------------------------------- |
| **Sub-agent**  | `Task` (no team), direct result | No                          | Mechanical: state management, cleanup |
| **Team agent** | `Task` (with team), messaging   | Yes — corresponds to a step | Complex work for a specific step      |

## Orchestrator Model

```
ORCHESTRATOR (you = team lead)
├── INLINE (user-facing only):
│   ├── write_spec — spec writing (spawns Explore subagents for research)
│   ├── write_plans — plan writing (spawns Explore subagents for research)
│   ├── feedback — v2+ feedback capture, merge specs (needs user chat)
│   ├── resolve — resolver dispatch + Wave 1 execution
│   ├── resolve_fix — handle conflict/max-iter for fix runs
│   └── feedback_check — ask user for feedback after clean poll
│
├── SUB-AGENTS (stateless, direct result):
│   ├── plan-state-agent (haiku) — plan phase state reads/writes
│   ├── impl-state-agent (haiku) — implementation phase state reads/writes
│   ├── polish-state-agent (haiku) — polish phase state reads/writes
│   └── clear-loop (haiku) — dev-loop status/cancel, remove stale files
│
├── TEAM AGENTS (spawned via Task tool):
│   ├── setup-agent (haiku) — mode + branch + .gitignore + bootstrap state
│   ├── repo-setup-agent (sonnet) — org detection, ticket, repoConfig
│   ├── setup-run-agent (haiku) — copy plan → spec, init dev-loop
│   ├── runner-agent (sonnet) — execute dev-loop, report exit code
│   ├── rewrite-spec-agent (opus) — rewrite spec with conflict/feedback
│   ├── commit-agent (haiku) — commit per conventions
│   ├── commit-pending-agent (haiku) — stage + commit uncommitted changes
│   ├── prereview-agent (opus) — CodeRabbit local review
│   ├── push-agent (sonnet) — push, post-push actions, re-review comment
│   ├── create-pr-agent (sonnet) — create/update PR, post reviewComment
│   ├── poller-agent (opus) — dev-loop poll-pr, gather context
│   ├── write-fix-agent (sonnet) — merge resolver fixes → spec
│   └── resolver-agents — fix issues (ci, review, coderabbit, thread, rebase)
│
└── State: Per-phase state-agents handle state writes. Bootstrap exceptions noted per step.
```

## Glossary

| Term           | Scope            | Description                                                            |
| -------------- | ---------------- | ---------------------------------------------------------------------- |
| **Iteration**  | Inner (dev-loop) | One implement-then-review pass. Controlled by `maxIterations`.         |
| **Push cycle** | Outer (Phase 3)  | One round: push, CI/review check. Controlled by `maxPushCycles`.       |
| **Plan**       | Phase 1 output   | Implementation plan for a portion of the task. Every task has ≥1 plan. |
| **Conflict**   | Dev-loop exit 2  | The spec contains contradictory or ambiguous requirements.             |
| **Phase**      | Top-level        | One of: plan, implementation, polish.                                  |
| **Step**       | Per-phase        | A discrete action within a phase.                                      |

## Two-Level State

```
.kagent/
├── task-state.json          # Overall: which phase, ticket, PR, plans, repoConfig
├── plan-state.json          # Phase 1 steps
├── impl-state.json          # Phase 2 steps
├── polish-state.json        # Phase 3 steps
└── transitions.log          # Append-only step transition log (timestamps + phase + from/to)
```

## Top-Level State Machine

```
task-state.json.currentPhase:
  plan → implementation → polish → completed
                                      ↓
                                  feedback → plan (v{N+1})
```

### Phase 1: Plan

```
[setup] → [repo_setup] → [feedback?] → [write_spec] → SPEC APPROVAL → [write_plans] → PLAN APPROVAL
  team(H)    team(S)        inline        inline                          inline
                            (v2+ only)

→ task-state.currentPhase: "implementation"
→ CONTEXT CLEAR
```

### Phase 2: Implementation

```
Per plan (loops over subPlans):
  clear-loop(sub) → [setup_run] → [running] → resolve_or_rewrite? → [commit] → next plan
                      team(H)       common(S)    inline/common        team(H)

All plans done → task-state.currentPhase: "polish"
```

### Phase 3: Polish

```
[commit_pending] → [prereview] → [push] → [create_pr] → [poll]
    team(H)          team(O)      team(S)    team(S)       team(O)

Poll result:
  Ready (exit 0) → [feedback_check] → completed or → Phase 1
  Merged (exit 6) → completed
  Issues found:
    → [resolve] → clear(sub) → [write_fix] → [run_fix] → resolve_fix? → [push] → [poll]
       inline     common(H)     team(S)        common(S)   inline         team(S)
```

## Phase Dispatch

**On invocation, read `.kagent/task-state.json` and dispatch to the current phase:**

| `currentPhase`   | Action                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| No state file    | Start Phase 1: spawn setup-agent                                                                                        |
| `plan`           | Read `plan-state.json`, dispatch per `plan/PHASE.md`                                                                    |
| `implementation` | Read `impl-state.json`, dispatch per `implementation/PHASE.md`                                                          |
| `polish`         | Read `polish-state.json`, dispatch per `polish/PHASE.md`                                                                |
| `completed`      | Report: "Task completed. PR #{prNumber}. Say 'I have feedback' to iterate." Ticket transition: `ticketTransitions.done` |
| `failed`         | Report status and last error. Offer retry from appropriate phase.                                                       |

Each phase has its own PHASE.md with step dispatch logic, state file schema, and step descriptions. Read the appropriate PHASE.md for full details.

**Transition logging:** When advancing `task-state.currentPhase`, the orchestrator appends:

```bash
echo "$(date -Iseconds) phase-transition from={old_phase} to={new_phase}" >> .kagent/transitions.log
```

## Key State Fields (`.kagent/task-state.json`)

### Top-level state

| Field                    | Type        | Description                                               |
| ------------------------ | ----------- | --------------------------------------------------------- |
| `version`                | number      | State schema version                                      |
| `currentPhase`           | string      | `plan`, `implementation`, `polish`, `completed`, `failed` |
| `rawArgument`            | string/null | Raw CLI argument                                          |
| `ticketId`               | string/null | Detected ticket ID (PE-1234, CU-abc123)                   |
| `ticketTitle`            | string/null | From ticket system                                        |
| `ticketBody`             | string/null | From ticket system                                        |
| `ticketStatus`           | string/null | Current status on taskboard                               |
| `branch`                 | string      | Current branch name                                       |
| `prNumber`               | number/null | GitHub PR number                                          |
| `specVersion`            | number      | Current spec version (1, 2...)                            |
| `specDir`                | string/null | Path to current spec dir (e.g., `spec/PE-1234/v1`)        |
| `repoConfig`             | object      | Nested repo config (see below)                            |
| `teamName`               | string/null | Team name for this session                                |
| `subPlans`               | array       | Always an array (min 1 entry) — never null                |
| `currentSubPlanIndex`    | number      | Current plan index (starts 0)                             |
| `implementer`            | string      | Claude binary for implementation                          |
| `reviewers`              | array       | Reviewer binaries                                         |
| `maxIterations`          | number      | Inner loop limit                                          |
| `implementerTimeout`     | number      | Minutes                                                   |
| `reviewerTimeout`        | number      | Minutes                                                   |
| `conflictCheckThreshold` | number      | Consecutive failures before conflict check                |
| `conflictChecker`        | string      | Conflict checker binary                                   |
| `maxPushCycles`          | number      | Outer loop limit (default 5)                              |

### `repoConfig` (immutable per session)

| Field                     | Type        | Description                                                       |
| ------------------------- | ----------- | ----------------------------------------------------------------- |
| `org`                     | string      | Organization identifier                                           |
| `baseBranch`              | string      | Base branch for PRs (main/master)                                 |
| `ticketSystem`            | string/null | `"jira"` or `"clickup"`                                           |
| `ticketPattern`           | string/null | Regex for ticket ID extraction                                    |
| `ticketFetchAccess`       | string/null | `"cli"` or `"mcp"`                                                |
| `ticketFetchCommand`      | string/null | CLI command template or MCP tool name                             |
| `ticketTransitions`       | object/null | `{ start, done, feedback }` — values are status strings or arrays |
| `ticketTransitionAccess`  | string/null | `"cli"` or `"mcp"`                                                |
| `ticketTransitionCommand` | string/null | CLI command template or MCP tool name                             |
| `coderabbit`              | boolean     | Whether CodeRabbit is active                                      |
| `prereviewEnabled`        | boolean     | Whether to run local prereview                                    |
| `reReviewComment`         | string/null | Comment to post requesting re-review                              |
| `reviewComment`           | string/null | Initial review request comment                                    |

### Per-phase state files

See each phase's PHASE.md for the schema:

- `plan-state.json` — `plan/PHASE.md`
- `impl-state.json` — `implementation/PHASE.md`
- `polish-state.json` — `polish/PHASE.md`

## Spec Directory Structure (Versioned)

```
spec/
└── {ticketId}/                # e.g., "PE-1234" or "CU-abc123"
    ├── ticket.md               # Full ticket + parent hierarchy (pre-fetched by repo-setup)
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

**ticket.md**: Generated during repo-setup, contains the main ticket plus all parent tickets walked up the hierarchy. Persists across spec versions.

**Why versioned?** After PR completion, you may have learnings that warrant changes. Versioning preserves the original spec, captures feedback, and creates a new iteration.

## Spawning Pattern

### Sub-agents (stateless)

```
Task(
  subagent_type: "general-purpose",
  model: "haiku",
  description: "{task description}",
  prompt: "Read {file} and execute. Working dir: {WORKDIR}. ..."
)
```

### Team agents

```
Task(
  subagent_type: "general-purpose",
  model: "<haiku|sonnet|opus>",
  description: "Run {step} for {ticketId}",
  prompt: "Read {step file} and execute. Working dir: {WORKDIR}. State: {relevant fields}. Report: {expected format}.",
  team_name: "{teamName}"
)
```

## Common Agents

Shared between phases. See `common/` directory:

| Agent              | Model  | Type       | File                           | Used by                                             |
| ------------------ | ------ | ---------- | ------------------------------ | --------------------------------------------------- |
| clear-loop         | haiku  | sub        | `common/clear-loop.md`         | Phase 2 (between plans), Phase 3 (before fix cycle) |
| run-devloop        | sonnet | team       | `common/run-devloop.md`        | Phase 2 (`running`), Phase 3 (`run_fix`)            |
| resolve-or-rewrite | —      | inline ref | `common/resolve-or-rewrite.md` | Phase 2 (after running), Phase 3 (after run_fix)    |

## Resolver Agents (Phase 3)

After poller returns, resolvers are dispatched from `polish/steps/resolve.md`:

| Action               | Resolver            | Model  | File                                      |
| -------------------- | ------------------- | ------ | ----------------------------------------- |
| `rebase`             | rebase-resolver     | sonnet | `polish/resolvers/rebase-resolver.md`     |
| `ci_fix`             | ci-resolver         | sonnet | `polish/resolvers/ci-resolver.md`         |
| `human_review`       | review-resolver     | opus   | `polish/resolvers/review-resolver.md`     |
| `coderabbit_threads` | coderabbit-resolver | opus   | `polish/resolvers/coderabbit-resolver.md` |
| `other_threads`      | thread-resolver     | opus   | `polish/resolvers/thread-resolver.md`     |

**Rebase runs FIRST.** If it pushes → back to poll. Other resolvers run in parallel.

**CodeRabbit resolver:** Only spawn if `repoConfig.coderabbit` is `true`.

### Priority Order for Code Fixes

| Priority | Source        | Reason                         |
| -------- | ------------- | ------------------------------ |
| 1        | CI failures   | Must pass before anything else |
| 2        | Human reviews | Blocking merge                 |
| 3        | CodeRabbit    | Nice to have, AI feedback      |

## Rules

1. **Auto-detect ticket** — only ask if not found in argument, branch, or worktree
2. **Auto-detect ticket system** — via `repoConfig.ticketSystem` (populated by repo-setup from repo config files)
3. **Require spec approval** — before entering autonomous loop
4. **Challenge before building** — iteratively clarify specs and plans in chat (not AskUserQuestion), be devil's advocate
5. **Firm spec = firm commitment** — don't proceed until all ambiguities resolved
6. **Fully autonomous after approval** — only stop for spec conflict (exit 2) or push failure
7. **Delegate to dev-loop** — don't duplicate its implement-then-review logic
8. **Task specs describe WHAT, plans describe HOW** — neither contains exact code
9. **Always use sub-plans** — minimum 1 plan per task (no single-spec branching), named `plan-N` (not `phase-N`)
10. **Transition ticket status at phase boundaries** — using `repoConfig.ticketTransitions`
11. **After both approvals, request context clear before execution**
12. **On re-invocation, dispatch based on currentPhase + per-phase state**
13. **NEVER read step files directly** — always spawn a teammate and tell it which step file to read and execute the logic. This saves context on the main orchestrator.
14. **Only write_spec, write_plans, resolve, resolve_fix, and feedback_check run inline** — all other steps are team agents or sub-agents
15. **Feedback loop: re-approve merged spec → new sub-plans → context clear → execute**
16. **Per-phase state-agents handle state writes** — orchestrator never writes state files directly (bootstrap exceptions: setup.md creates task-state.json, repo-setup.md writes repoConfig)
17. **Push agent cleans up rb-review.md** before pushing
18. **Committed spec files** — `spec/{ticketId}/v{N}/task-spec.md` (versioned) + `plans/*.md`
19. **Check commit conventions** — look for CONTRIBUTING.md, commitlint, recent git log
20. **Include ticket ID** — in commits, branches, PRs (when available), using `{ticketId}` placeholder
21. **Never push to main/master**
22. **Never force push** — except `--force-with-lease` after rebase-resolver
23. **Always use dev-loop poll-pr** — NEVER use `gh pr watch` in polling
24. **Three-wave execution** — immediate actions → code fixes (merged) → post-push actions
25. **One combined spec** — merge all resolver fixes into ONE spec before dev-loop
26. **Priority merging** — CI(1) > Review(2) > CodeRabbit(3), drop lower priority overlaps
27. **Push back on CodeRabbit reasonably** — evaluate critically but professionally
28. **Never close threads without note** — always post explanation with signature first
29. **Bot signature** — all resolver replies include `"By Claude Code Kagent Autopilot 🤖"`

## Prerequisites

- Git repository with remote configured
- `gh` CLI installed and authenticated
- For Jira: `acli` installed and authenticated (`acli jira auth`)
- For ClickUp: ClickUp MCP server configured
- `dev-loop` CLI (Phase 2 and fix cycles in Phase 3)
