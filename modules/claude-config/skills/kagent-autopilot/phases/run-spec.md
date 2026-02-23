# Phase: Run Spec

This phase writes the spec file for dev-loop and starts the run. It handles both the first cycle (fresh from task-spec or sub-plans) and subsequent cycles (fix spec from feedback).

## Directory Structure

Specs are stored in a committed directory structure:

```
spec/
└── <task-id>/              # e.g., "PE-1234" or "feature-auth"
    ├── task-spec.md        # Original full task spec (persistent)
    └── plans/              # Only created if sub-plans are needed
        ├── phase-1.md      # Sub-plan 1
        ├── phase-2.md      # Sub-plan 2
        └── ...
```

**IMPORTANT:** The `spec/` directory is committed to git. Only `.kagent/` is gitignored.

## First Push Cycle (`devLoopInitialized` is false)

### Step 1: Initialize Dev-Loop

1. Copy appropriate spec to `.kagent/spec.md`:
   - Single plan: `spec/<task-id>/task-spec.md`
   - Sub-plans: current sub-plan file from `subPlans[currentSubPlanIndex].file`
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

## Subsequent Push Cycles (`devLoopInitialized` is true)

1. Cancel previous run (cleans up stale tmux sessions, archives previous run):
   ```bash
   dev-loop cancel
   ```
2. Generate fix spec from feedback (see below)
3. Write fix spec to `.kagent/spec.md` (overwrites previous)

## Handling Sub-Plans

**If using sub-plans (`subPlans` is not null):**

After a dev-loop run completes successfully (exit 0, status `completed`):

1. **Commit the sub-plan's changes** — each sub-plan gets its own commit:

   ```bash
   git add -A  # Stage all changes from this sub-plan
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <sub-plan summary>

   [<ticket-id>]

   Phase N of M: <sub-plan title>

   - Change 1
   - Change 2
   EOF
   )"
   ```

2. Mark current sub-plan as complete in state:
   ```json
   { "id": "phase-N", "file": "spec/<task-id>/plans/phase-N.md", "status": "completed" }
   ```
3. Check if there are more pending sub-plans
4. **If more sub-plans exist:**
   - Increment `currentSubPlanIndex`
   - Copy next sub-plan to `.kagent/spec.md`
   - **Do NOT push yet** — continue to next sub-plan
   - Read `phases/running.md` and follow it (start next dev-loop run)
5. **If all sub-plans complete:**
   - All changes are committed and ready — proceed to push phase
   - Read `phases/pushing.md` and follow it (this pushes all commits together)

This approach:

- Creates one commit per sub-plan for clear history
- Keeps related changes grouped together
- Pushes once at the end with all commits

## Fix Spec Generation

Use [templates/fix-spec-template.md](../templates/fix-spec-template.md). Read `spec/<task-id>/task-spec.md` (use `specDir` from state) for original context, then gather feedback from the appropriate source:

| Feedback Source          | How to Get                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI failures              | `gh pr checks {prNumber}` for failed names; `gh run list --branch {branch} --status failure --limit 1 --json databaseId -q '.[0].databaseId'` then `gh run view {runId} --log-failed` |
| Review comments          | `gh api repos/{owner}/{repo}/pulls/{prNumber}/comments` (inline) + `gh pr view {prNumber} --json reviews` (top-level)                                                                 |
| Unresolved conversations | Poller output (exit 5) has thread details JSON with path, line, author, body. After addressing, comment `@coderabbitai` on PR to trigger re-review.                                   |
| Dev-loop max_iterations  | `.kagent/reviews/{lastRunId}/review-*.md` and `verdict-*.json`                                                                                                                        |
| Spec conflict (exit 2)   | `.kagent/conflict.md` + review files + user's clarification from `conflictContext`                                                                                                    |

Write populated fix spec to `.kagent/spec.md`.

## Start Dev-Loop

Update state: `phase: "run_spec"` (before running, for resumability).

Then proceed immediately to start the dev-loop run.

## Next

Read `phases/running.md` and follow it.
