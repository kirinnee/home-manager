# Complete Task Reference

## State File: `.kagent/task-state.json`

### Schema

The task state is a **superset** of dev-loop's `config.json`. Dev-loop config fields use the same names so they can be extracted directly.

```json
{
  "version": 1,
  "phase": "approved|run_spec|running|pushing|polling|completed|failed",

  "ticketId": "PE-1234",
  "ticketSystem": "jira|clickup",
  "ticketTitle": "Add user auth",
  "ticketBody": "Full ticket description...",
  "branch": "PE-1234-add-auth",
  "prNumber": null,
  "pushCycle": 0,
  "maxPushCycles": 5,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "lastError": null,
  "conflictContext": null,
  "devLoopInitialized": false,
  "obsidianLinked": false,

  "implementer": "claude",
  "reviewers": ["claude-reviewer-zai"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15,
  "conflictCheckThreshold": 3,
  "conflictChecker": "claude"
}
```

### Glossary: Iterations vs Push Cycles

| Term                  | Scope            | Description                                                                                                                                                                                           |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iteration**         | Inner (dev-loop) | One implement→review pass within a single dev-loop run. Controlled by `maxIterations`. Example: dev-loop runs 6 iterations before all reviewers approve.                                              |
| **Push cycle**        | Outer (task)     | One complete round of: dev-loop run → commit → push → CI/review check. Controlled by `maxPushCycles`. Example: first push has CI failure, fix spec written, second push passes. That's 2 push cycles. |
| **Failure iteration** | Inner (dev-loop) | Consecutive iterations where reviewers reject. After `conflictCheckThreshold` consecutive failures, the conflict checker runs to determine if the spec itself is conflicting.                         |

### Field Descriptions

**Task-level fields:**

| Field                | Type         | Description                                                       |
| -------------------- | ------------ | ----------------------------------------------------------------- |
| `version`            | number       | Schema version (always 1)                                         |
| `phase`              | string       | Current state machine phase                                       |
| `ticketId`           | string       | Ticket identifier (e.g., PE-1234, CU-abc123)                      |
| `ticketSystem`       | string       | `jira` or `clickup`                                               |
| `ticketTitle`        | string       | Ticket title                                                      |
| `ticketBody`         | string       | Full ticket description                                           |
| `branch`             | string       | Git branch name                                                   |
| `prNumber`           | number\|null | GitHub PR number (null before first push)                         |
| `pushCycle`          | number       | Current push cycle (0-indexed, incremented after each push)       |
| `maxPushCycles`      | number       | Max push cycles — outer loop limit                                |
| `lastRunId`          | string\|null | Most recent dev-loop run ID (from `.kagent/history/`)             |
| `lastRunExitCode`    | number\|null | Exit code from last `dev-loop run`                                |
| `lastRunStatus`      | string\|null | Status from last run: completed, max_iterations, conflict, failed |
| `lastError`          | string\|null | Error message if in failed state                                  |
| `conflictContext`    | string\|null | User's clarification for a spec conflict (used in fix spec)       |
| `devLoopInitialized` | boolean      | Whether `dev-loop init` has been run                              |
| `obsidianLinked`     | boolean      | Whether `.kagent` is symlinked to Obsidian vault                  |

**Dev-loop config fields** (same names as `.kagent/config.json`):

| Field                    | Type     | Description                                                    |
| ------------------------ | -------- | -------------------------------------------------------------- |
| `implementer`            | string   | Implementer binary name                                        |
| `reviewers`              | string[] | Reviewer binary names                                          |
| `maxIterations`          | number   | Max iterations per dev-loop run — inner loop limit             |
| `implementerTimeout`     | number   | Implementer timeout in minutes                                 |
| `reviewerTimeout`        | number   | Reviewer timeout in minutes                                    |
| `conflictCheckThreshold` | number   | Consecutive failed iterations before conflict checker triggers |
| `conflictChecker`        | string   | Binary that analyzes spec conflicts when iterations stall      |

---

## State Machine Transitions

```
approved ──→ run_spec ──→ running ──→ pushing ──→ polling ──→ completed
               ↑                |        |           |
               │                |        |           ↓
               │                |        |       (check result)
               │                |        |           |
               │                ↓        ↓           |
               │             failed   (ask user     |
               │               ↑       on fail)     |
               │               |                     |
               +───────────────+─────────────────────+
                (ci_failed / changes_requested /
                 max_iterations / spec conflict resolved)
```

### Transition Table

| From       | To          | Condition                                                                 |
| ---------- | ----------- | ------------------------------------------------------------------------- |
| `approved` | `run_spec`  | Begin autonomous loop                                                     |
| `run_spec` | `running`   | Spec written to `.kagent/spec.md`, `dev-loop run` started                 |
| `running`  | `pushing`   | dev-loop exit 0, status `completed` (all approved) → create commit        |
| `running`  | `run_spec`  | dev-loop exit 0, status `max_iterations` AND `pushCycle < maxPushCycles`  |
| `running`  | `run_spec`  | dev-loop exit 2 (spec conflict) → user clarified → incorporate answer     |
| `running`  | `failed`    | dev-loop exit 1 (error)                                                   |
| `running`  | `failed`    | dev-loop exit 0, status `max_iterations` AND `pushCycle >= maxPushCycles` |
| `pushing`  | `polling`   | Push succeeds, PR created/updated                                         |
| `pushing`  | `pushing`   | Push fails → ask user → user resolves → retry                             |
| `pushing`  | `failed`    | Push fails → user chooses abort                                           |
| `polling`  | `completed` | Ready to merge (CI pass, reviews OK, no conflicts, conversations clear)   |
| `polling`  | `run_spec`  | CI failed AND `pushCycle < maxPushCycles`                                 |
| `polling`  | `run_spec`  | Changes requested AND `pushCycle < maxPushCycles`                         |
| `polling`  | `run_spec`  | Unresolved conversations blocking merge AND `pushCycle < maxPushCycles`   |
| `polling`  | `pushing`   | Merge conflict or branch behind → auto-rebase → retry push                |
| `polling`  | `failed`    | Issues remain AND `pushCycle >= maxPushCycles`                            |

---

## Dev-Loop Integration

### First Cycle

```bash
# Initialize dev-loop with all parameters
dev-loop init \
  --implementer <implementer> \
  --reviewers "<reviewer1,reviewer2>" \
  --conflict-checker <conflictChecker> \
  --max-iterations <maxIterations> \
  --implementer-timeout <implementerTimeout> \
  --reviewer-timeout <reviewerTimeout> \
  --conflict-check-threshold <conflictCheckThreshold>

# Write spec (generated from task-spec.md)
# → .kagent/spec.md

# Run the loop (background task, block with TaskOutput)
dev-loop run 2>&1 | tee .kagent/run.log
```

### Subsequent Cycles

```bash
# Cancel previous run (cleans up stale tmux sessions, archives previous run)
dev-loop cancel

# Update spec with fix spec
# Overwrite .kagent/spec.md

# Run again
dev-loop run 2>&1 | tee .kagent/run.log
```

**Important:** Always run `dev-loop cancel` before starting a new run. This kills any leftover tmux sessions from the previous run and archives its state cleanly.

### Exit Codes

| Exit Code | Meaning                                                                          | Action                                                                                                               |
| --------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0         | Success or max iterations reached                                                | Check `.kagent/history/` for status: `completed` (all reviewers approved) or `max_iterations` (inner loop exhausted) |
| 1         | Error (tmux missing, config error, runtime failure)                              | Transition to `failed`                                                                                               |
| 2         | Spec conflict (conflict checker found contradictory/ambiguous spec requirements) | Read `.kagent/conflict.md`, present to user for clarification, generate fix spec                                     |

### Reading Results After Run

After dev-loop exits, the `current/` directory has been archived. Read results from:

- **Run status**: Find latest file in `.kagent/history/` → check `status` field
- **Review feedback**: `.kagent/reviews/{runId}/review-{iter}-{idx}-{binary}.md`
- **Verdict details**: `.kagent/reviews/{runId}/verdict-{iter}-{idx}-{binary}.json`
- **Run logs**: `.kagent/logs/{runId}/impl-{iter}.log`, `.kagent/logs/{runId}/rev-{iter}-{idx}.log`

### Determining Last Run ID

```bash
# List history files, sorted by modification time (newest first)
ls -t .kagent/history/ | head -1
# Returns something like: a1b2c3d4.json
# The run ID is the filename without extension
```

---

## CI/Review Poller

Command: `dev-loop poll-pr` — polls `gh` CLI + GitHub GraphQL API for CI, reviews, merge conflicts, and unresolved conversations. Costs zero tokens.

### Usage

```bash
# Run as background Bash task, block with TaskOutput
dev-loop poll-pr <pr-number> [--interval <seconds>] [--repo owner/repo]
```

Default poll interval is 60 seconds. The `--repo` flag is only needed for PRs in a different repo than the current directory.

### Exit Codes

| Exit Code | Meaning                                                                    | stdout Contains                                                            |
| --------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0         | Ready to merge (CI pass, reviews OK, no conflicts, conversations resolved) | `STATUS:all_pass` + check details + `MERGE_STATE`                          |
| 1         | At least one CI check failed                                               | `STATUS:ci_failed` + check details                                         |
| 2         | Reviewer requested changes                                                 | `STATUS:changes_requested` + review JSON                                   |
| 3         | Usage error or `gh` CLI not found                                          | Error message                                                              |
| 4         | Merge conflict or branch behind base (needs rebase)                        | `STATUS:merge_conflict` or `STATUS:behind`                                 |
| 5         | Unresolved conversations blocking merge, or blocked for other reason       | `STATUS:conversations_blocking` + thread details JSON, or `STATUS:blocked` |
| 6         | PR is closed or already merged                                             | `STATUS:closed` or `STATUS:merged`                                         |

### Behavior

- Uses `gh pr checks` for CI status and GitHub GraphQL API for merge state, reviews, and review threads (single query)
- Polls every 60 seconds (configurable via second argument)
- Retries on `gh` command failures (network issues, rate limits)
- Waits for all CI checks to finish before declaring failure (avoids false positives from pending checks)
- Waits for `mergeable` to be computed (retries on `UNKNOWN`)
- Checks merge state (`mergeStateStatus`) to determine if conversations or other branch protection rules are blocking
- Outputs unresolved thread details (path, line, author, body) as JSON when conversations block
- Runs indefinitely until a terminal state is reached

---

## Fix Spec Generation

### Data Sources

| Feedback Type              | How to Get                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CI failure details         | `gh pr checks {prNumber}` for failed check names; `gh run view {runId} --log-failed` for error output                                                                                                                    |
| Review comments            | `gh api repos/{owner}/{repo}/pulls/{prNumber}/comments` for inline comments                                                                                                                                              |
| Top-level reviews          | `gh pr view {prNumber} --json reviews` for review bodies                                                                                                                                                                 |
| Unresolved conversations   | Poller output (exit 5) includes thread details JSON with `path`, `line`, `author`, `body` for each unresolved thread. After addressing, comment `@coderabbitai` on the PR to trigger re-review and auto-resolve threads. |
| Dev-loop reviewer feedback | `.kagent/reviews/{lastRunId}/review-*-*.md`                                                                                                                                                                              |
| Dev-loop verdicts          | `.kagent/reviews/{lastRunId}/verdict-*-*.json` (has `reasoning` field)                                                                                                                                                   |
| Spec conflict analysis     | `.kagent/conflict.md` (conflict checker's analysis of which spec requirements are contradictory)                                                                                                                         |
| Spec conflict context      | `.kagent/reviews/{lastRunId}/review-*-*.md` (how the ambiguity manifests) + user's clarification in `conflictContext`                                                                                                    |

### Generation Steps

1. Read `.kagent/task-spec.md` for original context
2. Gather feedback from the appropriate source (CI, reviews, or dev-loop)
3. Populate the [fix-spec template](templates/fix-spec-template.md)
4. Write to `.kagent/spec.md` (overwriting the previous run-level spec)

Note: `pushCycle` is incremented in Step 9 (pushing) after a successful push — not here.

### For CI Failures

```bash
# Get failed check names
gh pr checks {prNumber}

# Get the run ID of the failed workflow
gh run list --branch {branch} --status failure --limit 1 --json databaseId -q '.[0].databaseId'

# Get failure logs
gh run view {runId} --log-failed
```

### For Review Comments

```bash
# Get inline comments
gh api repos/{owner}/{repo}/pulls/{prNumber}/comments

# Get top-level reviews
gh pr view {prNumber} --json reviews
```

---

## Resumability Protocol

When `/complete-task` is invoked, ALWAYS check for `.kagent/task-state.json` first:

- **File exists** → Read it and resume from recorded phase
- **File does not exist** → Start fresh (Phase 1: Interactive Setup)

### Phase-by-Phase Resume

| Phase       | Resume Action                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approved`  | Transition to `run_spec` and continue                                                                                                                                                                                                                              |
| `run_spec`  | Re-generate spec and start `dev-loop run`                                                                                                                                                                                                                          |
| `running`   | Check `.kagent/current/run.json` for active run. If exists with status `running`, check for tmux sessions (`tmux ls 2>/dev/null \| grep devloop`). If active, inform user and offer to wait or cancel. If no active run, read latest history entry for the result. |
| `pushing`   | Check `git log origin/{branch}..HEAD`. If unpushed commits exist, retry push. If nothing to push, the push already succeeded — transition to `polling`.                                                                                                            |
| `polling`   | Restart `dev-loop poll-pr` with stored `prNumber`                                                                                                                                                                                                                  |
| `completed` | Report "Task already completed" with PR details                                                                                                                                                                                                                    |
| `failed`    | Report "Task previously failed" with details. Offer to retry.                                                                                                                                                                                                      |

---

## Git Commands

### Check Current Branch

```bash
git branch --show-current
```

### Check Worktree

```bash
wt current 2>/dev/null || true
```

### Stage Changes

```bash
# Stage specific files (preferred - avoid git add -A)
git add src/feature.ts src/feature.test.ts
```

### Create Commit

```bash
git commit -m "$(cat <<'EOF'
type(scope): description

[TICKET_ID]

- Detail 1
- Detail 2
EOF
)"
```

### Push with Upstream

```bash
git push -u origin HEAD
```

### Check for Existing PR

```bash
gh pr list --head "$(git branch --show-current)" --json number -q '.[0].number'
```

### Create PR

```bash
gh pr create --title "[TICKET_ID] Title" --body "$(cat <<'EOF'
{PR body from pr-template.md}
EOF
)"
```

---

## Commit Convention Detection

### Files to Check

```bash
ls CONTRIBUTING.md COMMIT_CONVENTION.md \
   .commitlintrc* commitlint.config.* \
   .conventional-commit* .czrc .cz.json 2>/dev/null || true
```

### Check Recent History

```bash
git log --oneline -10
```

### Default Format (if no convention found)

```
feat(scope): description

[TICKET-ID]

- Detail 1
- Detail 2
```

---

## Ticket ID Patterns

| System  | Pattern            | Example   |
| ------- | ------------------ | --------- |
| Jira    | `PE-\d{4}`         | PE-1234   |
| ClickUp | `CU-?[a-zA-Z0-9]+` | CU-abc123 |

---

## Jira Commands (acli)

```bash
# Basic view
acli jira workitem view PE-1234 --json

# All fields
acli jira workitem view PE-1234 --fields '*all' --json

# Auth setup (one-time)
acli jira auth
```

---

## ClickUp (MCP)

Use the ClickUp MCP server tools. If not configured:

```
ClickUp MCP server is not configured. Please set up the official
ClickUp MCP server in your Claude settings.
```

---

## Obsidian Symlink

Optionally symlink `.kagent` into the Obsidian vault so task state is visible in Obsidian. The path is derived from the current working directory by stripping the `~/Workspace/` prefix.

### Setup (Step 6, if user opted in)

```bash
PROJECT_DIR=$(pwd)
REL_PATH="${PROJECT_DIR#$HOME/Workspace/}"
OBSIDIAN_TARGET="$HOME/Documents/Main/kagent/$REL_PATH"
mkdir -p "$OBSIDIAN_TARGET"
# Move existing .kagent contents if any
[ -d ".kagent" ] && [ ! -L ".kagent" ] && cp -a .kagent/. "$OBSIDIAN_TARGET/" && rm -rf .kagent
# Create symlink
[ ! -L ".kagent" ] && ln -s "$OBSIDIAN_TARGET" .kagent
```

After symlinking, set `obsidianLinked: true` in `task-state.json`.

### Teardown (close-task)

```bash
# Read symlink target before removing
OBSIDIAN_TARGET=$(readlink .kagent)
rm .kagent
rm -rf "$OBSIDIAN_TARGET"
```

This removes both the symlink and the Obsidian target directory to keep the vault clean.

---

## Status Report Formats

### During Dev-Loop

```
Dev-loop running (push cycle {N}/{MAX})
  Spec: .kagent/spec.md
  Logs: .kagent/run.log
```

### Polling

```
Polling CI/reviews for PR #{prNumber} (push cycle {N}/{MAX})
  CI: {pending|passing|failing}
  Reviews: {pending|approved|changes_requested}
```

### Success

```
Task Complete!
  Ticket: {TICKET_ID}
  PR: #{prNumber} - [{TICKET_ID}] {title}
  Status: Ready to merge
  Push cycles used: {N}/{MAX}

  To merge: gh pr merge {prNumber}
```

### Failure (Max Cycles)

```
Max push cycles reached ({N}/{N})
  Ticket: {TICKET_ID}
  PR: #{prNumber}

  Remaining issues:
  - {issue 1}
  - {issue 2}

  Please take over manually.
```

### Spec Conflict (Exit 2)

Exit 2 means the **spec itself is conflicting or ambiguous** — it contains requirements that are contradictory or can be interpreted in incompatible ways. The conflict checker detected this after `conflictCheckThreshold` consecutive failed iterations. The spec is the problem, not the reviewers.

When presenting a conflict, provide full context. The user may not remember what this task is about.

```
The spec contains conflicting or ambiguous requirements.

Task context:
  Ticket: {TICKET_ID} - {TICKET_TITLE}
  You're implementing: {brief objective from task-spec.md}

Spec conflict (from .kagent/conflict.md):
  {conflict checker's analysis — which parts of the spec conflict and why}

How this manifests in reviews:
  Reviewer 1 ({binary}): "{quote showing how they interpreted the ambiguity}"
  Reviewer 2 ({binary}): "{quote showing the opposite interpretation}"

The spec needs clarification. Suggested resolutions:
  1. {Concrete way to resolve the ambiguity — option A}
  2. {Concrete way to resolve the ambiguity — option B}
  3. {Middle ground if applicable}
```

**Key rules for conflict presentation:**

- Always read `.kagent/conflict.md` first — it has the conflict checker's structured analysis
- Frame the issue as a **spec problem**, not a reviewer disagreement
- Quote actual text from conflict.md and review files, don't paraphrase
- Suggest specific ways to **clarify the spec** (not "pick which reviewer is right")
- Include enough task context that the user can make a decision without re-reading the ticket
