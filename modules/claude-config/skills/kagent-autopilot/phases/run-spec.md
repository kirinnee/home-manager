# Phase: Run Spec

This phase writes the spec file for dev-loop and starts the run. It handles both the first cycle (fresh from task-spec) and subsequent cycles (fix spec from feedback).

## First Push Cycle (`devLoopInitialized` is false)

1. Copy `.kagent/task-spec.md` content to `.kagent/spec.md`
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

## Fix Spec Generation

Use [templates/fix-spec-template.md](../templates/fix-spec-template.md). Read `.kagent/task-spec.md` for original context, then gather feedback from the appropriate source:

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
