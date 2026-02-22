---
name: complete-task
description: 'End-to-end task completion from Jira/ClickUp ticket to merged PR. Use when running /complete-task, automating ticket workflow, wanting hands-off task completion, or needing autonomous PR cycles.'
argument-hint: '[TICKET_ID]'
---

# Complete Task - Autonomous Ticket to PR

Takes a Jira or ClickUp ticket and autonomously implements it through to a merged-ready PR. Uses `dev-loop` (kagent-run) for implementation cycles, with CI/review feedback loops handled automatically.

**Key principle:** After user approves the spec, the entire loop runs autonomously. The ONLY exceptions that require user input are:

1. **Conflict** (dev-loop exit 2) — the spec itself is conflicting or ambiguous
2. **Push failure** — never force push, ask user instead

## Glossary

| Term           | Scope            | Description                                                                                                                                          |
| -------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iteration**  | Inner (dev-loop) | One implement→review pass within a single dev-loop run. Controlled by `maxIterations`.                                                               |
| **Push cycle** | Outer (task)     | One complete round: dev-loop run → commit → push → CI/review check. Controlled by `maxPushCycles`.                                                   |
| **Conflict**   | Dev-loop exit 2  | The spec itself contains contradictory or ambiguous requirements, causing reviewers to fail to converge. The spec is the problem, not the reviewers. |

## When to Use

- User runs `/complete-task` with or without a ticket ID
- User wants full ticket-to-PR automation
- User has a Jira (PE-XXXX) or ClickUp (CU-XXXX) ticket to implement

## Prerequisites

- Git repository with remote configured
- `gh` CLI installed and authenticated
- For Jira: `acli` installed and authenticated (`acli jira auth`)
- For ClickUp: ClickUp MCP server configured
- `dev-loop` CLI available
- `tmux` installed

## Architecture

```
Phase 1: Interactive Setup (user interaction)
  1. Auto-detect ticket from branch/worktree/argument
  2. Detect system (Jira PE-XXXX / ClickUp CU-XXXXX)
  3. Fetch ticket details
  4. User selects executor, reviewers, and loop parameters
  5. Ask clarifying questions (last chance for input)
  6. Generate task-spec.md, user approves
  7. Write task-state.json → begin autonomous loop

Phase 2: Autonomous Loop (state machine, no user interaction)
  ┌───────────────────────────────────────────────────────────────────────┐
  │  run_spec → running → pushing → polling → check_result              │
  │     ↑                    ↑                      |                   │
  │     +────────────────────+──────────────────────+                   │
  │     (ci_failed / changes_requested / max_iterations /               │
  │      conversations_blocking / merge_conflict)                       │
  │                                                                     │
  │  Exit conditions:                                                   │
  │    → all_pass: completed                                            │
  │    → no cycles left: failed                                         │
  │    → merge conflict: auto-rebase → retry push (or ask user)         │
  │    → conversations blocking: fix spec from thread details → retry   │
  │    → conflict (exit 2, spec ambiguous): ASK USER → clarify → continue│
  │    → push failure: ASK USER → resolve → continue                    │
  └───────────────────────────────────────────────────────────────────────┘
```

## Workflow

### On Invocation: Check for Existing State

**ALWAYS** check for `.kagent/task-state.json` first:

- If exists → resume from recorded phase (see [Resumability](#resumability))
- If not exists → start fresh with Phase 1

### Phase 1: Interactive Setup

#### Step 1: Auto-Detect Ticket ID

Check in order:

1. Argument passed to `/complete-task PE-1234`
2. Current branch: `git branch --show-current`
3. Worktree: `wt current 2>/dev/null || true`

Match patterns:

- `PE-\d{4}` → Jira (e.g., PE-1234)
- `CU-?[a-zA-Z0-9]+` → ClickUp (e.g., CU-abc123)

If not detected, use `AskUserQuestion` to ask user.

#### Step 2: Fetch Ticket Details

**Jira:** `acli jira workitem view <TICKET_ID> --fields '*all' --json`

**ClickUp:** Use ClickUp MCP server tools

Extract: title, description, acceptance criteria, comments.

#### Step 3: Gather Configuration

Discover available binaries: `compgen -c | grep '^claude' | sort -u`

Use `AskUserQuestion` for:

**Agent selection:**

- Implementer binary (which claude binary implements the code)
- Reviewer binaries (multi-select — which binaries review the code)
- Checkpoint checker binary (which binary analyzes spec conflicts when iterations stall)

**Loop parameters:**

- Max push cycles (default 5) — outer loop: how many push→CI→review→fix rounds
- Max iterations (default 10) — inner loop: how many implement→review passes per dev-loop run
- Conflict check threshold (default 3) — consecutive failed iterations before the conflict checker runs to detect spec conflicts
- Implementer timeout (default 30 min)
- Reviewer timeout (default 15 min)

**Options:**

- Symlink `.kagent` to Obsidian vault? (default: yes) — makes task state visible in Obsidian at `~/Documents/Main/kagent/...`

#### Step 4: Ask Clarifying Questions

Before generating spec, ask any questions about:

- Unclear requirements
- Technical approach preferences
- Scope clarification

**This is the last chance for user input before the autonomous loop.**

#### Step 5: Generate task-spec.md and Get Approval

Create `.kagent/task-spec.md` using [templates/task-spec-template.md](templates/task-spec-template.md) populated with ticket data and clarifications.

**MANDATORY:** Present spec and get user approval via `AskUserQuestion` before proceeding.

#### Step 6: Initialize State and Begin Loop

On approval:

1. Ensure `.kagent` is in `.gitignore` (append if missing — check with `grep -qx '.kagent' .gitignore`)
2. If user opted for Obsidian symlink: create symlink (see [reference.md — Obsidian Symlink](#obsidian-symlink))
3. Write `.kagent/task-state.json` with initial state (phase: `approved`, `obsidianLinked: true/false`)
4. Verify on feature branch (not main/master) — fail if not
5. Transition to autonomous loop

### Phase 2: Autonomous Execution

**After approval, no user interaction except spec conflict (exit 2) and push failures.**

#### Step 7: run_spec — Write Spec for Dev-Loop

**First push cycle (devLoopInitialized is false):**

1. Copy task-spec.md content to `.kagent/spec.md`
2. Run `dev-loop init --implementer <implementer> --reviewers "<reviewer1,reviewer2>" --conflict-checker <conflictChecker> --max-iterations <maxIterations> --implementer-timeout <implementerTimeout> --reviewer-timeout <reviewerTimeout> --conflict-check-threshold <conflictCheckThreshold>`
3. Set `devLoopInitialized: true` in state

**Subsequent push cycles:**

1. Run `dev-loop cancel` to clean up stale tmux sessions and archive previous run
2. Generate fix spec from CI/review feedback (see [Fix Spec Generation](#fix-spec-generation))
3. Write fix spec to `.kagent/spec.md` (overwrites previous)

Update state: `phase: "run_spec"`

#### Step 8: running — Execute Dev-Loop

Run dev-loop as a **background Bash task** and block with TaskOutput:

```bash
dev-loop run 2>&1 | tee .kagent/run.log
```

Use `run_in_background: true` with the Bash tool, then wait with TaskOutput.

Update state: `phase: "running"`

When dev-loop returns, read the exit code and determine next action:

**Exit 0 (completed — all reviewers approved):**

1. Find latest run ID from `.kagent/history/`
2. Store `lastRunId` and `lastRunStatus` in state
3. Proceed to Step 9 (pushing)

**Exit 0 (max_iterations — consensus not reached):**

1. If `pushCycle < maxPushCycles`: Generate fix spec from review feedback → back to Step 7
2. If `pushCycle >= maxPushCycles`: Transition to `failed`

**Exit 1 (error):**

1. Read `.kagent/run.log` for error details
2. Transition to `failed` with error recorded

**Exit 2 (conflict — the spec itself is conflicting or ambiguous):**

This means the conflict checker detected that the spec contains contradictory or ambiguous requirements. Reviewers can't converge because the spec is the problem — it's not a disagreement between reviewers.

1. Read `.kagent/conflict.md` for the conflict checker's analysis (explains which parts of the spec are conflicting and why they're incompatible)
2. Read relevant review files from `.kagent/reviews/{lastRunId}/` for additional context on how the conflict manifests
3. Present to user with **full context** — don't assume the user remembers what the task is about:
   - Remind them of the ticket and what's being implemented
   - Explain the specific spec conflict (quote from conflict.md)
   - Show how the conflict manifests in reviews (quote from review files)
   - Suggest 2-3 concrete ways to clarify/resolve the spec ambiguity
4. Use `AskUserQuestion` with specific options derived from the spec conflict (not generic choices)
5. Store user's answer in `conflictContext`
6. Remove `.kagent/conflict.md` (so dev-loop doesn't see stale conflict state on next run)
7. Generate fix spec incorporating user's clarification → back to Step 7

#### Step 9: pushing — Commit and Push

1. Check commit conventions (see [reference.md](reference.md))
2. Stage specific changed files (never `git add -A`)
3. Create commit with ticket ID following detected convention
4. Push: `git push -u origin HEAD`

**Pre-push safety checks:**

- Verify not on main/master
- **NEVER force push**

**If push fails:**

1. Auto-attempt: `git pull --ff-only origin <branch>` — if fast-forward works, retry push
2. If ff fails, auto-attempt: `git pull --rebase origin <branch>` — if rebase applies cleanly (no conflicts), retry push
3. Only if both fail (merge conflicts or other errors), ask user via `AskUserQuestion`:
   - Options: "Let me resolve the conflicts manually" / "Abort"
   - On abort: transition to `failed`

**After successful push:**

- If no PR exists: Create PR with `gh pr create` using [pr-template.md](templates/pr-template.md)
- If PR exists: push auto-updates it
- Store `prNumber` in state
- Increment `pushCycle`

Update state: `phase: "pushing"`

#### Step 10: polling — Monitor CI and Reviews

Run `dev-loop poll-pr` as a **background Bash task** and block with TaskOutput:

```bash
# Bash tool with run_in_background: true
dev-loop poll-pr <prNumber>
```

This costs zero tokens — it polls `gh` CLI + GraphQL. Wait for it via TaskOutput. See [reference.md](reference.md) for exit codes.

Update state: `phase: "polling"`

#### Step 11: check_result — Evaluate Outcome

Check the poller's exit code:

| Exit Code | Meaning                                                                 | Action                                                                                             |
| --------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0         | Ready to merge (CI pass, reviews OK, no conflicts, conversations clear) | Transition to `completed`                                                                          |
| 1         | CI failed                                                               | Generate fix spec from CI failure logs → Step 7                                                    |
| 2         | Changes requested                                                       | Generate fix spec from review comments → Step 7                                                    |
| 4         | Merge conflict or branch behind                                         | Auto-attempt `git pull --rebase`, then retry push (Step 9). If rebase fails, ask user.             |
| 5         | Unresolved conversations blocking merge                                 | Generate fix spec from thread details (poller outputs JSON with path, line, author, body) → Step 7 |
| 6         | PR is closed or merged                                                  | Transition to `failed` with error                                                                  |

If `pushCycle >= maxPushCycles` on failure: transition to `failed` instead of retrying.

#### Step 12: completed

Report success:

```
Task Complete!
  Ticket: {TICKET_ID}
  PR: #{prNumber} - [{TICKET_ID}] {title}
  Push cycles used: {N}/{MAX}

  To merge: gh pr merge {prNumber}
```

Update state: `phase: "completed"`

#### Step 13: failed

Report failure with actionable details:

```
Max push cycles reached ({N}/{MAX})
  Ticket: {TICKET_ID}
  PR: #{prNumber}

  Remaining issues:
  - {issue 1}

  Please take over manually.
```

Update state: `phase: "failed"`

---

## Fix Spec Generation

When the loop needs to retry, generate a fix spec using [templates/fix-spec-template.md](templates/fix-spec-template.md):

1. Read `.kagent/task-spec.md` for original context
2. Gather feedback from the appropriate source:
   - **CI failures:** `gh pr checks {prNumber}` + `gh run view {runId} --log-failed`
   - **Review comments:** `gh api repos/{owner}/{repo}/pulls/{prNumber}/comments` + `gh pr view --json reviews`
   - **Dev-loop max_iterations:** `.kagent/reviews/{lastRunId}/review-*.md` and `verdict-*.json`
   - **Spec conflict:** `.kagent/conflict.md` + review files + user's clarification from `conflictContext`
3. Write populated fix spec to `.kagent/spec.md`

---

## Resumability

When `/complete-task` is re-invoked with an existing `task-state.json`:

| Phase       | Resume Action                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approved`  | Continue to `run_spec`                                                                                                                                        |
| `run_spec`  | Re-generate spec and start dev-loop                                                                                                                           |
| `running`   | Check for active run: if `.kagent/current/run.json` exists and tmux sessions are alive, offer to wait or cancel. If no active run, read latest history entry. |
| `pushing`   | Check `git log origin/{branch}..HEAD` — if commits to push, retry push; if nothing, transition to polling                                                     |
| `polling`   | Restart `dev-loop poll-pr` with stored `prNumber`                                                                                                             |
| `completed` | Report "Task already completed"                                                                                                                               |
| `failed`    | Report status, offer to retry                                                                                                                                 |

---

## Rules

1. **AUTO-DETECT ticket first** — Only ask if not found
2. **AUTO-DETECT ticket system** — PE=Jira, CU=ClickUp
3. **REQUIRE spec approval** — Before autonomous phase
4. **FULLY AUTONOMOUS after approval** — Only stop for spec conflict (exit 2) or push failure
5. **DELEGATE to dev-loop** — Don't duplicate its implement→review logic
6. **STATE FILE required** — Read/write `.kagent/task-state.json` at every phase transition
7. **TWO SPEC FILES** — task-spec.md (persistent) + spec.md (per-cycle)
8. **ALWAYS check commit conventions** — Look for CONTRIBUTING.md, commitlint
9. **ALWAYS include ticket ID** — In commits, branches, PRs
10. **NEVER push to main/master**
11. **NEVER force push**

## Reference

See [reference.md](reference.md) for state schema, poller exit codes, all CLI commands, and resumability details.

## Examples

See [examples.md](examples.md) for complete session examples.

## Ticket Systems

See [ticket-systems.md](ticket-systems.md) for Jira/ClickUp specifics.

## Version History

- v3.0.0 (2025-02): Rewrite with state machine, `dev-loop poll-pr`, conflict handling, kagent v3 alignment
- v2.0.0 (2025-01): Restructured, delegates to dev-loop
- v1.0.0 (2024-12): Initial implementation
