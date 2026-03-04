# Resolve or Rewrite — Orchestrator Inline Logic

**This is a reference document, not an agent.** The orchestrator reads this and executes the logic inline.

Used by: Phase 2 (after `running` step), Phase 3 (after `run_fix` step)

## Decision Tree

After receiving the runner agent's report (EXIT_CODE, RUN_ID, STATUS):

### Exit 0 — Completed (STATUS: completed)

All reviewers approved. Proceed to next step:

- **Phase 2:** → `commit` step
- **Phase 3:** → `push` step

### Exit 2 — Spec Conflict

The spec contains contradictory or ambiguous requirements.

1. Read the **full run context** — not just the conflict checker's reasoning:
   - `.kagent/conflict.md` — conflict checker's analysis
   - `.kagent/reviews/{RUN_ID}/review-{iter}-{idx}-{binary}.md` — reviewer feedback
   - `.kagent/reviews/{RUN_ID}/verdict-{iter}-{idx}-{binary}.json` — reviewer verdicts
   - `.kagent/spec.md` — the spec that was used for this run
   - `{specDir}/task-spec.md` — the original task spec for broader context
2. **Compare the spec against the reviews** — understand where the spec led implementers/reviewers astray
3. Present to user **inline** with full context:
   - Remind them of the ticket and objective
   - Quote the specific spec conflict from conflict.md
   - Show how the spec's wording led to conflicting interpretations in reviews
   - Suggest 2-3 concrete ways to resolve the ambiguity
4. Use `AskUserQuestion` with specific options derived from the conflict
5. Spawn **rewrite-spec-agent** (opus) with:
   - The conflict context
   - User's chosen resolution
   - Original spec
6. After rewrite-spec completes → back to `running` step

### Exit 0 — Max Iterations (STATUS: max_iterations)

Consensus not reached within the iteration limit.

1. Read the **full run context**:
   - `.kagent/reviews/{RUN_ID}/review-{iter}-{idx}-{binary}.md` — all reviewer feedback
   - `.kagent/reviews/{RUN_ID}/verdict-{iter}-{idx}-{binary}.json` (has `reasoning` field)
   - `.kagent/spec.md` — the spec that was used
   - `{specDir}/task-spec.md` — original task spec
2. **Compare the spec against reviewer feedback** — identify where the spec was unclear, underspecified, or contradictory enough that reviewers couldn't converge
3. Present to user **inline**:
   - Highlight the cause (conflict pattern or insufficient iterations)
   - Show what reviewers disagreed on and how the spec contributed
   - Suggest options: increase iterations, clarify spec, or adjust scope
4. Get user guidance via `AskUserQuestion`
5. Spawn **rewrite-spec-agent** (opus) with:
   - Review feedback summary
   - User's guidance
   - Original spec
6. After rewrite-spec completes → back to `running` step

### Exit 1 — Error

Runtime error. Read `.kagent/run.log` for details.

- **Phase 2:** Transition to `failed` in `task-state.json`
- **Phase 3:** Transition to `failed` in `task-state.json`

Report with actionable details and offer retry.

## Spawning Rewrite-Spec Agent

```
Task(
  subagent_type: "general-purpose",
  model: "opus",
  description: "Rewrite spec for {ticketId}",
  prompt: "Read implementation/steps/rewrite-spec.md and execute.
    Working dir: {WORKDIR}.
    Conflict context: {conflictContext or feedback summary}.
    User guidance: {user's answer}.
    Original spec: {path to current .kagent/spec.md}."
)
```
