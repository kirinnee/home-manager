# Phase: Feedback (Post-Completion Iteration)

This phase handles iterations after the PR is marked complete. User provides learnings/feedback, which spawns a new spec version.

## Entry Conditions

- `phase: "completed"` in state
- User says something like "I have feedback" or provides post-completion learnings

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

## Step 4: Update State

```json
{
  "phase": "approved",
  "specVersion": <N+1>,
  "specDir": "spec/<task-id>/v<N+1>",
  "subPlans": null,
  "currentSubPlanIndex": null,
  "pushCycle": 0,
  "devLoopInitialized": false
}
```

**Note:** Reset `pushCycle`, `devLoopInitialized`, `subPlans`, and `currentSubPlanIndex` since this is a fresh implementation cycle.

## Step 5: Dispatch

Read `phases/sub-planning.md` and follow it (or skip directly to `run-spec.md` if single plan is appropriate).

## Resumability

If resuming into this phase: check for `spec/<task-id>/v{N}/feedback.md`. If exists, continue to Step 3. If not, restart from Step 1.
