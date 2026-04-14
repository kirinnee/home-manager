# Implementation Step: Setup Run — Team Agent (Haiku)

## Agent Context

- Working directory: {WORKDIR}
- State file: `.kagent/task-state.json`
- Current sub-plan: {subPlans[currentSubPlanIndex]}

## Agent Report Format

```
RESULT: <initialized|ready|error>
KLOOP_INITIALIZED: <true|false>
KLOOP_RUN_ID: <runId from kloop init>
SPEC_FILE: .kagent/spec.md
TICKET_TRANSITION: <executed|skipped|failed>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to orchestrator only.

## Task

Prepare the spec file for kloop and initialize if needed. Does NOT run kloop (that's `common/run-devloop.md`).

## First Run (`kloopInitialized` is false in `impl-state.json`)

### Step 1: Copy Plan to Spec

```bash
cp {subPlans[currentSubPlanIndex].file} .kagent/spec.md
```

### Step 2: Write kloop Config

Write a YAML config file at `.kagent/kloop-config.yaml`:

```yaml
implementers: { implementers }

reviewPhases: { reviewPhases }

maxIterations: { maxIterations }
implementerTimeout: { implementerTimeout }
reviewerTimeout: { reviewerTimeout }
conflictCheckThreshold: { conflictCheckThreshold }
firstLoopFullReview: true
previousReviewPropagation: { previousReviewPropagation }
reviewerFailureLimit: 2
```

### Step 3: Initialize kloop

```bash
kloop init --workspace . --spec .kagent/spec.md --config .kagent/kloop-config.yaml
```

Parse the run ID from output (line containing `Run ID:`). Store as `KLOOP_RUN_ID`.

### Step 4: Clean Up Temporary Config

```bash
rm -f .kagent/kloop-config.yaml
```

The config is copied into kloop's run directory during init — the local file is no longer needed.

### Step 5: Ticket Transition (first run per spec version)

If `impl-state.ticketTransitioned` is false and `repoConfig.ticketTransitions` is not null:

Execute `ticketTransitions.start` via `repoConfig.ticketTransitionAccess` + `repoConfig.ticketTransitionCommand`:

**CLI:** Run the command template with `{ticketId}` and `{status}` substituted.
**MCP:** Use the MCP tool with appropriate parameters.

Report result in TICKET_TRANSITION field.

## Subsequent Runs (`kloopInitialized` is true)

This happens when moving to the next sub-plan after committing the previous one.

### Step 1: Copy Next Plan to Spec

```bash
cp {subPlans[currentSubPlanIndex].file} .kagent/spec.md
```

### Step 2: Write Config and Re-Init

Same as first run Steps 2-4. Each sub-plan gets a fresh kloop run with its own runId.

## After Rewrite-Spec

When re-entering after a spec rewrite (conflict or max iterations):

The rewrite-spec agent has already written the new `.kagent/spec.md`. Re-init kloop with Steps 2-4 to get a fresh runId.

## Important

- Do NOT run kloop (that's `common/run-devloop.md`)
- Do NOT update state files
- Do NOT commit anything
- Only prepare the spec file, initialize kloop, and report the runId
