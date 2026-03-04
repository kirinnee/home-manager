# Plan Step: Feedback — Orchestrator Inline

This step runs inline with the orchestrator. It handles iterations after Phase 3 completion — user provides learnings/feedback, which creates a new spec version.

## Entry Conditions

- `task-state.currentPhase: "plan"` with `plan-state.step: "feedback"`
- This step only runs for v2+ (returning from Phase 3 with feedback)

## Context Needed

Read from `.kagent/task-state.json`:

- `ticketId`, `specVersion` (current, about to be bumped), `specDir`, `prNumber`, `ticketStatus`
- `repoConfig` (for ticket transitions)

## Step 1: Capture Feedback (Chat-Based)

Use natural chat (NOT AskUserQuestion) to gather and clarify feedback:

```
The PR is complete. What feedback do you have for the next iteration?

Some common areas:
- Implementation approach that could be improved
- Edge cases discovered during review
- Performance concerns
- Better ways to structure the code
- Missing test coverage
```

Iterate until you have clear, actionable feedback items.

## Step 2: Write Feedback File

Create `spec/{ticketId}/v{N}/feedback.md`:

```markdown
# Feedback for v{N}

**Date:** {YYYY-MM-DD}
**PR:** #{prNumber}
**Ticket Status:** {ticketStatus}
**Version:** {specVersion}

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
   mkdir -p spec/{ticketId}/v{N+1}
   ```

2. Create `spec/{ticketId}/v{N+1}/task-spec.md` by combining:
   - Read `spec/{ticketId}/v{N}/task-spec.md` (original spec)
   - Read `spec/{ticketId}/v{N}/feedback.md` (just written)
   - Merge: incorporate feedback into the spec's relevant sections
     - Update **Technical Decisions** if approach changed
     - Add new **Edge Cases** discovered
     - Update **Acceptance Criteria** if scope expanded
     - Add to **Context** section with learnings

3. Commit the changes:
   ```bash
   git add spec/{ticketId}/
   git commit -m "docs: add v{N+1} spec with post-completion feedback"
   ```

## Step 3.5: Spec Re-Approval

Present the merged spec to user via `AskUserQuestion` for re-approval before proceeding.

On approval: continue to Step 4.
On rejection: iterate with user feedback, update the merged spec.

## Step 4: Update State

Update `task-state.json` (via plan state-agent):

```json
{
  "specVersion": <N+1>,
  "specDir": "spec/{ticketId}/v{N+1}",
  "subPlans": [],
  "currentSubPlanIndex": 0
}
```

**Keep as-is:** `ticketId`, `ticketTitle`, `ticketBody`, `branch`, `repoConfig`, `implementer`, `reviewers`, `maxIterations`, timeouts, `maxPushCycles`, `teamName`

**Smart detect `prNumber`:**

```bash
gh pr view {prNumber} --json state --jq '.state'
```

- If state is `MERGED`: set `prNumber: null` (create-pr will make a new PR)
- If state is `OPEN`: keep `prNumber` as-is

**Ticket transition:** If `repoConfig.ticketTransitions` is not null, execute `ticketTransitions.feedback` via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`. If the value is an array, execute each status in sequence (multi-step transitions). Update `ticketStatus` with the final status. If `ticketTransitions` is null: skip.

## Step 5: Advance State

Update `plan-state.json`: `step: "write_spec"`. Continue inline to write-spec step.

## Resumability

If resuming: check for `spec/{ticketId}/v{N}/feedback.md`. If exists, skip to Step 3. If `v{N+1}/task-spec.md` exists, skip to Step 3.5 (re-approval). Otherwise restart from Step 1.
