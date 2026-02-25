---
name: kagent-autopilot
description: 'End-to-end task completion from ticket to merged PR, or push-to-merge for manual implementations. Use when running /kagent-autopilot, automating ticket workflow, wanting hands-off task completion, or needing autonomous PR cycles.'
argument-hint: '[TICKET_ID]'
---

# KAgent Autopilot — Autonomous Ticket to PR

Two modes:

- **Autopilot mode**: Takes a ticket and autonomously implements it through to a merge-ready PR using `dev-loop` (kagent-run). After spec approval, fully autonomous except **spec conflict** (exit 2) and **push failure**.
- **Manual mode**: You already implemented the code. Autopilot handles the push → CI/review → fix loop, fixing issues directly without dev-loop.

## Agent Team Architecture

This skill runs as an agent team with an orchestrator and specialized phase agents:

```
┌─────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR (you)                       │
│  - Maintains state (.kagent/task-state.json)                │
│  - Handles phase dispatch                                   │
│  - Spawns phase agents                                      │
│  - Handles: setup, sub_planning, run_spec, pushing          │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │  RUNNER  │        │PREREVIEW │        │ POLLING  │
   │  AGENT   │        │  AGENT   │        │  AGENT   │
   └──────────┘        └──────────┘        └──────────┘
   Long dev-loop       Fresh context        Fresh context
   execution           for review           for CI parsing
```

**Why agents for these phases?**

- **Runner**: Long-running (30+ min), needs isolation
- **Prereview**: Needs fresh context for objective CodeRabbit analysis
- **Polling**: Needs fresh context to parse CI/review feedback without prior baggage

## Glossary

| Term           | Scope                            | Description                                                                             |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| **Iteration**  | Inner (dev-loop, autopilot only) | One implement-then-review pass. Controlled by `maxIterations`.                          |
| **Push cycle** | Outer (both modes)               | One round: commit, push, CI/review check. Controlled by `maxPushCycles`.                |
| **Sub-plan**   | Autopilot only (optional)        | A portion of a large task spec. Multiple sub-plans are run sequentially before pushing. |
| **Conflict**   | Dev-loop exit 2 (autopilot only) | The spec contains contradictory or ambiguous requirements.                              |

## State Machine

```
Autopilot mode:
  [setup] ──→ approved ──→ sub_planning ──→ run_spec ──→ running ──→ prereview ──→ pushing ──→ polling ──→ completed
      │                                        │            │  (agent)     │  (agent)      │    │  (agent)    │
      └────────────────────────────────────────┴────────────┴─────────────┴───────────────┴────┴─────────────┘
                                (feedback from CI/reviews → fix spec → runner agent)

Manual mode:
  [setup] ──→ prereview ──→ pushing ──→ polling ──→ completed
                 │  (agent)    │           │  (agent)
                 └─────────────┴───────────┴───────────┘
                 (feedback from CI/reviews → agent fixes directly)
```

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

**On invocation, create the agent team and read `.kagent/task-state.json`.**

### Step 1: Create Team (if not exists)

```bash
# Check if team already exists for this task
ls ~/.claude/teams/kagent-autopilot-*/config.json 2>/dev/null | head -1
```

If no team exists, create one:

Use TeamCreate with:

- `team_name`: `"kagent-autopilot-{ticketId-or-branch}"` (e.g., `kagent-autopilot-PE-1234` or `kagent-autopilot-manual`)
- `description`: `"Autopilot for {ticketId}"`
- `agent_type`: `"general-purpose"`

### Step 2: Dispatch Based on Phase

Read `.kagent/task-state.json` and dispatch accordingly:

| Condition               | Action                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| File does not exist     | Read `phases/setup.md` (handled by orchestrator)                                                    |
| `phase: "approved"`     | Read `phases/sub-planning.md` (handled by orchestrator)                                             |
| `phase: "sub_planning"` | Read `phases/sub-planning.md` (handled by orchestrator)                                             |
| `phase: "run_spec"`     | Read `phases/run-spec.md` (handled by orchestrator)                                                 |
| `phase: "running"`      | **Spawn runner agent** — see [Runner Agent](#runner-agent) below                                    |
| `phase: "prereview"`    | **Spawn prereview agent** — see [Prereview Agent](#prereview-agent) below                           |
| `phase: "pushing"`      | Read `phases/pushing.md` (handled by orchestrator)                                                  |
| `phase: "polling"`      | **Spawn polling agent** — see [Polling Agent](#polling-agent) below                                 |
| `phase: "completed"`    | Report: "Task already completed. PR #{prNumber}."                                                   |
| `phase: "failed"`       | Report status and last error. Offer to retry — if yes, dispatch to appropriate phase based on mode. |

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

Spawned for the `prereview` phase. Handles CodeRabbit local review with fresh context.

```json
{
  "description": "Run CodeRabbit prereview",
  "prompt": "You are the prereview agent for kagent-autopilot. Your job is to run CodeRabbit CLI review and fix findings.\n\n## Context\n- Working directory: {WORKDIR}\n- Task ID: {ticketId}\n- State file: .kagent/task-state.json\n\n## Your Task\n1. Read the phase file at phases/prereview.md\n2. Check if this is an atomicloud repo (git remote -v | grep -E '(atomicloud|atomi)')\n3. If not atomicloud, report 'skip'\n4. If atomicloud:\n   a. Run: coderabbit review --plain --base main > review.md 2>&1 (in background)\n   b. Wait with TaskOutput\n   c. Process findings:\n      - TRUE POSITIVES: fix directly in code\n      - FALSE POSITIVES (reasonable): add comments\n      - FALSE POSITIVES (wrong): use hidden comments in markdown, ignore for other files\n   d. Remove review.md\n   e. Commit any fixes\n5. Report back:\n   - 'skip' if not atomicloud\n   - 'no-findings' if review was clean\n   - 'fixed: N' if N issues were fixed\n   - 'error: <message>' if something failed\n\n## Important\n- Do NOT update .kagent/task-state.json\n- Focus on objective analysis with fresh eyes",
  "subagent_type": "general-purpose"
}
```

### Polling Agent

Spawned for the `polling` phase. Handles CI/review checking with fresh context.

````json
{
  "description": "Poll PR for CI/review",
  "prompt": "You are the polling agent for kagent-autopilot. Your job is to check PR status and report feedback.\n\n## Context\n- Working directory: {WORKDIR}\n- Task ID: {ticketId}\n- PR Number: {prNumber}\n- State file: .kagent/task-state.json\n- Push Cycle: {pushCycle}/{maxPushCycles}\n\n## Your Task\n1. Read the phase file at phases/polling.md\n2. Use `dev-loop poll-pr` (NOT gh pr watch) to check PR status\n3. Parse the results and report back:\n   - CI status: passing/failing/pending\n   - Review status: approved/changes_requested/pending\n   - Any actionable feedback (CI errors, review comments)\n   - If changes needed, list them clearly\n\n## Report Format\n```\nSTATUS: <approved|changes_needed|pending>\nCI: <passing|failing|pending>\nREVIEWS: <approved|changes_requested|pending>\n\nFEEDBACK:\n- <item 1>\n- <item 2>\n\nACTION: <none|fix_and_push|wait>\n```\n\n## Important\n- Do NOT update .kagent/task-state.json\n- Do NOT make code changes (that's the orchestrator's job)\n- Just report what you find",
  "subagent_type": "general-purpose"
}
````

## Orchestrator Responsibilities

The orchestrator (you) handles:

1. **State management** — Read/write `.kagent/task-state.json` at every phase transition
2. **Team coordination** — Create team, spawn agents, receive their reports
3. **Direct phase execution** — setup, sub_planning, run_spec, pushing
4. **Processing agent reports** — Update state based on agent findings
5. **User interaction** — AskUserQuestion for spec approval, conflicts, failures

## Spawning Agents

Use the Task tool to spawn phase agents:

```
Task(
  subagent_type: "general-purpose",
  description: "Run dev-loop for PE-1234",
  prompt: "<agent prompt from above with variables substituted>",
  team_name: "kagent-autopilot-PE-1234"
)
```

After the agent completes, read its report and update state accordingly.

## Rules

1. **Auto-detect ticket** — only ask if not found in argument, branch, or worktree
2. **Auto-detect ticket system** — PE = Jira, CU = ClickUp
3. **Require spec approval** — before entering autonomous loop (autopilot only)
4. **Fully autonomous after approval** — only stop for spec conflict (exit 2) or push failure
5. **Delegate to dev-loop** — don't duplicate its implement-then-review logic (autopilot only)
6. **State file required** — read/write `.kagent/task-state.json` at every phase transition
7. **Committed spec files** — `spec/<task-id>/task-spec.md` (persistent) + `spec/<task-id>/plans/*.md` (phases) — autopilot only
8. **Check commit conventions** — look for CONTRIBUTING.md, commitlint, recent git log
9. **Include ticket ID** — in commits, branches, PRs (when available)
10. **Never push to main/master**
11. **Never force push**
12. **Always use dev-loop poll-pr** — NEVER use `gh pr watch` in polling phase

## Prerequisites

- Git repository with remote configured
- `gh` CLI installed and authenticated
- For Jira: `acli` installed and authenticated (`acli jira auth`)
- For ClickUp: ClickUp MCP server configured
- `dev-loop` CLI and `tmux` (autopilot mode only)
