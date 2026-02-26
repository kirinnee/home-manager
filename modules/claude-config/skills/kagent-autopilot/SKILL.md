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
      └──────────────────────────┴──────────────┴────────────┴─────────────┴───────────────┴────┴─────────────┘
                                (feedback from CI/reviews → spawn resolvers → fix)

Manual mode:
  [setup] ──→ prereview ──→ pushing ──→ polling ──→ completed
                 │  (agent)    │           │  (agent)
                 └─────────────┴───────────┴───────────┘
                 (feedback from CI/reviews → spawn resolvers → fix)
```

Note: `sub_planning?` is optional — only for large/multi-context tasks. Most tasks skip directly to `run_spec`.

## Key State Fields (`.kagent/task-state.json`)

| Field                 | Type        | Description                                                                                              |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `phase`               | string      | Current state: approved, sub_planning, run_spec, running, prereview, pushing, polling, completed, failed |
| `mode`                | string      | `"autopilot"` (dev-loop) or `"manual"` (direct fixes)                                                    |
| `ticketId`            | string/null | Ticket ID (PE-1234, CU-abc123). Null in manual mode if no ticket.                                        |
| `pushCycle`           | number      | Current push cycle (0-indexed, incremented after push)                                                   |
| `maxPushCycles`       | number      | Outer loop limit (default 5)                                                                             |
| `prNumber`            | number/null | GitHub PR number                                                                                         |
| `lastRunId`           | string/null | Most recent dev-loop run ID (autopilot only)                                                             |
| `devLoopInitialized`  | boolean     | Whether `dev-loop init` has been run (autopilot only)                                                    |
| `specDir`             | string/null | Path to spec directory, e.g., `spec/PE-1234`. Null in manual mode.                                       |
| `subPlans`            | array/null  | Sub-plan files for large tasks. Each item: `{id, file, status}`. Null if single plan.                    |
| `currentSubPlanIndex` | number/null | Current sub-plan index (0-indexed). Null if not using sub-plans                                          |

Full schema with all fields is in `phases/setup.md`.

## Spec Directory Structure

```
spec/
└── <task-id>/              # e.g., "PE-1234" or "feature-auth"
    ├── task-spec.md        # Original full task spec (persistent)
    └── plans/              # Only created if sub-plans are needed
        ├── phase-1.md      # Sub-plan 1
        ├── phase-2.md      # Sub-plan 2
        └── ...
```

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
| `phase: "completed"`    | Report: "Task already completed. PR #{prNumber}."                                                    |
| `phase: "failed"`       | Report status and last error. Offer to retry — if yes, dispatch to appropriate phase based on mode.  |

## Phase Agents

### Runner Agent

Spawned for the `running` phase. Handles dev-loop execution.

```json
{
  "description": "Run dev-loop for task",
  "prompt": "You are the runner agent for kagent-autopilot. Your job is to execute dev-loop and report results.\n\n## Context\n- Working directory: {WORKDIR}\n- Task ID: {ticketId}\n- State file: .kagent/task-state.json\n\n## Your Task\n1. Read the phase file at phases/running.md\n2. Execute dev-loop as instructed\n3. When complete, report back:\n   - Exit code (0, 1, or 2)\n   - Run ID from .kagent/history/\n   - Status (completed, max_iterations, error, conflict)\n   - Any errors or conflicts\n\n## Important\n- Do NOT update .kagent/task-state.json (orchestrator does that)\n- Just report your findings when done\n- If conflict detected (exit 2), include conflict.md contents in your report",
  "subagent_type": "general-purpose"
}
```

### Prereview Agent

Spawned for the `prereview` phase. Handles CodeRabbit local review with fresh context. **FIGHT BACK** - evaluate critically.

```json
{
  "description": "Run CodeRabbit prereview",
  "prompt": "You are the prereview agent for kagent-autopilot. Your job is to run CodeRabbit CLI review and fix findings. **FIGHT BACK** - evaluate critically.\n\n## Context\n- Working directory: {WORKDIR}\n- Task ID: {ticketId}\n- State file: .kagent/task-state.json\n\n## Philosophy\n\n**CodeRabbit is often wrong.** Evaluate EVERY comment critically. Don't blindly accept suggestions.\n\n## Your Task\n1. Read the phase file at phases/prereview.md\n2. Check if this is an atomicloud repo (git remote -v | grep -E '(atomicloud|atomi)')\n3. If not atomicloud, report 'skip'\n4. If atomicloud:\n   a. Run: coderabbit review --plain --base main > review.md 2>&1 (in background)\n   b. Wait with TaskOutput\n   c. Process findings:\n      - TRUE POSITIVES: fix directly in code\n      - FALSE POSITIVES (reasonable): add comments\n      - FALSE POSITIVES (wrong): use hidden comments in markdown, ignore for other files\n   d. Remove review.md\n   e. Commit any fixes\n5. Report back:\n   - 'skip' if not atomicloud\n   - 'no-findings' if review was clean\n   - 'fixed: N' if N issues were fixed\n   - 'error: <message>' if something failed\n\n## Important\n- Do NOT update .kagent/task-state.json\n- **Never blindly accept** - always evaluate critically\n- Focus on objective analysis with fresh eyes",
  "subagent_type": "general-purpose"
}
```

### Polling Phase

The polling phase uses a **three-wave execution model**:

```
POLLER (gathers all context)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  WAVE 1: IMMEDIATE ACTIONS                                  │
│  • Close threads (outdated/ghosted/acknowledged)            │
│  • Post replies (questions, false positives)                │
│  → No code changes, execute directly                        │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  WAVE 2: CODE FIXES                                         │
│  • Collect all code_fixes from resolvers                    │
│  • Merge by priority: CI(1) > Review(2) > CodeRabbit(3)     │
│  • Generate ONE combined spec                               │
│  → Run dev-loop (autopilot) or apply directly (manual)      │
│  → Commit and push                                          │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  WAVE 3: POST-PUSH ACTIONS                                  │
│  • Post replies with commit SHA                             │
│  • Request re-evaluation from CodeRabbit                    │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
    LOOP TO POLLING
```

See `phases/polling.md` for full details.

#### Poller Agent

Gathers all PR context and returns a structured JSON report:

```json
{
  "description": "Gather full PR context",
  "prompt": "You are the poller agent. Gather ALL PR context...\n\n[See phases/polling.md for full prompt]",
  "subagent_type": "general-purpose"
}
```

#### Resolver Agents

After the poller returns, spawn resolvers IN PARALLEL based on `actions_needed`:

| Action               | Resolver              | Description                                 |
| -------------------- | --------------------- | ------------------------------------------- |
| `ci_fix`             | `ci-resolver`         | Fix failing CI checks                       |
| `human_review`       | `review-resolver`     | Address human review feedback               |
| `coderabbit_threads` | `coderabbit-resolver` | Handle CodeRabbit AI comments (fight back!) |
| `other_threads`      | `thread-resolver`     | Handle non-CodeRabbit conversations         |
| `rebase`             | `rebase-resolver`     | Handle branch behind/conflicts              |

All resolvers are in `phases/resolvers/`.

#### Resolver Output Format

Each resolver returns a structured output:

```json
{
  "resolver_type": "ci|review|coderabbit|thread|rebase",

  "immediate_actions": [
    {
      "type": "close_thread|post_reply",
      "thread_id": "PRRT_...",
      "comment_id": "...",
      "body": "Reply with signature",
      "reason": "outdated|ghosted|acknowledged|false_positive|answering"
    }
  ],

  "code_fixes": [
    {
      "id": "fix-N",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What needs to change",
      "priority": 1|2|3,
      "source": "ci|review|coderabbit",
      "source_detail": "Original error/comment"
    }
  ],

  "post_push_actions": [
    {
      "type": "post_reply",
      "thread_id": "PRRT_...",
      "comment_id": "...",
      "body_template": "Fixed in {commit_sha}...",
      "wait_for_fix_id": "fix-N",
      "request_re_evaluation": true
    }
  ]
}
```

#### Priority Order for Code Fixes

| Priority | Source        | Reason                         |
| -------- | ------------- | ------------------------------ |
| 1        | CI failures   | Must pass before anything else |
| 2        | Human reviews | Blocking merge                 |
| 3        | CodeRabbit    | Nice to have, AI feedback      |

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
9. **Committed spec files** — `spec/<task-id>/task-spec.md` (persistent) + `spec/<task-id>/plans/*.md` (phases) — autopilot only
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
