---
name: kagent-run
description: 'Run spec-driven code implementation with multi-reviewer consensus. Use when running /kagent-run, starting an implementation loop, needing automated code review cycles, or iterating on code until all reviewers approve.'
argument-hint: '[TASK_DESCRIPTION]'
---

# KAgent Run - Spec-Driven Development with Multi-Reviewer Consensus

An iterative development loop where an implementer works from a spec, and multiple reviewers evaluate the work in phases. Review phases short-circuit on rejection — if any reviewer in a phase rejects, remaining phases are skipped.

## When to Use

- User runs `/kagent-run` with a task description
- User wants automated implement→review→fix cycles
- User needs multiple AI reviewers to reach consensus
- User wants hands-off iteration until code is approved

## Prerequisites

- `tmux` installed (brew install tmux / apt install tmux)
- At least one `claude-*` binary available
- For reviewers: `claude-*` binaries configured (reviewer binaries or standard ones)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Interactive Setup (this session)                   │
│   • Discover claude-* binaries                              │
│   • User selects implementers (weighted) + reviewers (phases)│
│   • Claude writes/refines spec, user approves               │
│   • Initialize kagent in .kagent                            │
│   • Ask user: start now or later?                           │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Execution                                           │
│   If user chose "start now":                                 │
│     • Run dev-loop as background task with Bash tool        │
│     • Wait for completion with TaskOutput (blocks)          │
│     • Report results, offer follow-up                       │
│                                                             │
│   If user chose "do it myself":                             │
│     • Provide command for user to run in their terminal     │
│                                                             │
│   The loop runs with:                                       │
│     for each iteration:                                     │
│       randomly pick implementer (weighted)                  │
│       executor --print "implement..."                       │
│       run review phases IN SEQUENCE:                        │
│         phase 1: reviewers IN PARALLEL                      │
│         if any reject → skip remaining phases, fix          │
│         phase 2: reviewers IN PARALLEL                      │
│         ...                                                 │
│       Conflict check if consecutive failures ≥ threshold     │
│     Until: ALL phases approved OR max iterations reached    │
└─────────────────────────────────────────────────────────────┘
```

## Workflow

### Step 1: Discover Claude Binaries

```bash
compgen -c | grep '^claude' | sort -u
```

### Step 2: Select Implementers (Weighted)

Use `AskUserQuestion`:

- Header: "Implementers"
- Question: "Which claude binaries should implement? (weighted selection — weight after colon, e.g. auto-zai:2)"
- Options: discovered binaries (prioritize non-reviewer ones)
- Default: `claude-auto-zai:2,claude-auto-mm:1`

Weighted random selection picks an implementer per iteration based on weights. Higher weight = more likely.

### Step 3: Select Reviewers (Phases + noVerdictAsFailure)

Use `AskUserQuestion` with `multiSelect: true`:

- Header: "Reviewers"
- Question: "Which reviewers in which phases? (pipe separates phases, colon suffix controls noVerdictAsFailure)"
- Options: discovered binaries (prioritize reviewer-\* ones)
- Default: `"claude-auto-zai:1,claude-auto-mm:1,claude-auto-seed:0|claude-auto-zai:1,claude-auto-anthropic:1,claude-auto-gemini:0|claude-auto-codex:1,claude-auto-kimi:0"`

**Review phase format:** `"phase1_reviewers|phase2_reviewers|phase3_reviewers"`

- Reviewers within a phase run **in parallel**
- Phases run **in sequence** — if any reviewer in a phase rejects, remaining phases are **skipped** (short-circuit)
- First iteration runs **all reviewers across all phases in parallel** (no short-circuit) due to `--first-loop-full-review`

**noVerdictAsFailure suffix** (after reviewer name, e.g. `auto-zai:1`):

- `:1` = no verdict counts as **failure/rejection** (default) — used for critical reviewers
- `:0` = no verdict counts as **success/approval** — used for optional/tolerant reviewers

### Step 4: Initialize KAgent

```bash
dev-loop init \
  --implementers "claude-auto-zai:2,claude-auto-mm:1" \
  --review-phases "claude-auto-zai:1,claude-auto-mm:1,claude-auto-seed:0|claude-auto-zai:1,claude-auto-anthropic:1,claude-auto-gemini:0|claude-auto-codex:1,claude-auto-kimi:0" \
  --conflict-checker claude-auto-zai \
  --first-loop-full-review \
  --previous-review-propagation 0.75
```

Options:

| Option                          | Default                              | Description                                       |
| ------------------------------- | ------------------------------------ | ------------------------------------------------- |
| `--implementers`                | `claude-auto-zai:2,claude-auto-mm:1` | Weighted implementer list (name:weight pairs)     |
| `--review-phases`               | see above                            | Pipe-separated review phases (parallel within)    |
| `--conflict-checker`            | (none)                               | Binary to check for spec conflicts                |
| `--conflict-check-threshold`    | `3`                                  | Consecutive failures before conflict check        |
| `--first-loop-full-review`      | `true`                               | Always run all review phases on first iteration   |
| `--previous-review-propagation` | `0.75`                               | Probability each reviewer sees prior loop reviews |
| `--max-iterations`              | `10`                                 | Maximum iterations before giving up               |
| `--implementer-timeout`         | `30`                                 | Implementer timeout in minutes                    |
| `--reviewer-timeout`            | `15`                                 | Reviewer timeout in minutes                       |

### Step 5: Write Spec

Help the user refine the spec. Edit `.kagent/spec.md` using the template in [templates/spec-template.md](templates/spec-template.md). Work collaboratively with the user to ensure the spec is clear and complete.

### Step 6: User Approval

**MANDATORY: Ask user to approve before proceeding.**

Present the spec and selected implementers/reviewers. Use `AskUserQuestion`:

- Header: "Approve"
- Question: "Does this spec look correct?"
- Options: "Approve" / "Edit spec first"

### Step 7: Ask How to Start

After spec approval, ask the user how they want to proceed. Use `AskUserQuestion`:

- Header: "Start"
- Question: "How would you like to start the loop?"
- Options:
  - "Start now (I'll run it and wait for completion)"
  - "I'll start it myself (show me the command)"

### Step 8a: If User Wants You to Start

Run the loop as a background bash task and wait for completion:

```bash
dev-loop run 2>&1 | tee .kagent/run.log
```

Use `run_in_background: true` with Bash tool, then wait with TaskOutput. This blocks until the loop finishes.

**When complete, report results:**

- Exit 0 (completed): "KAgent run completed! All reviewers approved."
- Exit 0 (max_iterations): "Max iterations reached. Reviewers couldn't reach consensus."
- Exit 1 (error): "Run failed with error."
- Exit 2 (conflict): "Conflict detected — the spec may contain contradictions."
- Exit 3 (agent_failure): "Agent failure — a crash or timeout occurred."

**Offer follow-up actions via `AskUserQuestion`:**

- Header: "Next"
- Question: "The loop is done. What would you like to do?"
- Options:
  - "Review changes (git diff)"
  - "Commit the changes"
  - "Run tests"
  - "Start another loop with refined spec"

**Note on logs:** User can check `.kagent/run.log` for the full output. Detailed session logs are in `.kagent/logs/{runId}/`.

### Step 8b: If User Wants to Start Themselves

Provide the command:

```bash
dev-loop run 2>&1 | tee .kagent/run.log
```

Explain to the user:

- Run this command to start
- Logs are written to `.kagent/run.log`
- Check status anytime with: `dev-loop status`

## Rules

1. **ALWAYS discover binaries first** - Run `compgen -c | grep '^claude'`
2. **ALWAYS ask user to select** - Never assume which binaries
3. **Use `.kagent`** - Default directory for dev-loop
4. **Help refine the spec** - Work with user to ensure clarity
5. **NEVER modify spec after approval**
6. **Ask before starting** - Let user choose if you start or they do
7. **NEVER commit without asking** - Only commit if user approves
8. **Review phases short-circuit** - Rejection in any phase skips remaining phases
9. **Conflict detection is automatic** - When consecutive failures ≥ threshold, the conflict checker runs

## How to Verify

1. Check `.kagent/` directory exists
2. Check `spec.md` exists and is complete
3. Check `config.json` has been initialized with correct implementers, review phases, and settings
4. Loop has been started (either by you or user has the command)

## Reference

See [reference.md](reference.md) for:

- All CLI commands and options
- State file formats and directory structure
- Tmux session naming and agent invocation
- Checkpointer, conflict detection, metrics, and poll-pr

## Examples

See [examples.md](examples.md) for complete session examples.

## Version History

- v6.0.0 (2025-03): Weighted implementers, review phases, noVerdictAsFailure, conflict checker, first-loop-full-review, previous-review-propagation, agent_failure exit code, metrics, poll-pr, checkpointer
- v5.0.0 (2025-02): Align docs with source - fix CLI flags, state file formats, directory structure
- v4.0.0 (2025-02): Use background bash task instead of tmux, remove --dir flag
- v3.0.0 (2025-02): Renamed to kagent-run, added option to start & monitor
- v2.0.0 (2025-01): Restructured per skill best practices
- v1.0.0 (2024-12): Initial implementation
