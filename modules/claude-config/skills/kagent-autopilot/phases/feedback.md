# Phase: Feedback (Post-Completion Iteration)

This phase handles iterations after the PR is marked complete. User provides learnings/feedback, which spawns a new spec version.

## Entry Conditions

- `phase: "feedback"` in state (set by orchestrator when user provides feedback from completed state)
- Autopilot mode only — feedback requires autopilot mode (manual mode has no spec to iterate on)

## Step 1: Capture Feedback (Chat-Based)

Use natural chat (NOT AskUserQuestion) to gather and clarify feedback:

```
Great, the PR is complete. What feedback do you have?

Some common areas:
- Implementation approach that could be improved
- Edge cases discovered during review
- Performance concerns
- Better ways to structure the code
- Missing test coverage
```

Iterate until you have clear, actionable feedback items.

## Step 2: Write Feedback File

Create `spec/<task-id>/v{N}/feedback.md`:

```markdown
# Feedback for v{N}

**Date:** {YYYY-MM-DD}
**PR:** #{prNumber}

## Feedback Items

### 1. {Feedback Title}

**Observation:** What was observed

**Impact:** Why this matters

**Suggested Change:** How to address it

### 2. ...

## Summary

{Brief summary of what should change in the next iteration}
```

## Step 3: Create New Spec Version

1. Create new version directory:

   ```bash
   mkdir -p spec/<task-id>/v{N+1}
   ```

2. Create `spec/<task-id>/v{N+1}/task-spec.md` by combining:
   - Read `spec/<task-id>/v{N}/task-spec.md` (original spec)
   - Read `spec/<task-id>/v{N}/feedback.md` (just written)
   - Merge: incorporate feedback into the spec's relevant sections
     - Update **Technical Decisions** if approach changed
     - Add new **Edge Cases** discovered
     - Update **Acceptance Criteria** if scope expanded
     - Add to **Context** section with learnings

3. Commit the changes:
   ```bash
   git add spec/<task-id>/
   git commit -m "docs: add v{N+1} spec with post-completion feedback"
   ```

## Step 3.5: Spec Re-Approval

Present the merged spec to user via `AskUserQuestion` for re-approval before proceeding to sub-planning.

On approval: continue to Step 4.
On rejection: iterate with user feedback, update the merged spec.

## Step 4: Update State (Full Field Reset)

**Reset to initial:**

```json
{
  "phase": "approved",
  "specVersion": <N+1>,
  "specDir": "spec/{ticketId}/v{N+1}",
  "pushCycle": 0,
  "devLoopInitialized": false,
  "subPlans": [],
  "currentSubPlanIndex": 0,
  "lastRunId": null,
  "lastRunExitCode": null,
  "lastRunStatus": null,
  "lastError": null,
  "conflictContext": null
}
```

**Keep as-is:** `ticketId`, `ticketTitle`, `ticketBody`, `branch`, `repoConfig`, `mode`, `implementer`, `reviewers`, `maxIterations`, `timeouts`, `maxPushCycles`, `teamName`

**Smart detect `prNumber`:**

```bash
gh pr view {prNumber} --json state --jq '.state'
```

- If state is `MERGED`: set `prNumber: null` (pushing agent will create new PR)
- If state is `OPEN`: keep `prNumber` as-is

**Ticket transition:** Execute `ticketTransitions.feedback` via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`. Update `ticketStatus`.

## Step 5: Dispatch

Dispatch to sub-planning phase (`phase: "approved"` triggers sub-planning inline).

## Resumability

If resuming into this phase: check for `spec/<task-id>/v{N}/feedback.md`. If exists, continue to Step 3. If not, restart from Step 1.
