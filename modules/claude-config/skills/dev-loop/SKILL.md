---
name: dev-loop
description: 'Run spec-driven code implementation with multi-reviewer consensus. Use when running /dev-loop, starting an implementation loop, needing automated code review cycles, or iterating on code until all reviewers approve.'
argument-hint: '[TASK_DESCRIPTION]'
---

# Dev Loop - Spec-Driven Development with Multi-Reviewer Consensus

An iterative development loop where an implementer works from a spec, and multiple reviewers evaluate the work in parallel. ALL reviewers must approve for the loop to complete.

## When to Use

- User runs `/dev-loop` with a task description
- User wants automated implement→review→fix cycles
- User needs multiple AI reviewers to reach consensus
- User wants hands-off iteration until code is approved

## Prerequisites

- `tmux` installed
- `jq` installed
- At least one `claude-*` binary available
- For reviewers: `claude-reviewer-*` binaries configured

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Interactive Setup (this session)                   │
│   • Discover claude-* binaries                              │
│   • User selects executor + reviewers                       │
│   • Claude writes spec, user approves                       │
│   • Start dev-loop in tmux                                  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Automated Execution (tmux session)                 │
│   for each iteration:                                       │
│     executor --print "implement..."                         │
│     reviewers run IN PARALLEL                               │
│   Until: ALL approve OR max loops reached                   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Polling (this session)                             │
│   Poll `dev-loop status` every 5 minutes                    │
│   Report progress until complete                            │
└─────────────────────────────────────────────────────────────┘
```

## Workflow

### Step 1: Discover Claude Binaries

```bash
compgen -c | grep '^claude' | sort -u
```

### Step 2: User Selects Executor

Use `AskUserQuestion`:

- Header: "Executor"
- Question: "Which claude binary should implement the code?"
- Options: discovered binaries (prioritize non-reviewer ones)

### Step 3: User Selects Reviewers

Use `AskUserQuestion` with `multiSelect: true`:

- Header: "Reviewers"
- Question: "Which claude binaries should review? (select multiple)"
- Options: discovered binaries (prioritize reviewer-\* ones)

### Step 4: Initialize Dev Loop

```bash
dev-loop init --claude <executor> --reviewers "<reviewer1,reviewer2>"
```

### Step 5: Write Spec

Edit `.claude/dev-loop/spec.md` using the template in [templates/spec-template.md](templates/spec-template.md).

### Step 6: User Approval

**MANDATORY: Ask user to approve before proceeding.**

Present the spec and selected executor/reviewers. Use `AskUserQuestion`:

- Header: "Approve"
- Question: "Does this spec look correct?"
- Options: "Approve" / "Edit spec first"

### Step 7: Start in tmux

```bash
SESSION_UID=$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)
tmux new-session -d -s "dev-loop-$SESSION_UID" "zsh -ic 'dev-loop run; read -q \"?Press Enter to close...\"'"
```

Tell user the session name and how to inspect: `tmux attach -t dev-loop-<UID>`

### Step 8: Poll for Progress

Every 5 minutes, run `dev-loop status` and report to user. **Always include the tmux session name** in updates.

Continue until status is `completed` or `max_loops_reached`.

## Rules

1. **ALWAYS discover binaries first** - Run `compgen -c | grep '^claude'`
2. **ALWAYS ask user to select** - Never assume which binaries
3. **NEVER modify spec after approval**
4. **NEVER commit** - Leave that to user
5. **ALL reviewers must approve** - Consensus required
6. **ALWAYS run in tmux** - With unique session UID
7. **ALWAYS poll and report** - Every 5 minutes
8. **ALWAYS repeat session name** - In every progress update

## How to Verify

1. Check `.claude/dev-loop/` directory exists
2. Check `loop-state.json` has correct status
3. Check tmux session is running: `tmux has-session -t dev-loop-<UID>`
4. Check `dev-loop status` shows expected phase

## Reference

See [reference.md](reference.md) for:

- All CLI commands and options
- State file formats
- Environment variables

## Examples

See [examples.md](examples.md) for complete session examples.

## Version History

- v2.0.0 (2025-01): Restructured per skill best practices
- v1.0.0 (2024-12): Initial implementation
