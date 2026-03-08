# Polish Step: Feedback Check — Orchestrator Inline

**This runs inline with the orchestrator.** Asks user for feedback after a clean poll.

**CRITICAL: NEVER merge the PR. No `gh pr merge`. The user merges manually.**

## Entry Condition

- `polish-state.step: "feedback_check"`
- Poll returned exit 0 (ready to merge) or all issues resolved

## Step 1: Present Status

```
PR #{prNumber} is ready for you to merge! All checks passing, reviews approved.

**Note: The PR will NOT be merged automatically. You must merge it yourself.**

Options:
1. Complete — mark task as done (you'll merge the PR yourself)
2. I have feedback — iterate with a new spec version
```

## Step 2: Ask User

Use `AskUserQuestion`:

- **"Complete"**: Proceed to completion
- **"I have feedback"**: Return to Phase 1 for iteration

## On Complete

1. Update `.kagent/polish-state.json`: `step: "completed"`
2. Update `.kagent/task-state.json`: `currentPhase: "completed"`
3. Execute ticket transition: `ticketTransitions.done`
4. Report: "Task completed. PR #{prNumber} is ready for you to merge."
5. **Do NOT merge the PR** — the user merges manually

## On Feedback

1. Update `.kagent/task-state.json`:
   - `currentPhase: "plan"`
   - Bump `specVersion`
2. Create new `.kagent/plan-state.json` with `step: "feedback"`
3. Execute ticket transition: `ticketTransitions.feedback` (if not null)
4. Request context clear and re-invoke `/kagent-autopilot`
