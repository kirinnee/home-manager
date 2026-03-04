# Polish Step: Feedback Check — Orchestrator Inline

**This runs inline with the orchestrator.** Asks user for feedback after a clean poll.

## Entry Condition

- `polish-state.step: "feedback_check"`
- Poll returned exit 0 (ready to merge) or all issues resolved

## Step 1: Present Status

```
PR #{prNumber} is ready to merge! All checks passing, reviews approved.

Options:
1. Complete — mark as done
2. I have feedback — iterate with a new spec version
```

## Step 2: Ask User

Use `AskUserQuestion`:

- **"Complete"**: Proceed to completion
- **"I have feedback"**: Return to Phase 1 for iteration

## On Complete

1. Update `polish-state.json`: `step: "completed"`
2. Update `task-state.json`: `currentPhase: "completed"`
3. Execute ticket transition: `ticketTransitions.done`
4. Report: "Task completed. PR #{prNumber}."

## On Feedback

1. Update `task-state.json`:
   - `currentPhase: "plan"`
   - Bump `specVersion`
2. Create new `plan-state.json` with `step: "feedback"`
3. Execute ticket transition: `ticketTransitions.feedback` (if not null)
4. Request context clear and re-invoke `/kagent-autopilot`
