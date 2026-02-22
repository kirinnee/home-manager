---
name: kagent-run
description: 'Run spec-driven code implementation with multi-reviewer consensus. Use when running /kagent-run, starting an implementation loop, needing automated code review cycles, or iterating on code until all reviewers approve.'
argument-hint: '[TASK_DESCRIPTION]'
---

# KAgent Run - Spec-Driven Development with Multi-Reviewer Consensus

An iterative development loop where an implementer works from a spec, and multiple reviewers evaluate the work in parallel. ALL reviewers must approve for the loop to complete.

## When to Use

- User runs `/kagent-run` with a task description
- User wants automated implement→review→fix cycles
- User needs multiple AI reviewers to reach consensus
- User wants hands-off iteration until code is approved

## Prerequisites

- `tmux` installed (brew install tmux / apt install tmux)
- At least one `claude-*` binary available
- For reviewers: `claude-reviewer-*` binaries configured

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Interactive Setup (this session)                   │
│   • Discover claude-* binaries                              │
│   • User selects executor + reviewers                       │
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
│       executor --print "implement..."                       │
│       reviewers run IN PARALLEL                             │
│     Until: ALL approve OR max iterations reached            │
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

### Step 4: Initialize KAgent

```bash
dev-loop init --implementer <executor> --reviewers "<reviewer1,reviewer2>"
```

Options:

- `--implementer <binary>`: Implementer binary name (default: claude)
- `--reviewers <list>`: Reviewer binaries, comma-separated (default: claude-reviewer-zai)
- `--max-iterations <n>`: Maximum iterations (default: 10)
- `--implementer-timeout <mins>`: Implementer timeout (default: 30)
- `--reviewer-timeout <mins>`: Reviewer timeout (default: 15)

### Step 5: Write Spec

Help the user refine the spec. Edit `.kagent/spec.md` using the template in [templates/spec-template.md](templates/spec-template.md). Work collaboratively with the user to ensure the spec is clear and complete.

### Step 6: User Approval

**MANDATORY: Ask user to approve before proceeding.**

Present the spec and selected executor/reviewers. Use `AskUserQuestion`:

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

```
[Bash tool with run_in_background: true]
command: dev-loop run 2>&1 | tee .kagent/run.log
```

Then use TaskOutput to wait for completion. This blocks until the loop finishes.

**When complete, report results:**

- If success: "KAgent run completed! All reviewers approved."
- If max iterations: "Max iterations reached. Reviewers couldn't reach consensus."

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
8. **ALL reviewers must approve** - Consensus required

## How to Verify

1. Check `.kagent/` directory exists
2. Check `spec.md` exists and is complete
3. Check `config.json` has been initialized with correct implementer and reviewers
4. Loop has been started (either by you or user has the command)

## Reference

See [reference.md](reference.md) for:

- All CLI commands and options
- State file formats and directory structure
- Tmux session naming and agent invocation

## Examples

See [examples.md](examples.md) for complete session examples.

## Version History

- v5.0.0 (2025-02): Align docs with source - fix CLI flags, state file formats, directory structure
- v4.0.0 (2025-02): Use background bash task instead of tmux, remove --dir flag
- v3.0.0 (2025-02): Renamed to kagent-run, added option to start & monitor
- v2.0.0 (2025-01): Restructured per skill best practices
- v1.0.0 (2024-12): Initial implementation
