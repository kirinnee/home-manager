# Phase: Running

This phase executes dev-loop and handles the result based on exit code.

## Update Ticket Status

**Before starting dev-loop**, move the ticket to "In Progress" status:

**Jira (`ticketSystem: "jira"`):**

```bash
acli jira workitem transition {ticketId} --transition "In Progress"
```

**ClickUp (`ticketSystem: "clickup"`):**
Use ClickUp MCP to update task status to "in progress".

Skip this step if `ticketId` is null.

## Execute Dev-Loop

Run as a **background Bash task** and block with TaskOutput:

```bash
dev-loop run 2>&1 | tee .kagent/run.log
```

Use `run_in_background: true` with Bash tool, then wait with TaskOutput.

Update state: `phase: "running"`

## When Dev-Loop Returns

Find the latest run ID: `ls -t .kagent/history/ | head -1` (filename without extension).

Store `lastRunId`, `lastRunExitCode`, and `lastRunStatus` in state.

### Exit 0 — Completed (all reviewers approved)

Status in history file is `completed`.

**If using sub-plans (`subPlans` is not null):**

1. **Commit the sub-plan's changes** — each sub-plan gets its own commit:

   ```bash
   git add -A
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <sub-plan summary>

   [<ticket-id>]

   Phase N of M: <sub-plan title>

   - Change 1
   - Change 2
   EOF
   )"
   ```

2. Mark current sub-plan as completed in state:
   ```json
   { "id": "phase-N", "file": "spec/<task-id>/plans/phase-N.md", "status": "completed" }
   ```
3. Check remaining sub-plans:
   - **More pending sub-plans:** Increment `currentSubPlanIndex`, copy next sub-plan file to `.kagent/spec.md`, read `phases/run-spec.md` to start next dev-loop run (skip initialization)
   - **All sub-plans done:** All commits ready — proceed to push phase below

**If single spec (no sub-plans):**

**Next:** Read `phases/pushing.md` and follow it.

### Exit 0 — Max Iterations (consensus not reached)

Status in history file is `max_iterations`.

- If `pushCycle < maxPushCycles`: Generate fix spec from review feedback → Read `phases/run-spec.md`
- If `pushCycle >= maxPushCycles`: Transition to `failed` (see Terminal States below)

Read reviewer feedback from:

- `.kagent/reviews/{lastRunId}/review-{iter}-{idx}-{binary}.md`
- `.kagent/reviews/{lastRunId}/verdict-{iter}-{idx}-{binary}.json` (has `reasoning` field)

### Exit 1 — Error

Read `.kagent/run.log` for error details. Transition to `failed`.

### Exit 2 — Spec Conflict

The spec itself contains contradictory or ambiguous requirements. The conflict checker detected this after consecutive failed iterations.

1. Read `.kagent/conflict.md` for the conflict checker's analysis
2. Read relevant reviews from `.kagent/reviews/{lastRunId}/`
3. Present to user with **full context** (user may not remember the task):
   - Remind them of the ticket and objective
   - Quote the specific spec conflict from conflict.md
   - Quote how reviewers interpreted the ambiguity differently
   - Suggest 2-3 concrete ways to resolve the ambiguity
4. Use `AskUserQuestion` with specific options derived from the conflict
5. Store user's answer in state field `conflictContext`
6. Remove `.kagent/conflict.md`
7. Read `phases/run-spec.md` to generate fix spec with clarification

## Resumability

If resuming into this phase: check `.kagent/current/run.json`. If exists, check for tmux sessions (`tmux ls 2>/dev/null | grep devloop`). If active, offer to wait or cancel. If no active run, read latest history entry for the result and handle accordingly.

## Terminal States

**Failed** — report with actionable details:

```
Max push cycles reached ({N}/{MAX})
  Ticket: {ticketId}
  PR: #{prNumber}

  Remaining issues:
  - {issue 1}

  Please take over manually.
```

Update state: `phase: "failed"`
