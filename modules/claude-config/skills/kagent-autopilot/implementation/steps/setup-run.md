# Implementation Step: Setup Run — Team Agent (Haiku)

## Agent Context

- Working directory: {WORKDIR}
- State file: `.kagent/task-state.json`
- Current sub-plan: {subPlans[currentSubPlanIndex]}

## Agent Report Format

```
RESULT: <initialized|ready|error>
DEV_LOOP_INITIALIZED: <true|false>
SPEC_FILE: .kagent/spec.md
TICKET_TRANSITION: <executed|skipped|failed>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Prepare the spec file for dev-loop and initialize if needed. Does NOT run dev-loop (that's `common/run-devloop.md`).

## First Run (`devLoopInitialized` is false in `impl-state.json`)

### Step 1: Copy Plan to Spec

```bash
cp {subPlans[currentSubPlanIndex].file} .kagent/spec.md
```

### Step 2: Initialize Dev-Loop

```bash
dev-loop init \
  --implementer {implementer} \
  --reviewers "{reviewer1,reviewer2,...}" \
  --conflict-checker {conflictChecker} \
  --max-iterations {maxIterations} \
  --implementer-timeout {implementerTimeout} \
  --reviewer-timeout {reviewerTimeout} \
  --conflict-check-threshold {conflictCheckThreshold}
```

### Step 3: Ticket Transition (first run per spec version)

If `impl-state.ticketTransitioned` is false and `repoConfig.ticketTransitions` is not null:

Execute `ticketTransitions.start` via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`:

**CLI:** Run the command template with `{ticketId}` and `{status}` substituted.
**MCP:** Use the MCP tool with appropriate parameters.

Report result in TICKET_TRANSITION field.

## Subsequent Runs (`devLoopInitialized` is true)

This happens when moving to the next sub-plan after committing the previous one.

### Step 1: Copy Next Plan to Spec

```bash
cp {subPlans[currentSubPlanIndex].file} .kagent/spec.md
```

Dev-loop is already initialized — no need to re-init. The clear-loop sub-agent has already cancelled/archived the previous run.

## After Rewrite-Spec

When re-entering after a spec rewrite (conflict or max iterations):

The rewrite-spec agent has already written the new `.kagent/spec.md`. No action needed from setup-run — go directly to `running`.

## Important

- Do NOT run dev-loop (that's `common/run-devloop.md`)
- Do NOT update state files
- Do NOT commit anything
- Only prepare the spec file and initialize dev-loop
