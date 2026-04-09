# Fix Phase 2 Resolve/Rewrite Flow

## Problem

The phase 2 `resolve` step hardcodes `'revisit_spec'` as its only exit path. The spec defines 4 rewrite decisions but only `revisit_spec` is implemented. The `rewrite_spec` handler is missing entirely — it appears in config, e2e tests, and log emoji, but has no handler and isn't in the phase2 state map.

Additionally, `kautopilot snapshot` requires an explicit epoch version argument that can be auto-detected from session state, forcing every prompt to inject `{epoch}` as a variable. This is error-prone and unnecessary.

## Current behavior (broken)

```
running:completed (status: "max_situations" or "conflict")
  → resolve (TTY)
  → checks if feedback.md exists
  → always returns 'revisit_spec' ← HARDCODED
  → orchestrator creates v2 epoch, replans from scratch
```

## New flow: two TTYs — draft amendment, then iterate

```
running:completed (max_situations or conflict)
  → resolve (TTY #1 — triage + draft amendment)
      ├── discusses what went wrong with user
      ├── decides strategy: refine_local, patch_downstream, regenerate_remaining, or revisit_spec
      ├── writes initial amendment (rewritten plans, regenerated plans, or feedback.md)
      ├── snapshots the amendment
      ├── logs decision: kautopilot log-event context:updated --metadata '{"rewriteDecision": "..."}'
      └── /exit
      Handler validates:
      ├── no decision → restart TTY
      ├── abandon (resolve:abandoned) → failed
      ├── revisit_spec + no feedback.md or no snapshot → restart TTY
      ├── revisit_spec + feedback.md + snapshot ✓ → proceed to rewrite_spec
      └── plan decision + snapshot ✓ → proceed to rewrite_spec

  → rewrite_spec (TTY #2 — iterate on snapshotted amendment)
      ├── reads snapshotted amendment from working copies
      ├── iterates with user (edit, snapshot each cycle)
      ├── user approves → kautopilot log-event (type):approved → /exit
      ├── no approval → restart TTY
      └── abandon → failed
      Routes:
          revisit_spec          → 'revisit_spec' → phase1 (escalate with feedback)
          refine_local          → clear_loop (same planIndex)
          patch_downstream      → clear_loop (planIndex = first incomplete plan)
          regenerate_remaining  → clear_loop (planIndex = first incomplete plan)
```

### Amendment types

| Decision               | Amendment                            | Snapshot command            | TTY #2 approval event    |
| ---------------------- | ------------------------------------ | --------------------------- | ------------------------ |
| `refine_local`         | Single plan file                     | `kautopilot snapshot plans` | `rewrite_plans:approved` |
| `patch_downstream`     | Incomplete plan files                | `kautopilot snapshot plans` | `rewrite_plans:approved` |
| `regenerate_remaining` | Incomplete plan files (from scratch) | `kautopilot snapshot plans` | `rewrite_plans:approved` |
| `revisit_spec`         | feedback.md                          | `kautopilot snapshot spec`  | `feedback:approved`      |

## Files to change

### 1. `src/cli/snapshot.ts` — Auto-detect epoch version

**Current:** `kautopilot snapshot <spec|plans> <epoch-version>` — epoch version is a required positional argument.

**New:** `kautopilot snapshot <spec|plans> [epoch-version]` — epoch version becomes optional. When omitted, auto-detect from session state.

**Auto-detection logic:**

```typescript
function resolveEpochVersion(sessionId: string, explicitVersion?: number): number {
  // 1. Explicit argument (backward compat)
  if (explicitVersion !== undefined) return explicitVersion;

  // 2. Read version from session status.yaml
  const statusPath = join(sessionDir(sessionId), 'status.yaml');
  if (existsSync(statusPath)) {
    const raw = readFileSync(statusPath, 'utf-8');
    const parsed = YAML.parse(raw);
    if (parsed?.version && typeof parsed.version === 'number') {
      return parsed.version;
    }
  }

  throw new Error('Could not auto-detect epoch version. Specify it explicitly: kautopilot snapshot <type> <version>');
}
```

Update `createSnapshotCommand`:

- Make `epoch-version` an optional argument (default: auto-detect)
- Pass `undefined` to `handleSnapshot` when not provided
- `handleSnapshot` calls `resolveEpochVersion` to fill it in
- When auto-detected, output includes: `EPOCH_VERSION=N`

### 2. `src/phases/phase2/resolve.ts` — Rewrite handler

**Remove:** the hardcoded `revisit_spec` return and the `feedback.md` required check as the only path.

**New behavior:**

1. Emit `resolve:started` event (or `resolve:restarted` on loops — this serves as the time fence for event filtering)
2. Open TTY with decision-focused prompt (see prompts below)
3. After TTY exits, read events logged since the most recent `resolve:started` or `resolve:restarted`:
   - Look for `context:updated` with `rewriteDecision` field
   - Look for `resolve:abandoned` event
   - Look for `snapshot:created` event
4. Routing logic:

```
if resolve:abandoned event found:
    return 'failed'

if no rewriteDecision found:
    restart TTY (emit resolve:restarted, loop back to step 1)

if no snapshot:created event found:
    restart TTY (emit resolve:restarted)

switch rewriteDecision:
  revisit_spec:
    if feedback.md does NOT exist:
        restart TTY (emit resolve:restarted)
    ctx.rewriteDecision = decision
    return 'rewrite_spec'

  refine_local | patch_downstream | regenerate_remaining:
    ctx.rewriteDecision = decision
    return 'rewrite_spec'
```

**Restart TTY** means: emit `resolve:restarted` event, then loop back and open the TTY again. This enforces that the TTY cannot exit without both a decision and a snapshot. Use a max-restart count (e.g., 5) to prevent infinite loops; if exceeded, throw an error.

**Abandon** is a deliberate opt-out. The TTY prompt tells the user they can run `kautopilot log-event resolve:abandoned` to give up. This marks the session as failed cleanly.

### 3. `src/phases/phase2/rewrite-spec.ts` — New file: TTY handler for iterating on amendment

This is a **TTY handoff** (not LLM print). Claude reads the snapshotted amendment, iterates on it with the user, and approval gates the exit. The TTY handles all snapshotting — the handler does NOT snapshot.

**Behavior:**

1. Read `rewriteDecision` from `ctx.rewriteDecision` (set by resolve handler)
2. Resolve context paths (spec, plans dir, feedback path)
3. Gather kloop evidence via `devloopDescribe(ctx.kloopRunId)`
4. Emit `rewrite_spec:started` event
5. Open TTY with decision-specific iterate prompt (see prompts below), injecting `{kloop_evidence}`
6. After TTY exits, read events since `rewrite_spec:started` (or `rewrite_spec:restarted`):
   - Check for `(type):approved` event
   - Check for `resolve:abandoned` event
7. If no approval: restart TTY (emit `rewrite_spec:restarted`, loop back to step 5, max 5 restarts)
8. If `resolve:abandoned` event: return `'failed'`
9. If approved: discover the latest snapshot the TTY created (from `snapshot:created` events since `rewrite_spec:started`). Do NOT snapshot — the TTY already handled it.
10. Emit `rewrite_spec:completed` with metadata `{ rewriteDecision, snapshotPath }`
11. Route based on decision:

```
revisit_spec          → return 'revisit_spec' (escalates to phase1)
refine_local          → return 'clear_loop' (same planIndex)
patch_downstream      → set ctx.planIndex = first incomplete plan → return 'clear_loop'
regenerate_remaining  → set ctx.planIndex = first incomplete plan → return 'clear_loop'
```

### 4. `src/phases/phase2/index.ts` — Add `rewrite_spec` to state map

```typescript
import { handleRewriteSpec } from './rewrite-spec';

const phase2States: Phase2StateMap = {
  clear_loop: handleClearLoop,
  setup_run: handleSetupRun,
  running: handleRunning,
  resolve: handleResolve,
  rewrite_spec: handleRewriteSpec, // NEW
  commit: handleCommit,
  next_plan: handleNextPlan,
  completed: handleCompleted,
  failed: handleFailed,
};
```

### 5. `src/phases/phase2/types.ts` — Add `rewriteDecision` to context

```typescript
export type RewriteDecision = 'refine_local' | 'patch_downstream' | 'regenerate_remaining' | 'revisit_spec';

export interface Phase2Context extends PhaseContext {
  // ... existing fields ...
  /** Rewrite decision from resolve step, persisted for rewrite_spec handler */
  rewriteDecision?: RewriteDecision;
}
```

### 6. `src/core/types.ts` — Update default agent prompts

See Prompts section below.

### 7. `src/phases/phase1/write-spec.ts` — Update snapshot command in mechanics

Change `kautopilot snapshot spec {epoch}` → `kautopilot snapshot spec`

Remove the `{epoch}` substitution from `SPEC_MECHANICS` since it's no longer needed.

### 8. `src/phases/phase1/write-plans.ts` — Update snapshot command in mechanics

Change `kautopilot snapshot plans {epoch}` → `kautopilot snapshot plans`

Remove the `{epoch}` substitution from `PLAN_MECHANICS` since it's no longer needed.

### 9. `src/cli/start.ts` — No changes needed

The orchestrator already handles `'revisit_spec'` return from phase 2. The `rewrite_spec` state stays within phase 2's state machine.

## Prompts

### Resolve TTY prompt (`agents.phase2.resolve`)

This TTY's job is triage, decision, and drafting the initial amendment. It discusses what went wrong with the user, decides on a strategy, writes the amendment, and snapshots it. It does NOT wait for approval — that's TTY #2's job.

````
## Context Paths
- Task spec: {task_spec_path}
- Current plan: {plan_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent.

## Kloop Evidence

{kloop_evidence}

## What Happened

The implementation loop for {plan_name} could not complete within its iteration limit.
Review the kloop evidence above to understand what went wrong.

## Decision Required

Based on your analysis, you MUST choose one of these rewrite strategies.
Discuss each option with the user and decide together:

1. **refine_local** — The current plan is mostly correct but needs targeted fixes.
   Choose when: the kloop was close to passing, issues are localized to this plan.
   Effect: you rewrite the current plan, then a second review pass iterates on it.

2. **patch_downstream** — Completed plans are fine, but remaining plans need updates
   to account for what was learned. Choose when: earlier plans changed the approach
   and downstream plans are now out of date.
   Effect: you patch remaining plans, then a second review pass iterates on them.

3. **regenerate_remaining** — Too much has changed; remaining plans should be
   regenerated from scratch against the spec. Choose when: fundamental assumptions
   shifted and incremental patches won't suffice.
   Effect: you regenerate incomplete plans, then a second review pass iterates on them.

4. **revisit_spec** — The spec itself has a contradiction or fundamental issue that
   makes it impossible for ANY plan to succeed.
   Choose when: the problem isn't the plans, it's what they're implementing.
   Effect: you write feedback explaining what's wrong, then a second review pass
   validates the feedback before escalating to a full replan.

## After Deciding — You MUST Do All Three Steps

### Step 1: Write the amendment

{decision_specific_draft_section}

### Step 2: Snapshot the amendment

```bash
kautopilot snapshot {snapshot_type}
````

The epoch version is auto-detected. This step is COMPULSORY — exit without a snapshot
and this step will restart from scratch.

### Step 3: Log your decision

```bash
kautopilot log-event context:updated --metadata '{"rewriteDecision": "<your_choice>"}'
```

Replace `<your_choice>` with one of: refine_local, patch_downstream, regenerate_remaining, revisit_spec.

After all three steps are done, tell the user the draft is ready for review and /exit.
A second TTY will open so you and the user can iterate on the amendment before it's finalized.

### If You Want to Abandon

If the situation is unsalvageable and you want to give up entirely:

```
kautopilot log-event resolve:abandoned
```

Then /exit. The session will be marked as failed.

```

**Decision-specific draft sections (injected as `{decision_specific_draft_section}`):**

**refine_local:**
```

Rewrite ONLY {plan_name} ({plan_path}) to address the issues found in the kloop evidence.
Do NOT modify other plan files.

Write the full plan — NOT a diff or changelog. Each plan file MUST follow this template:
{planTemplate}

After writing, snapshot and log your decision.

```

**patch_downstream:**
```

Rewrite the INCOMPLETE plan files only. Do NOT modify completed plans.

Completed plans (DO NOT edit):
{completed_plans_list}

Incomplete plans to update:
{incomplete_plans_list}

For each incomplete plan:

- Review what the completed plans actually produced
- Update the plan to account for any design decisions or discovered constraints
- Write the full plan — NOT a diff or changelog
- Each plan file MUST follow this template: {planTemplate}

After writing, snapshot and log your decision.

```

**regenerate_remaining:**
```

Rewrite ALL incomplete plan files from scratch.

Completed plans (DO NOT edit — these already committed):
{completed_plans_list}

Incomplete plans to regenerate:
{incomplete_plans_list}

For each incomplete plan:

- Read the spec to understand the original intent
- Review what completed plans produced (read the codebase)
- Write a completely new plan consistent with current reality
- Each plan file MUST follow this template: {planTemplate}

After writing, snapshot and log your decision.

```

**revisit_spec:**
```

Write feedback to {feedback_path} explaining:

1. What specifically went wrong (reference the kloop evidence)
2. What spec changes are needed for the next epoch
3. Why the current spec cannot succeed as-is

This feedback will guide a full replan. Be thorough and specific.

After writing feedback.md, snapshot the spec (which includes the feedback):

```bash
kautopilot snapshot spec
```

Then log your decision.

```

### Rewrite-spec TTY prompt (`agents.phase2.rewrite_spec`)

This TTY's job is to iterate on the snapshotted amendment with the user, then get approval. It follows the same snapshot/approval protocol as Phase 1's `write_plans` and `write_spec`.

The prompt is different for each decision type. The handler injects the correct section based on `ctx.rewriteDecision`.

```

## Review Amendment: {decision_title}

{decision_specific_review_section}

## Kloop Evidence

{kloop_evidence}

## Context Paths

- Task spec: {task_spec_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent and verify the amendment.

## CRITICAL: Iteration & Approval Mechanics

### Working Copies

Edit files directly in their directories. Each version MUST be a complete, standalone
document — NOT a diff or changelog.

### Snapshot Workflow (COMPULSORY)

After each edit cycle, you MUST create a snapshot:

```bash
kautopilot snapshot {snapshot_type}
```

This copies the working copies to a versioned snapshot. It outputs:

- SNAPSHOT_VERSION=N
- SNAPSHOT_PATH=...

The epoch version is auto-detected from the session — you do not need to specify it.

This step is COMPULSORY.

### Approval Protocol

When the user approves the amendment, you MUST do these things IN ORDER:

1. Write the approval event:
   ```bash
   kautopilot log-event {approval_event}
   ```
2. THEN tell the user to /exit

**CRITICAL**: Do NOT tell the user to /exit before writing the approval event.
If the session crashes or the user Ctrl+C's before the approval event is logged,
the amendment will NOT be considered approved and this step will re-run.

### If You Want to Abandon

```
kautopilot log-event resolve:abandoned
```

Then /exit. The session will be marked as failed.

```

**Decision-specific review sections (injected as `{decision_specific_review_section}`):**

**refine_local:**
```

The plan {plan_name} ({plan_path}) was rewritten to fix issues from the kloop run.
Review the changes with the user. Iterate until satisfied.

If further changes are needed:

- Edit the plan file
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.

```

**patch_downstream:**
```

The incomplete plan files were patched to account for what was learned during execution.
Review the changes with the user. Iterate until satisfied.

If further changes are needed:

- Edit the plan files
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.

```

**regenerate_remaining:**
```

The incomplete plan files were regenerated from scratch based on the current spec
and what the completed plans produced.
Review the new plans with the user. Iterate until satisfied.

If further changes are needed:

- Edit the plan files
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.

```

**revisit_spec:**
```

Feedback was written to {feedback_path} explaining what's wrong with the spec and
what changes are needed for the next epoch.
Review the feedback with the user. Iterate until satisfied.

If further changes are needed:

- Edit feedback.md
- Snapshot after each edit
- Continue discussing with the user

When approved, log the approval event and /exit.
The session will escalate to a full replan with the feedback guiding the new epoch.

```

### Handler template variable mapping

| Variable | Source |
|---|---|
| `{decision_title}` | Human-readable title from `rewriteDecision` |
| `{decision_specific_draft_section}` | Draft instructions for TTY #1 |
| `{decision_specific_review_section}` | Review instructions for TTY #2 |
| `{snapshot_type}` | `plans` for plan decisions, `spec` for revisit_spec |
| `{approval_event}` | `rewrite_plans:approved` for plan decisions, `feedback:approved` for revisit_spec |
| `{kloop_evidence}` | `devloopDescribe(ctx.kloopRunId)` |
| `{task_spec_path}`, `{plan_path}`, `{plans_dir}` | From session context |
| `{feedback_path}` | Session feedback path |
| `{planTemplate}` | Plan template from config |
| `{completed_plans_list}`, `{incomplete_plans_list}` | From plan manifest |
| `{plan_name}` | Current plan name |
| `{last_completed_plan}` | Last completed plan index |

### Phase 1 write-spec mechanics update (`SPEC_MECHANICS` in `write-spec.ts`)

**Current:**
```

After each edit cycle (writing or editing the spec), you MUST create a snapshot:

```bash
kautopilot snapshot spec {epoch}
```

```

**New:**
```

After each edit cycle (writing or editing the spec), you MUST create a snapshot:

```bash
kautopilot snapshot spec
```

The epoch version is auto-detected from the session — you do not need to specify it.

```

Remove `{epoch}` from `SPEC_MECHANICS` template and the `resolvePromptVars` call for it.

### Phase 1 write-plans mechanics update (`PLAN_MECHANICS` in `write-plans.ts`)

**Current:**
```

After each edit cycle (writing or editing the plans), you MUST create a snapshot:

```bash
kautopilot snapshot plans {epoch}
```

```

**New:**
```

After each edit cycle (writing or editing the plans), you MUST create a snapshot:

```bash
kautopilot snapshot plans
```

The epoch version is auto-detected from the session — you do not need to specify it.

```

Remove `{epoch}` from `PLAN_MECHANICS` template and the `resolvePromptVars` call for it.

## After rewrite_spec: routing

When `(type):approved` is logged in TTY #2, the handler:

1. Discovers the latest snapshot the TTY created (from `snapshot:created` events since `rewrite_spec:started`)
2. Does NOT re-snapshot — the TTY already snapshot'd each edit cycle
3. Emits `rewrite_spec:completed` with metadata `{ rewriteDecision, snapshotPath }`
4. Routes:
   - `revisit_spec` → return `'revisit_spec'` (phase1 escalation, feedback in snapshot)
   - `refine_local` → return `'clear_loop'` (same `planIndex`)
   - `patch_downstream` → set `ctx.planIndex` = first incomplete plan, return `'clear_loop'`
   - `regenerate_remaining` → set `ctx.planIndex` = first incomplete plan, return `'clear_loop'`

## State machine flow

```

clear_loop → setup_run → running ─┬─ completed → commit → next_plan → clear_loop (next plan)
├─ max_situations ─┐
├─ conflict ───────┤
▼
resolve (TTY #1 — triage + draft)
│
├─ no decision/snapshot → restart resolve TTY
├─ abandon → failed
├─ revisit_spec (no feedback/snapshot) → restart
└─ decision + snapshot ✓
│
▼
rewrite_spec (TTY #2 — iterate + approve)
│
├─ no approval → restart rewrite TTY
├─ abandon → failed
└─ approved → route:
├─ revisit_spec → phase1
├─ refine_local → clear_loop (same plan)
├─ patch_downstream → clear_loop (first incomplete)
└─ regenerate_remaining → clear_loop (first incomplete)
└─ crash → setup_run (retry) or failed

````

## Existing tests that need updating

### `src/phases/__tests__/e2e-scenarios.test.ts`

- Scenario 2 (`refine_local`): Now needs `resolve:started`/snapshot/`rewrite_spec:started`/`rewrite_spec:completed`/`rewrite_plans:approved` events (emitted by real handlers)
- Scenario 4 (`patch_downstream`): Same as above
- Scenario 7 (`revisit_spec`): Now needs `resolve:started`/snapshot/`rewrite_spec:started`/`feedback:approved` events

### `src/phases/__tests__/outcomes.test.ts`

- Add test: `resolve with no rewriteDecision triggers TTY restart`
- Add test: `resolve with no snapshot triggers TTY restart`
- Add test: `resolve with revisit_spec but no feedback.md triggers TTY restart`
- Add test: `resolve:abandoned routes to failed`
- Add test: `rewrite_spec with no approval triggers TTY restart`
- Add test: `rewrite_spec:abandoned routes to failed`

### `src/cli/__tests__/snapshot.test.ts` (new or existing)

- Add test: `kautopilot snapshot plans` auto-detects epoch from status.yaml
- Add test: `kautopilot snapshot spec` auto-detects epoch from status.yaml
- Add test: `kautopilot snapshot plans 2` still works with explicit epoch (backward compat)
- Add test: auto-detect fails gracefully when no session/status found

## Validation rules in resolve handler

```typescript
const MAX_RESTARTS = 5;

// Each loop iteration emits resolve:restarted (or resolve:started on first pass)
// so getEventsSince filters to only events from the current TTY attempt
appendEvent(session.id, { ts: new Date().toISOString(), event: 'resolve:started', version });
// (or resolve:restarted on subsequent attempts)

// After TTY exits:
const fenceEvent = restartCount === 0 ? 'resolve:started' : 'resolve:restarted';
const eventsSince = getEventsSince(fenceEvent);

// Check abandon
if (eventsSince.some(e => e.event === 'resolve:abandoned')) {
  return 'failed';
}

// Check decision
const decisionEvent = eventsSince.find(e =>
  e.event === 'context:updated' && e.metadata?.rewriteDecision
);
const decision = decisionEvent?.metadata?.rewriteDecision as RewriteDecision | undefined;

if (!decision) {
  if (restartCount >= MAX_RESTARTS) {
    throw new Error('Resolve TTY restarted too many times without a decision');
  }
  restartCount++;
  continue; // loop back
}

// Check snapshot (TTY must have produced one)
const hasSnapshot = eventsSince.some(e => e.event === 'snapshot:created');
if (!hasSnapshot) {
  if (restartCount >= MAX_RESTARTS) {
    throw new Error('Resolve TTY restarted too many times without a snapshot');
  }
  restartCount++;
  continue; // loop back
}

// For revisit_spec: check feedback.md
if (decision === 'revisit_spec') {
  if (!existsSync(feedbackPath)) {
    if (restartCount >= MAX_RESTARTS) {
      throw new Error('Resolve TTY restarted too many times without feedback.md');
    }
    restartCount++;
    continue;
  }
}

// Store decision on context for rewrite_spec handler
ctx.rewriteDecision = decision;
return 'rewrite_spec';
````
