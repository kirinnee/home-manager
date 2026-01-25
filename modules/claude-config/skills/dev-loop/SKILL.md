---
name: dev-loop
description: 'Start a spec-driven development loop with automated review cycles'
argument-hint: 'TASK_DESCRIPTION'
---

# Dev Loop - Spec-Driven Development with Multi-Reviewer Consensus

This skill starts an iterative development loop where you implement based on a spec, and multiple configurable reviewers evaluate your work. ALL reviewers must approve for the loop to complete.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Interactive Setup (this session)                   │
│                                                             │
│   1. Discover available claude-* binaries                   │
│   2. User selects executor (implementer)                    │
│   3. User selects reviewers (multi-select)                  │
│   4. Claude helps write spec                                │
│   5. User approves spec                                     │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Run Orchestrator (background)                      │
│                                                             │
│   dev-loop run &                                            │
│                                                             │
│   for each iteration:                                       │
│     executor --print "implement..."  (fresh context)        │
│     reviewers run IN PARALLEL:                              │
│       reviewer1 --print "review..." &                       │
│       reviewer2 --print "review..." &                       │
│       wait                                                  │
│                                                             │
│   Until: ALL reviewers approve OR max loops reached         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Poll Status (every 30 minutes)                     │
│                                                             │
│   while status == "running":                                │
│     sleep 30m                                               │
│     dev-loop status                                         │
│     report to user                                          │
└─────────────────────────────────────────────────────────────┘
```

## Workflow

### Step 1: Discover Claude Binaries

Run this command to find available claude binaries:

```bash
compgen -c | grep '^claude' | sort -u
```

This will list binaries like:

- `claude` (default)
- `claude-personal`
- `claude-liftoff`
- `claude-reviewer-anthropic`
- `claude-reviewer-gemini`
- `claude-reviewer-codex`

### Step 2: Ask User to Select Executor

Use `AskUserQuestion` to ask which binary to use for implementation:

- Header: "Executor"
- Question: "Which claude binary should implement the code?"
- Options: List discovered binaries (max 4, prioritize non-reviewer ones)
- Single select

### Step 3: Ask User to Select Reviewers

Use `AskUserQuestion` with `multiSelect: true`:

- Header: "Reviewers"
- Question: "Which claude binaries should review the code? (select multiple)"
- Options: List discovered binaries (prioritize reviewer-\* ones)
- Multi select enabled

### Step 4: Initialize Dev Loop

```bash
DEV_LOOP_CLAUDE=<selected-executor> dev-loop init --reviewers "<selected-reviewers>"
```

### Step 5: Write Spec

Edit `.claude/dev-loop/spec.md` based on user's task description:

```markdown
# Specification: [Title]

## Objective

[Clear, concise description of what to build]

## Acceptance Criteria

- [ ] Criterion 1 (specific, measurable)
- [ ] Criterion 2
- [ ] Criterion 3

## Definition of Done

- [ ] All acceptance criteria met
- [ ] Tests pass (if applicable)
- [ ] No lint/type errors (if applicable)

## Out of Scope

- [What this task does NOT include]

## Technical Constraints

- [Any specific requirements or limitations]
```

### Step 6: User Approval

**MANDATORY: Ask user to approve using AskUserQuestion.**

- Present the spec content
- Show selected executor and reviewers
- Ask: "Does this spec look correct?"
- Options: "Approve and start loop" / "Edit spec first"
- **DO NOT proceed until user explicitly approves**

### Step 7: Start Loop in Background

**Only after approval**, run in background using the Bash tool with `run_in_background: true`:

```bash
DEV_LOOP_CLAUDE=<selected-executor> dev-loop run
```

**IMPORTANT**: Use `run_in_background: true` to prevent timeout. The dev-loop can run for hours.

### Step 8: Poll Status Every 30 Minutes

After starting the background task, enter a polling loop:

1. Wait 30 minutes (use `sleep 1800` or similar)
2. Run `dev-loop status` to check progress
3. Report status to user
4. If status is "running", continue polling
5. If status is "completed" or "max_loops_reached", stop polling and inform user

**NEVER let the dev-loop timeout.** Keep polling until it completes.

## Commands

```bash
dev-loop init [--max-loops N] [--reviewers "cmd1,cmd2"]
dev-loop run
dev-loop status
dev-loop cancel
```

## Environment Variables

- `DEV_LOOP_CLAUDE` - Executor binary (default: `claude`)
- `DEV_LOOP_REVIEWERS` - Comma-separated reviewer binaries

## Rules

1. **ALWAYS discover binaries first** - Run `compgen -c | grep '^claude'`
2. **ALWAYS ask user to select** - Never assume which binaries to use
3. **NEVER modify `spec.md`** after user approval
4. **NEVER commit** - leave that to the user
5. **ALL reviewers must approve** - consensus is required
6. **NEVER let it timeout** - run in background and poll status
7. **Reviewers run in parallel** - faster feedback cycles

## Example Session

```
User: /dev-loop "Add user authentication with JWT"

Claude: Let me find available claude binaries...
        [runs: compgen -c | grep '^claude' | sort -u]

        Found: claude, claude-personal, claude-reviewer-anthropic,
               claude-reviewer-gemini, claude-reviewer-codex

        [AskUserQuestion: Which binary should implement?]

User: claude-personal

Claude: [AskUserQuestion: Which binaries should review? (multi-select)]

User: claude-reviewer-anthropic, claude-reviewer-gemini

Claude: Setting up dev-loop with:
        - Executor: claude-personal
        - Reviewers: claude-reviewer-anthropic, claude-reviewer-gemini (parallel)

        [runs: DEV_LOOP_CLAUDE=claude-personal dev-loop init --reviewers "claude-reviewer-anthropic,claude-reviewer-gemini"]
        [edits spec.md based on task]

        Here's the spec:
        [shows spec content]

        [AskUserQuestion: Approve spec?]

User: Yes, start the loop

Claude: Starting dev-loop in background...
        [runs with run_in_background: true]

        I'll poll status every 30 minutes. Current status:
        [runs: dev-loop status]

        🔄 Status: running
        🔢 Iteration: 1 / 40

        [waits 30 minutes, polls again...]

        🔄 Status: completed
        🎉 All reviewers approved! Dev loop finished successfully.
```
