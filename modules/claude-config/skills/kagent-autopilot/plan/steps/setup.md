# Plan Step: Setup — Team Agent (Haiku)

## Agent Context

- Working directory: {WORKDIR}
- Raw argument: {rawArgument}

## Agent Report Format

```
RESULT: <completed|error>
MODE: <autopilot>
BRANCH: <branch name>
ERROR: <error message if any>
```

## Task

Bootstrap the kagent-autopilot session: detect mode, set up branch, configure .gitignore, and create initial state files.

## Step 1: Ensure .kagent Directory

```bash
mkdir -p .kagent
```

## Step 2: Configure .gitignore

Ensure `.kagent/` is gitignored:

```bash
grep -q '^\.kagent/' .gitignore 2>/dev/null || echo '.kagent/' >> .gitignore
```

## Step 3: Branch Setup

Check current branch:

```bash
git branch --show-current
```

If on main/master, create a feature branch:

```bash
git checkout -b feature/{ticketId or descriptive-name}
```

If already on a feature branch, use it as-is.

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
  "implementer": "claude-impl-zai",
  "reviewers": ["claude-reviewer-zai", "claude-reviewer-codex", "claude-reviewer-anthropic"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15,
  "conflictCheckThreshold": 3,
  "conflictChecker": "claude",
  "maxPushCycles": 5
}
```

If `--phase impl` or `--phase polish`, set `currentPhase` accordingly.

## Step 6: Create plan-state.json

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
