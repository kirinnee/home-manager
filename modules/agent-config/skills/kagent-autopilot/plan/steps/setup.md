# Plan Step: Setup — Team Agent (Haiku)

## Agent Context

- Working directory: {WORKDIR}
- Raw argument: {rawArgument}

## Agent Report Format

```
RESULT: <completed|error>
MODE: <autopilot>
BRANCH: <branch name>
WORKDIR: <absolute worktree path for subsequent steps>
ERROR: <error message if any>
```

## Task

Bootstrap the kagent-autopilot session: detect mode, set up the task worktree/branch, configure .gitignore, and create initial state files.

## Step 1: Worktree and Branch Setup

Determine the current branch:

```bash
git branch --show-current
```

Determine the current repository root:

```bash
git rev-parse --show-toplevel
```

If already on a feature/task branch, use the current worktree as-is.

If on `main` or `master`, derive the target branch from `rawArgument` when it contains a ticket ID, otherwise use a concise descriptive task name. Then create/switch through worktrunk. Do not use `git checkout -b`; it creates a branch in-place and bypasses worktrunk's path template and hooks.

```bash
wt switch --create "{ticketId or descriptive-name}" --no-cd
```

After worktrunk creates/switches the worktree, resolve the actual worktree path for the branch:

```bash
git worktree list --porcelain | awk -v branch="refs/heads/{ticketId or descriptive-name}" '
  /^worktree / { wt = substr($0, 10) }
  /^branch / && $2 == branch { print wt; exit }
'
```

Use that resolved path as `session_workdir` for every remaining setup command and report it as `WORKDIR`. If worktrunk reports the branch already exists, run `wt switch "{ticketId or descriptive-name}" --no-cd`, then resolve `session_workdir` the same way.

## Step 2: Ensure .kagent Directory

```bash
mkdir -p "$session_workdir/.kagent"
```

## Step 3: Configure .gitignore

Ensure `.kagent/` is gitignored in the session worktree:

```bash
grep -q '^\.kagent/' "$session_workdir/.gitignore" 2>/dev/null || echo '.kagent/' >> "$session_workdir/.gitignore"
```

Confirm the final branch from the session worktree:

```bash
git -C "$session_workdir" branch --show-current
```

## Step 4: Parse Argument

Parse `rawArgument` to determine starting phase:

| Argument                    | Behavior                                            |
| --------------------------- | --------------------------------------------------- |
| `null` or empty             | Start from Phase 1 (plan)                           |
| Ticket ID (e.g., `PE-1234`) | Start from Phase 1 with ticket hint                 |
| `--phase impl`              | Start from Phase 2 (skip planning)                  |
| `--phase polish`            | Start from Phase 3 (skip planning + implementation) |

## Step 5: Create task-state.json (Bootstrap)

**This is the only step that creates task-state.json directly (bootstrap exception).**
Write this file to `$session_workdir/.kagent/task-state.json`.

```json
{
  "version": 1,
  "currentPhase": "plan",
  "rawArgument": "{rawArgument}",
  "ticketId": null,
  "ticketTitle": null,
  "ticketBody": null,
  "ticketStatus": null,
  "branch": "{detected branch}",
  "prNumber": null,
  "specVersion": 1,
  "specDir": null,
  "repoConfig": {},
  "teamName": null,
  "subPlans": [],
  "currentSubPlanIndex": 0,
  "implementer": "claude-auto-zai",
  "implementers": "claude-auto-zai:2,claude-auto-mm:1",
  "reviewPhases": "claude-auto-zai:1,claude-auto-mm:1,claude-auto-seed:0|claude-auto-zai:1,claude-auto-anthropic:1,claude-auto-gemini:0|claude-auto-codex:1,claude-auto-kimi:0",
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15,
  "conflictCheckThreshold": 3,
  "conflictChecker": "claude-auto-zai",
  "firstLoopFullReview": true,
  "previousReviewPropagation": 0.75,
  "maxPushCycles": 5
}
```

If `--phase impl` or `--phase polish`, set `currentPhase` accordingly.

## Step 6: Create plan-state.json

Write this file to `$session_workdir/.kagent/plan-state.json`.

```json
{
  "step": "setup",
  "setupComplete": false,
  "repoSetupComplete": false,
  "specWritten": false,
  "plansWritten": false
}
```

After all steps complete, update `plan-state.json`:

- `step: "repo_setup"`
- `setupComplete: true`

## Important

- This step creates `task-state.json` directly (bootstrap exception)
- Do NOT modify code files
- Do NOT commit anything (orchestrator handles commits)
