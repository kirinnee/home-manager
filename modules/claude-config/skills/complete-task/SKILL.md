---
name: complete-task
description: 'End-to-end task completion from Jira/ClickUp ticket to merged PR. Use when running /complete-task, automating ticket workflow, wanting hands-off task completion, or needing autonomous PR cycles.'
argument-hint: '[TICKET_ID]'
---

# Complete Task - End-to-End Ticket to PR Automation

Automates the entire workflow from fetching a ticket to getting a PR merged. Uses `dev-loop` internally for implementation and handles git, PR creation, CI monitoring, and review feedback loops.

**Key principle:** After user approves the spec, the entire loop runs autonomously. The ONLY exception is push failures - never force push, ask user instead.

## When to Use

- User runs `/complete-task` with a ticket ID
- User wants full ticket-to-PR automation
- User has a Jira (PE-XXXX) or ClickUp (CU-XXXX) ticket to implement
- User wants hands-off development with CI/review feedback loops

## Prerequisites

- Git repository with remote configured
- `gh` CLI installed and authenticated
- For Jira: `acli` installed and authenticated (`acli jira auth`)
- For ClickUp: ClickUp MCP server configured
- `dev-loop` command available (see dev-loop skill)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Interactive Setup                                   │
│   1. Auto-detect ticket from branch/worktree                │
│   2. Detect system (Jira/ClickUp) from format               │
│   3. User selects executor, reviewers, max push cycles      │
│   4. Fetch ticket details                                   │
│   5. Ask clarifying questions                               │
│   6. Generate and approve spec                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Autonomous Loop (NO user interaction)              │
│                                                             │
│   for each push cycle:                                      │
│     1. Run dev-loop (delegate to dev-loop skill)            │
│     2. Create commit (check conventions, include ticket)    │
│     3. Push branch (NEVER main, NEVER force)                │
│        ⚠️ Push fail → ASK USER (only intervention)          │
│     4. Create/update PR                                     │
│     5. Poll CI and reviews                                  │
│     6. If failures → generate fix spec → repeat             │
│     7. If all pass → done                                   │
└─────────────────────────────────────────────────────────────┘
```

## Workflow

### Phase 1: Interactive Setup

#### Step 1: Auto-Detect Ticket ID

Check branch name and worktree:

```bash
git branch --show-current
wt current 2>/dev/null || true
```

**Patterns:**

- `PE-\d{4}` → Jira (e.g., PE-1234)
- `CU-?[a-z0-9]+` → ClickUp (e.g., CU-abc123)

If not detected, use `AskUserQuestion` to ask user.

#### Step 2: Fetch Ticket Details

**Jira:** Use `acli jira workitem view <TICKET_ID> --fields '*all' --json`

**ClickUp:** Use ClickUp MCP server tools

Extract: title, description, acceptance criteria, comments.

#### Step 3: Gather Dev-Loop Defaults

Use `AskUserQuestion` for:

- Executor binary (which claude-\* to use)
- Reviewer binaries (multi-select)
- Max push cycles (3/5/10)

#### Step 4: Ask Clarifying Questions

Before generating spec, ask any questions needed:

- Unclear requirements
- Technical approach preferences
- Scope clarification

**This is the last chance for user input.**

#### Step 5: Generate and Approve Spec

Create `.claude/dev-loop/spec.md` with ticket details. Use template from [templates/spec-template.md](templates/spec-template.md).

**MANDATORY:** Get user approval before autonomous phase.

### Phase 2: Autonomous Execution

**After approval, no user interaction except push failures.**

#### Step 6: Run Dev-Loop

Delegate to the dev-loop skill:

```bash
dev-loop init --claude <executor> --reviewers "<reviewers>"
# Copy spec to .claude/dev-loop/spec.md
# Start in tmux and poll
```

#### Step 7: Create Commit

1. Check for commit conventions (see [reference.md](reference.md))
2. Stage specific files (avoid sensitive files)
3. Create commit with ticket ID

#### Step 8: Push Branch

- **NEVER push to main/master** - create feature branch
- **NEVER force push** - if fails, ask user

#### Step 9: Create/Update PR

Use `gh pr create` or `gh pr edit`. Include ticket link.

#### Step 10: Poll CI and Reviews

Every 5 minutes check `gh pr checks` and `gh pr view --json reviews`.

If failures or comments → generate fix spec → run dev-loop again.

#### Step 11: Complete or Max Cycles

**Success:** All CI pass, reviews approved → report and exit

**Max cycles:** Report remaining issues → user takes over

## Rules

1. **AUTO-DETECT ticket first** - Only ask if not found
2. **AUTO-DETECT ticket system** - PE=Jira, CU=ClickUp
3. **REQUIRE spec approval** - Before autonomous phase
4. **AUTONOMOUS after approval** - No interaction except push fail
5. **DELEGATE to dev-loop** - Don't duplicate its logic
6. **ALWAYS check commit conventions** - Look for CONTRIBUTING.md, commitlint
7. **ALWAYS include ticket ID** - In commits, branches, PRs
8. **NEVER push to main/master**
9. **NEVER force push**
10. **RESPECT max push cycles**

## How to Verify

1. Ticket details fetched correctly
2. Spec includes all acceptance criteria
3. Dev-loop running in tmux
4. PR created with ticket link
5. CI checks visible in `gh pr checks`

## Reference

See [reference.md](reference.md) for:

- All CLI commands (acli, gh, git)
- Commit convention detection
- PR template format

## Examples

See [examples.md](examples.md) for complete session examples.

## Ticket Systems

See [ticket-systems.md](ticket-systems.md) for Jira/ClickUp specifics.

## Version History

- v2.0.0 (2025-01): Restructured, delegates to dev-loop
- v1.0.0 (2024-12): Initial implementation
