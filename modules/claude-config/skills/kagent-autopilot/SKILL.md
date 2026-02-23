---
name: kagent-autopilot
description: 'End-to-end task completion from ticket to merged PR, or push-to-merge for manual implementations. Use when running /kagent-autopilot, automating ticket workflow, wanting hands-off task completion, or needing autonomous PR cycles.'
argument-hint: '[TICKET_ID]'
---

# KAgent Autopilot — Autonomous Ticket to PR

Two modes:

- **Autopilot mode**: Takes a ticket and autonomously implements it through to a merge-ready PR using `dev-loop` (kagent-run). After spec approval, fully autonomous except **spec conflict** (exit 2) and **push failure**.
- **Manual mode**: You already implemented the code. Autopilot handles the push → CI/review → fix loop, fixing issues directly without dev-loop.

## Glossary

| Term           | Scope                            | Description                                                              |
| -------------- | -------------------------------- | ------------------------------------------------------------------------ |
| **Iteration**  | Inner (dev-loop, autopilot only) | One implement-then-review pass. Controlled by `maxIterations`.           |
| **Push cycle** | Outer (both modes)               | One round: commit, push, CI/review check. Controlled by `maxPushCycles`. |
| **Conflict**   | Dev-loop exit 2 (autopilot only) | The spec contains contradictory or ambiguous requirements.               |

## State Machine

```
Autopilot mode:
  [setup] ──→ run_spec ──→ running ──→ pushing ──→ polling ──→ completed
                 ↑            |           |           |
                 +────────────+───────────+───────────+
                 (feedback from CI/reviews → fix spec → dev-loop)

Manual mode:
  [setup] ──→ pushing ──→ polling ──→ completed
                 ↑           |
                 +───────────+
                 (feedback from CI/reviews → agent fixes directly)
```

## Key State Fields (`.kagent/task-state.json`)

| Field                | Type        | Description                                                                     |
| -------------------- | ----------- | ------------------------------------------------------------------------------- |
| `phase`              | string      | Current state: approved, run_spec, running, pushing, polling, completed, failed |
| `mode`               | string      | `"autopilot"` (dev-loop) or `"manual"` (direct fixes)                           |
| `ticketId`           | string/null | Ticket ID (PE-1234, CU-abc123). Null in manual mode if no ticket.               |
| `pushCycle`          | number      | Current push cycle (0-indexed, incremented after push)                          |
| `maxPushCycles`      | number      | Outer loop limit (default 5)                                                    |
| `prNumber`           | number/null | GitHub PR number                                                                |
| `lastRunId`          | string/null | Most recent dev-loop run ID (autopilot only)                                    |
| `devLoopInitialized` | boolean     | Whether `dev-loop init` has been run (autopilot only)                           |

Full schema with all fields is in `phases/setup.md` (where the state file is created).

## Phase Dispatch

**On invocation, read `.kagent/task-state.json`.** Based on the `phase` field (or absence of file), use the Read tool to load the corresponding phase file and follow its instructions.

| Condition            | Action                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| File does not exist  | Read `phases/setup.md`                                                                                                                       |
| `phase: "approved"`  | Read `phases/run-spec.md`                                                                                                                    |
| `phase: "run_spec"`  | Read `phases/run-spec.md`                                                                                                                    |
| `phase: "running"`   | Read `phases/running.md`                                                                                                                     |
| `phase: "pushing"`   | Read `phases/pushing.md`                                                                                                                     |
| `phase: "polling"`   | Read `phases/polling.md`                                                                                                                     |
| `phase: "completed"` | Report: "Task already completed. PR #{prNumber}."                                                                                            |
| `phase: "failed"`    | Report status and last error. Offer to retry — if yes and mode is autopilot, read `phases/run-spec.md`; if manual, read `phases/pushing.md`. |

**IMPORTANT: Read ONLY the one phase file indicated above. Do NOT preemptively read other phase files. Each phase file is self-contained with its own instructions, transitions, and next steps. When a phase file tells you "Next: read phases/X.md", read that file at that point — not before.**

## Rules

1. **Auto-detect ticket** — only ask if not found in argument, branch, or worktree
2. **Auto-detect ticket system** — PE = Jira, CU = ClickUp
3. **Require spec approval** — before entering autonomous loop (autopilot only)
4. **Fully autonomous after approval** — only stop for spec conflict (exit 2) or push failure
5. **Delegate to dev-loop** — don't duplicate its implement-then-review logic (autopilot only)
6. **State file required** — read/write `.kagent/task-state.json` at every phase transition
7. **Two spec files** — `task-spec.md` (persistent) + `spec.md` (per-cycle) — autopilot only
8. **Check commit conventions** — look for CONTRIBUTING.md, commitlint, recent git log
9. **Include ticket ID** — in commits, branches, PRs (when available)
10. **Never push to main/master**
11. **Never force push**

## Prerequisites

- Git repository with remote configured
- `gh` CLI installed and authenticated
- For Jira: `acli` installed and authenticated (`acli jira auth`)
- For ClickUp: ClickUp MCP server configured
- `dev-loop` CLI and `tmux` (autopilot mode only)
