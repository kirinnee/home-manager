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
│   • Claude writes/refines spec, user approves               │
│   • Initialize dev-loop in .kagent                          │
│   • Give user command to run the loop                       │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: User-Initiated Execution                           │
│   User runs the provided command to start the loop          │
│   The loop runs in tmux with:                               │
│     for each iteration:                                     │
│       executor --print "implement..."                       │
│       reviewers run IN PARALLEL                             │
│     Until: ALL approve OR max loops reached                 │
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
dev-loop init --claude <executor> --reviewers "<reviewer1,reviewer2>" --dir .kagent
```

### Step 5: Write Spec

Help the user refine the spec. Edit `.kagent/spec.md` using the template in [templates/spec-template.md](templates/spec-template.md). Work collaboratively with the user to ensure the spec is clear and complete.

### Step 6: User Approval

**MANDATORY: Ask user to approve before proceeding.**

Present the spec and selected executor/reviewers. Use `AskUserQuestion`:

- Header: "Approve"
- Question: "Does this spec look correct?"
- Options: "Approve" / "Edit spec first"

### Step 7: Provide Run Command

After spec approval, provide the user with the command to run the loop. Do NOT execute it yourself.

```bash
SESSION_UID=$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 4)
tmux new-session -d -s "dev-loop-$SESSION_UID" "zsh -ic 'dev-loop run --dir .kagent; read -q \"?Press Enter to close...\"'"
```

Explain to the user:

- Run this command to start the dev loop
- They can inspect progress with: `tmux attach -t dev-loop-<UID>`
- Check loop status with: `dev-loop status --dir .kagent`

## Rules

1. **ALWAYS discover binaries first** - Run `compgen -c | grep '^claude'`
2. **ALWAYS ask user to select** - Never assume which binaries
3. **Use `.kagent`** - NOT `.claude/dev-loop`
4. **Help refine the spec** - Work with user to ensure clarity
5. **NEVER modify spec after approval**
6. **NEVER start the loop** - Only provide the command to user
7. **NEVER commit** - Leave that to user
8. **ALL reviewers must approve** - Consensus required

## How to Verify

1. Check `.kagent/` directory exists
2. Check `spec.md` exists and is complete
3. Check `loop-state.json` has been initialized with correct executor and reviewers
4. User has been provided with the run command

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
