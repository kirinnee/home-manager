# Phase: Generic Setup — Team Member

**Agent Mode:** Spawned as setup-agent (haiku). Creates the initial state file.

## Agent Context (when spawned)

- Working directory: {WORKDIR}
- Argument: {ARGUMENT} (raw argument from `/kagent-autopilot`)

## Agent Report Format

```
RESULT: created
MODE: <autopilot|manual>
BRANCH: <branch name>
```

## Step 1: Detect Mode

Check the argument passed to `/kagent-autopilot`:

1. If argument is `manual` → **Manual mode**
2. Otherwise (no argument, ticket ID, or any other value) → **Autopilot mode**

Store raw argument as `rawArgument` (passed to repo-setup for interpretation).

## Step 2: Detect Branch

Assume user is already on the correct branch:

```bash
git branch --show-current
```

Store as `branch`.

## Step 3: Add .kagent/ to .gitignore

```bash
grep -qx '.kagent' .gitignore 2>/dev/null || grep -qx '.kagent/' .gitignore 2>/dev/null || echo '.kagent/' >> .gitignore
```

## Step 4: Create Initial State

Write `.kagent/task-state.json`:

```json
{
  "version": 1,
  "phase": "repo_setup",
  "mode": "<autopilot|manual>",
  "rawArgument": "<argument or null>",
  "branch": "<current branch>",
  "ticketId": null,
  "ticketTitle": null,
  "ticketBody": null,
  "ticketStatus": null,
  "prNumber": null,
  "specVersion": null,
  "specDir": null,
  "pushCycle": 0,
  "maxPushCycles": 5,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "lastError": null,
  "conflictContext": null,
  "devLoopInitialized": false,
  "subPlans": [],
  "currentSubPlanIndex": 0,
  "implementer": "claude-impl-zai",
  "reviewers": ["claude-reviewer-zai", "claude-reviewer-codex", "claude-reviewer-anthropic"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15,
  "conflictCheckThreshold": 3,
  "conflictChecker": "claude",
  "repoConfig": {},
  "teamName": null
}
```

**Notes:**

- `phase` starts as `"repo_setup"` — repo-setup-agent populates repoConfig and ticket info
- `subPlans` is always an array (empty initially, never null)
- `repoConfig` is empty object (populated by repo-setup)
- Dev-loop defaults are hardcoded (autopilot only): implementer, reviewers, timeouts
- Manual mode uses the same initial state but will skip planning/sub-planning phases
- No `ticketSystem`, `obsidianLinked`, or `tmuxSession` fields (removed)

## Resumability

If `.kagent/task-state.json` already exists, skip setup entirely — the resume-agent handles dispatch.

## Next

Report back to orchestrator. Orchestrator will spawn repo-setup-agent next.
