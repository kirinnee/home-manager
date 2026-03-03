# Phase: Run Spec

**Agent Mode:** Spawned as run-spec-agent (haiku). Prepares spec file for dev-loop.

## Agent Context (when spawned)

- Working directory: {WORKDIR}
- State file: `.kagent/task-state.json`

## Agent Report Format

```
RESULT: <initialized|fix_spec_written|error>
DEV_LOOP_INITIALIZED: <true|false>
SPEC_FILE: .kagent/spec.md
TICKET_TRANSITION: <executed|skipped|failed>
ERROR: <error message if any>
```

This phase writes the spec file for dev-loop and starts the run. It handles both the first cycle (fresh from task-spec or sub-plans) and subsequent cycles (fix spec from feedback).

## Directory Structure (Versioned)

Specs are stored in a committed directory structure:

```
spec/
└── <task-id>/                  # e.g., "PE-1234" or "CU-abc123"
    ├── v1/                     # Version 1
    │   ├── task-spec.md        # Original spec
    │   └── plans/              # Sub-plans (if needed)
    │       ├── phase-1.md
    │       └── phase-2.md
    ├── v2/                     # Version 2 (after feedback iteration)
    │   ├── task-spec.md
    │   └── feedback.md         # Feedback that led to v2 (in v1)
    └── ...
```

**IMPORTANT:** The `spec/` directory is committed to git. Only `.kagent/` is gitignored.

## First Push Cycle (`devLoopInitialized` is false)

### Step 1: Initialize Dev-Loop

1. Copy current plan to `.kagent/spec.md`: use `subPlans[currentSubPlanIndex].file`
2. Initialize dev-loop:
   ```bash
   dev-loop init \
     --implementer <implementer> \
     --reviewers "<reviewer1,reviewer2>" \
     --conflict-checker <conflictChecker> \
     --max-iterations <maxIterations> \
     --implementer-timeout <implementerTimeout> \
     --reviewer-timeout <reviewerTimeout> \
     --conflict-check-threshold <conflictCheckThreshold>
   ```
3. Update state: `devLoopInitialized: true`

### Ticket Transition (first run per spec version)

If `repoConfig.ticketTransitions` is not null and this is the first `run_spec` for this spec version:

Execute `ticketTransitions.start` via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`:

**CLI:** Run the command template with `{ticketId}` and `{status}` substituted.
**MCP:** Use the MCP tool with appropriate parameters.

Store result in `ticketStatus`. If transition fails: log warning and continue.

## Subsequent Push Cycles (`devLoopInitialized` is true)

1. Cancel previous run (archives previous run):
   ```bash
   dev-loop cancel
   ```
2. Generate fix spec from feedback (see below)
3. Write fix spec to `.kagent/spec.md` (overwrites previous)

## Fix Spec Generation

Use [templates/fix-spec-template.md](../templates/fix-spec-template.md). Read `{specDir}/task-spec.md` for original context, then gather feedback from the appropriate source:

| Feedback Source          | How to Get                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI failures              | `gh pr checks {prNumber}` for failed names; `gh run list --branch {branch} --status failure --limit 1 --json databaseId -q '.[0].databaseId'` then `gh run view {runId} --log-failed`                     |
| Review comments          | `gh api repos/{owner}/{repo}/pulls/{prNumber}/comments` (inline) + `gh pr view {prNumber} --json reviews` (top-level)                                                                                     |
| Unresolved conversations | Poller output (exit 5, from `dev-loop poll-pr`, not dev-loop run) has thread details JSON with path, line, author, body. Re-review comment is posted by pushing agent using `repoConfig.reReviewComment`. |
| Dev-loop max_iterations  | `.kagent/reviews/{lastRunId}/review-*.md` and `verdict-*.json`                                                                                                                                            |
| Spec conflict (exit 2)   | `.kagent/conflict.md` + review files + user's clarification from `conflictContext`                                                                                                                        |

Write populated fix spec to `.kagent/spec.md`.

## Start Dev-Loop

State update (`phase: "run_spec"`) is done via state-agent before this phase runs.

Then proceed immediately to start the dev-loop run.

## Next

Read `phases/running.md` and follow it.
