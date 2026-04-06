# Spec: Conflict Resolution & Snapshot System

## Summary

Restructure the conflict resolution flow to properly route back to phase1, add a `kautopilot snapshot` command for audit-friendly editing, and simplify prompts for spec/plan writers.

---

## Part 1: Conflict Resolution State Machine

### Current Problems

1. **`resolve` embeds decision in file** - parsed by regex, fragile
2. **No analysis phase** - user must pick from 4 options blindly
3. **`revisit_spec` stops at `failed`** - doesn't create new epoch or return to phase1
4. **`rewrite_spec` name lies** - it rewrites plans, not task spec
5. **LLM sees inlined content** - bloats context

### New Flow

```
running → (conflict/max_situations) → resolve
                                    ↓
                          resolve (TTY):
                          1. Show kloop evidence
                          2. ANALYZE conflict yourself
                          3. PROPOSE decision + reasoning
                          4. CLARIFY if user disagrees
                          5. Write event, proceed
                                    ↓
                          Decision routing:
                          ┌─────────────────────────────────────────┐
                          │ refine_local                            │
                          │   → rewrite_plan (current only)         │
                          │   → running                             │
                          ├─────────────────────────────────────────┤
                          │ regenerate_remaining                    │
                          │   → rewrite_plan (current + downstream) │
                          │   → running                             │
                          ├─────────────────────────────────────────┤
                          │ revisit_spec                            │
                          │   → returns signal to runner            │
                          │   → runner creates vN+1                 │
                          │   → runner writes conflict-context.yaml│
                          │   → runner restarts phase1              │
                          └─────────────────────────────────────────┘
```

### Cross-Phase Mechanics

**Problem:** Phase state machines can't transition to other phases. Each phase has its own context type and runner.

**Solution:** Return special signals that the **runner** intercepts, not the state machine.

**Signal flow:**

```ts
// In phase2/resolve.ts
if (decision === 'revisit_spec') {
  // Write conflict context to artifacts (persists across phases)
  writeConflictContext(sessionId, version, {
    previousVersion: version,
    failedPlan: planName,
    conflictDescription: '...',
    kloopRunId: ctx.kloopRunId,
    failedConstraint: 'spec said X, reality says Y',
  });

  // Return special signal
  return 'revisit_spec'; // Runner intercepts this
}

// In runner (src/phases/runner.ts)
const result = await runPhase2State(state, ctx);
if (result === 'revisit_spec') {
  // Runner handles cross-phase transition
  const newVersion = incrementVersion(sessionId, version);
  await restartPhase1(sessionId, newVersion);
  return;
}
```

**Conflict context persistence:**

```
~/.kautopilot/<session>/
├── artifacts/
│   └── v1/
│       └── conflict-context.yaml   # Written by resolve when revisit_spec
│
├── artifacts/
│   └── v2/                         # Created by runner on restart
│       └── conflict-context.yaml   # Copied from v1 + amended
```

**Phase1 handlers read conflict context:**

```ts
// In phase1/write-spec.ts
const conflictContext = readConflictContext(sessionId, version);
if (conflictContext) {
  // Inject into prompt
  prompt += `\n\n## Conflict from Previous Version\n...`;
}
```

### New States

#### `resolve` (phase2) - Enhanced TTY

**Purpose**: Analyze conflict, propose resolution, agree with user.

**Behavior**:

1. Load kloop evidence via `kloop describe`
2. Load paths (not inlined content):
   - `{task_spec_path}` - task-spec.md
   - `{plan_path}` - current plan
   - `{plans_dir}` - plans directory
3. Analyze: Is this local? Cascading? Spec-level?
4. Propose decision with reasoning
5. If user disagrees → clarify → re-propose loop
6. Once user confirms (via approval event, not regex), write `resolve:decision` event
7. Return next state based on decision:
   - `refine_local` → `rewrite_plan`
   - `regenerate_remaining` → `rewrite_plan`
   - `revisit_spec` → write conflict-context.yaml, return `'revisit_spec'` signal

**Prompt structure**:

```
## Context Paths
- Task spec: {task_spec_path}
- Current plan: {plan_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent.

## Kloop Evidence

{kloop_evidence}

## Analysis

Based on the evidence above:
1. What specifically went wrong?
2. Is this a plan implementation issue or a spec constraint issue?
3. How many plans are affected? (current only? downstream too?)

## Proposed Decision

I propose: [refine_local | regenerate_remaining | revisit_spec]

Reasoning: [explanation]

[If user disagrees, clarify and re-propose]

When ready, log your approval event to proceed.
```

**Variables**:

- `{task_spec_path}` - path to task-spec.md
- `{plan_path}` - path to current plan
- `{plans_dir}` - path to plans directory
- `{kloop_evidence}` - output from `kloop describe`

**Mechanics injected by handler** (not in user-configurable prompt):

- File read instructions
- Approval event format
- Decision options with semantics

**Approval mechanism**:
User logs approval event (same pattern as triage/spec_writer TTY), not regex parsing:

```ts
appendEvent(sessionId, {
  event: 'resolve:approved',
  metadata: { decision: 'refine_local', reasoning: '...' },
});
```

#### `rewrite_plan` (renamed from `rewrite_spec`)

**Purpose**: Rewrite affected plans based on resolution.

**Behavior**:

1. Read decision from `resolve:approved` event (last resolve event)
2. Determine affected plans:
   - `refine_local`: only current plan
   - `regenerate_remaining`: current + all downstream (plans with higher ordinals)
3. Handler calls `snapshot plans {version}` before any edits
4. For each affected plan, invoke LLM with paths (not inlined content)
5. LLM edits working copies directly
6. Init new kloop run
7. Return `running`

**Decision semantics**:

| Decision               | Meaning                                | LLM behavior                                              |
| ---------------------- | -------------------------------------- | --------------------------------------------------------- |
| `refine_local`         | Plan implementation approach was wrong | Edit existing plan in-place, preserve structure and scope |
| `regenerate_remaining` | Cascading plan-level issue             | Generate fresh plans for all affected, may restructure    |

**Prompt structure**:

```
## Task
Rewrite plan-{ordinal} to address the resolution.

## Context Paths
- Task spec: {task_spec_path}
- Resolution event: {resolve_event_path}
- Previous plan: {plan_path}

Read these files to understand what needs to change.

## Snapshot
A snapshot has been created at plans-{snapshot_version}/
Edit the working copy at {plans_dir}/plan-{ordinal}.md

## Output
Write the updated plan directly to the working copy path above.
```

**Variables**:

- `{task_spec_path}` - path to task-spec.md
- `{resolve_event_path}` - path to resolve:approved event in logs
- `{plan_path}` - path to the plan being rewritten
- `{plans_dir}` - plans directory
- `{snapshot_version}` - version number from snapshot command
- `{ordinal}` - which plan number

**Handler behavior** (not user-configurable):

```ts
// Handler calls snapshot before LLM
const snapshotVersion = snapshotPlans(sessionId, version);

// Handler loops through affected plans
for (const ordinal of affectedOrdinals) {
  const result = await spawnPrint(binary, prompt, { ... });
  // LLM edits file directly via tools
}

// Re-init kloop
const kloopRunId = devloopInit(worktree, specPath, configPath);
ctx.kloopRunId = kloopRunId;
```

### Removed States

- `rewrite_spec` → renamed to `rewrite_plan`
- `amend_spec` → removed (cross-phase handled by runner, not a state)

### Simplified Decisions

| Decision               | Meaning                   | Affected Plans           |
| ---------------------- | ------------------------- | ------------------------ |
| `refine_local`         | Plan implementation wrong | Current plan only        |
| `regenerate_remaining` | Plan-level, cascading     | Current + all downstream |
| `revisit_spec`         | Spec constraint wrong     | Return to phase1, vN+1   |

Removed `patch_downstream` - redundant with `regenerate_remaining`.

---

## Part 2: Snapshot Command

### Command

```bash
kautopilot snapshot <spec|plans> <version> [--session <id>]
```

### Session Resolution

Session is optional. Resolution order:

1. `--session <id>` flag (explicit)
2. Environment variable `KAUTOPILOT_SESSION`
3. Look for `status.yaml` in current directory tree (walk up to git root)
4. Error if not found

### Behavior

**Spec snapshot**:

```bash
kautopilot snapshot spec 1
# Workflow:
# 1. Find next available number in snapshots/<session>/v1/
# 2. Copy artifacts/v1/task-spec.md → snapshots/<session>/v1/task-spec-{N}.md
# 3. Output snapshot info

# First snapshot:
kautopilot snapshot spec 1
# → Copies to snapshots/<session>/v1/task-spec-1.md
# → Outputs: SNAPSHOT_VERSION=1

# Second snapshot:
kautopilot snapshot spec 1
# → Copies to snapshots/<session>/v1/task-spec-2.md
# → Outputs: SNAPSHOT_VERSION=2
```

**Plans snapshot**:

```bash
kautopilot snapshot plans 1
# Workflow:
# 1. Find next available number in snapshots/<session>/v1/
# 2. Copy entire artifacts/v1/plans/ → snapshots/<session>/v1/plans-{N}/
# 3. Output snapshot info

# First snapshot:
kautopilot snapshot plans 1
# → Copies to snapshots/<session>/v1/plans-1/
# → Outputs: SNAPSHOT_VERSION=1

# Second snapshot:
kautopilot snapshot plans 1
# → Copies to snapshots/<session>/v1/plans-2/
# → Outputs: SNAPSHOT_VERSION=2
```

### Output Format

Machine-parseable output for LLM consumption:

```
SNAPSHOT_VERSION=2
SNAPSHOT_PATH=~/.kautopilot/<session>/snapshots/v1/plans-2/
WORKING_PATH=~/.kautopilot/<session>/artifacts/v1/plans/
```

### Storage Structure

```
~/.kautopilot/
├── <session-id>/
│   ├── artifacts/
│   │   └── v1/
│   │       ├── task-spec.md      # Working copy (LLM edits this)
│   │       └── plans/            # Working copy folder
│   │           ├── plan-1.md
│   │           └── plan-2.md
│   │
│   └── snapshots/
│       └── v1/
│           ├── task-spec-1.md    # First spec snapshot
│           ├── task-spec-2.md    # After conflict revision
│           ├── plans-1/          # First plans state
│           │   ├── plan-1.md
│           │   └── plan-2.md
│           └── plans-2/          # After rewrite
│               ├── plan-1.md
│               └── plan-2.md
```

**All snapshots live in `snapshots/`** - no in-place versioning in `artifacts/`.

### Versioning Strategy

| Artifact     | Versioning                     | Commands                      |
| ------------ | ------------------------------ | ----------------------------- |
| task-spec.md | Numbered backups in snapshots/ | `kautopilot snapshot spec 1`  |
| plans/       | Folder-based atomic snapshots  | `kautopilot snapshot plans 1` |

**Why folder for plans:**

- Plans are interdependent - rewriting one affects others
- Whole folder = one decision point state
- Simpler audit - "what did all plans look like at plans-2?"
- No partial state confusion

### Benefits

1. **Audit trail** - all versions preserved in `snapshots/`
2. **Simple workflow** - handler calls snapshot, LLM edits working copy
3. **No inline content** - paths only in prompts
4. **Automatic numbering** - no manual version tracking
5. **Session-aware** - works from any directory in repo

---

## Part 3: Prompt Changes for Spec/Plan Writers

### spec_writer

**Variables**:

- `{task_spec_path}` - working copy path: `artifacts/v{version}/task-spec.md`
- `{version}` - current version number
- `{triage_path}` - path to triage file
- `{ticket_path}` - path to ticket file
- **Conditionally** (when conflict-context.yaml exists):
  - `{previous_version}` - the failed version
  - `{conflict_description}` - what went wrong
  - `{failed_constraint}` - spec said X, reality says Y

**Prompt (in config)**:

```
## Context Paths
- Ticket: {ticket_path}
- Triage: {triage_path}
- Output: {task_spec_path}

## Task
Write a task spec for this kautopilot task.

## Instructions
1. Read the ticket and triage files
2. Explore the codebase thoroughly
3. Write the spec to {task_spec_path}
4. The spec should be concrete and testable

[If conflict context exists - INJECTED BY HANDLER]
## Conflict from Previous Version
The previous spec (v{previous_version}) failed during implementation:
- What went wrong: {conflict_description}
- Spec constraint that was invalid: {failed_constraint}

You must amend the spec to resolve this conflict. The constraint was wrong
because reality differs from what the spec assumed. Adjust the spec to match
reality while preserving what was correct.
```

**Handler behavior**:

```ts
// Check for conflict context
const conflictContext = readConflictContext(sessionId, version);
if (conflictContext) {
  // Inject conflict section into prompt
  prompt += buildConflictSection(conflictContext);
}

// Handler calls snapshot BEFORE TTY handoff
snapshotSpec(sessionId, version);

// TTY handoff - LLM edits working copy directly
await spawnTTY(binary, prompt, { ... });
```

### plan_writer

**Variables**:

- `{plans_dir}` - plans directory: `artifacts/v{version}/plans/`
- `{version}` - current version number
- `{spec_path}` - path to task spec
- `{triage_path}` - path to triage file
- **Conditionally** (when conflict-context.yaml exists):
  - `{previous_version}` - the failed version
  - `{failed_plan}` - which plan(s) failed
  - `{conflict_description}` - what went wrong

**Prompt (in config)**:

```
## Context Paths
- Spec: {spec_path}
- Triage: {triage_path}
- Output directory: {plans_dir}

## Task
Write implementation plans for this kautopilot task.

## Instructions
1. Read the spec and triage files
2. Plans should be vertically split (by domain/feature)
3. Each plan is one isolated, committable unit
4. Write plans to {plans_dir}/plan-1.md, plan-2.md, etc.

[If conflict context exists - INJECTED BY HANDLER]
## Conflict from Previous Plans
The previous plans (v{previous_version}) failed during implementation:
- Failed plan: {failed_plan}
- What went wrong: {conflict_description}

Adjust the affected plans. The previous approach didn't work because
reality differs from what was planned. Find an alternative approach.
```

**Handler behavior**:

```ts
// Check for conflict context
const conflictContext = readConflictContext(sessionId, version);
if (conflictContext) {
  prompt += buildConflictSection(conflictContext);
}

// Handler calls snapshot BEFORE TTY handoff
snapshotPlans(sessionId, version);

// TTY handoff
await spawnTTY(binary, prompt, { ... });
```

---

## Part 4: Conflict Context System

### Data Structure

```ts
interface ConflictContext {
  previousVersion: number; // The version that failed
  failedPlan?: string; // e.g., "plan-2"
  conflictDescription: string; // Human-readable summary
  kloopRunId?: string; // Reference to failed run
  failedConstraint?: string; // "spec said X, reality says Y"
  proposedResolution?: string; // What the user decided
}
```

### File Location

```
~/.kautopilot/<session>/artifacts/v{N}/conflict-context.yaml
```

### Writing (by resolve handler)

```ts
function writeConflictContext(sessionId: string, version: number, context: ConflictContext): void {
  const path = `${sessionDir(sessionId)}/artifacts/v${version}/conflict-context.yaml`;
  writeFileSync(path, YAML.stringify(context));
}
```

### Reading (by phase1 handlers)

```ts
function readConflictContext(sessionId: string, version: number): ConflictContext | null {
  const path = `${sessionDir(sessionId)}/artifacts/v${version}/conflict-context.yaml`;
  if (!existsSync(path)) return null;
  return YAML.parse(readFileSync(path, 'utf-8'));
}
```

### Lifecycle

1. **Written by** `resolve` handler when decision is `revisit_spec`
2. **Copied to** v{N+1} by runner when restarting phase1
3. **Read by** `spec_writer` and `plan_writer` handlers
4. **Cleared** after successful spec approval (or kept for audit)

---

## Part 5: Runner-Level Cross-Phase Handling

### State Machine Reconstruction

The state machine reconstructs from WAL events via `ensureStatus()`. The `status.yaml` contains:

- `phase`: current phase ('plan', 'implementation', 'polish')
- `version`: current version number
- `state`: current state name
- `stateStatus`: 'pending' | 'running' | 'completed' | 'failed'

Phase and version are set by `phase{N}:started` events. Cross-phase transitions must write proper events so reconstruction works correctly.

### Runner Signal Interception

```ts
// In src/phases/runner.ts

async function runPhase2(sessionId: string): Promise<void> {
  let state = 'setup_run';
  const ctx = await loadPhase2Context(sessionId);

  while (state !== 'done' && state !== 'phase3') {
    const result = await runPhase2State(state, ctx);

    // Cross-phase signal interception
    if (result === 'revisit_spec') {
      await handleRevisitSpec(sessionId, ctx);
      return; // Exit phase2 runner
    }

    state = result;
  }
}

async function handleRevisitSpec(sessionId: string, ctx: Phase2Context): Promise<void> {
  const oldVersion = ctx.version;
  const newVersion = oldVersion + 1;

  // 1. Mark v{oldVersion} as superseded (updates contract.json)
  supersedEpoch(sessionId, oldVersion, newVersion);

  // 2. Write version superseded event for audit
  appendEvent(sessionId, {
    ts: new Date().toISOString(),
    event: 'version:superseded',
    version: oldVersion,
    metadata: {
      supersededBy: newVersion,
      reason: 'revisit_spec',
      conflictDescription: ctx.conflictDescription,
    },
  });

  // 3. Write phase2 completion event
  appendEvent(sessionId, {
    ts: new Date().toISOString(),
    event: 'phase2:completed',
    version: oldVersion,
    metadata: { reason: 'revisit_spec' },
  });

  // 4. Create new version directory
  const newVersionDir = `${sessionDir(sessionId)}/artifacts/v${newVersion}`;
  mkdirSync(newVersionDir, { recursive: true });

  // 5. Copy conflict context to new version
  const oldConflictPath = `${sessionDir(sessionId)}/artifacts/v${oldVersion}/conflict-context.yaml`;
  if (existsSync(oldConflictPath)) {
    const context = YAML.parse(readFileSync(oldConflictPath, 'utf-8'));
    context.previousVersion = oldVersion;
    writeFileSync(`${newVersionDir}/conflict-context.yaml`, YAML.stringify(context));
  }

  // 6. Write phase1 start event with new version
  // This triggers applyEvent to set phase='plan' and version=newVersion
  appendEvent(sessionId, {
    ts: new Date().toISOString(),
    event: 'phase1:started',
    version: newVersion,
    metadata: {
      previousVersion: oldVersion,
      conflictContext: true,
    },
  });

  // 7. Reconstruct status from WAL (includes new events)
  const status = ensureStatus(sessionId);
  // Now status.phase === 'plan' and status.version === newVersion

  // 8. Start phase1 runner
  await runPhase1(sessionId);
}
```

### Event Flow for Cross-Phase

```
Before:
  status.yaml: { phase: 'implementation', version: 1, ... }
  contract.json (v1): { version: 1, ... }

Events written (in order):
  1. version:superseded (v1)  → audit trail for v1's closure
  2. phase2:completed (v1)   → marks phase2 done
  3. phase1:started (v2)     → applyEvent sets phase='plan', v=2

Side effects:
  - contract.json (v1) updated: { supersededBy: 2, supersededAt: '...' }
  - v2/ directory created with conflict-context.yaml

After ensureStatus():
  status.yaml: { phase: 'plan', version: 2, ... }

Phase1 runner starts:
  - Reads status.yaml
  - Loads Phase1Context with version=2
  - phase1 handlers check for conflict-context.yaml in v2
```

---

## Part 6: Implementation Checklist

### New Files

- `src/cli/snapshot.ts` - snapshot command
- `src/core/snapshot.ts` - snapshot logic (snapshotSpec, snapshotPlans)
- `src/core/conflict-context.ts` - read/write conflict context

### Modified Files

- `src/phases/phase2/resolve.ts` - enhanced TTY with analysis/proposal, write conflict context
- `src/phases/phase2/rewrite-spec.ts` → `src/phases/phase2/rewrite-plan.ts` - renamed
- `src/phases/runner.ts` - add cross-phase signal handling for `revisit_spec`
- `src/phases/machine.ts` - update state names, add `'revisit_spec'` return
- `src/core/types.ts` - add `ConflictContext` interface, update prompts
- `src/phases/phase1/write-spec.ts` - read conflict context, inject into prompt
- `src/phases/phase1/write-plans.ts` - read conflict context, inject into prompt

### Prompt Changes (in `src/core/types.ts` DEFAULT_CONFIG)

#### `resolve` (phase2) - Major Rewrite

**Current variables**: `{plan}`, `{spec}`, `{taskSpec}`, `{reason}`, `{attempt}`
**New variables**: `{task_spec_path}`, `{plan_path}`, `{plans_dir}`, `{kloop_evidence}`

**Current prompt** (to replace):

```
Analyze the conflict or failure and discuss resolution options with the user.

## What is a Conflict?

A conflict occurs when the spec defines something that seems plausible, but during implementation we discover it's not possible. This is called "the devil is in the details" — the spec looked reasonable on paper, but reality says otherwise.

**Example**: The spec says "don't touch source code, add tests till 100% coverage." This seems reasonable until implementation reveals unreachable dead code that MUST be removed to achieve 100% coverage. Removing dead code VIOLATES the spec constraint, creating a conflict.

## Where to Look

1. **Plan contents** — read the current plan at the path provided
2. **Task spec** — read the constraints and requirements at the path provided
3. **Kloop evidence** — the implementation log shows exactly where things went wrong
4. **Source code** — the actual codebase state in the worktree

## Resolution Options

When you identify a conflict, consider:
- **Root cause** — what assumption in the spec turned out to be wrong?
- **Alternative approaches** — is there another way to satisfy the intent?
- **Scope reduction** — can we solve a smaller problem that's still valuable?

Discuss with the user until you have a clear resolution. Document your approach in the resolution file.
```

**New prompt**:

```
## Context Paths
- Task spec: {task_spec_path}
- Current plan: {plan_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent.

## Kloop Evidence

{kloop_evidence}

## Analysis

Based on the evidence above:
1. What specifically went wrong?
2. Is this a plan implementation issue or a spec constraint issue?
3. How many plans are affected? (current only? downstream too?)

## Proposed Decision

I propose: [refine_local | regenerate_remaining | revisit_spec]

Reasoning: [explanation]

[If user disagrees, clarify and re-propose]

When ready, log your approval event to proceed.
```

---

#### `rewrite_spec` → `rewrite_plan` (phase2) - Rename + Rewrite

**Rename**: `agents.phase2.rewrite_spec` → `agents.phase2.rewrite_plan`

**New variables**: `{task_spec_path}`, `{resolve_event_path}`, `{plan_path}`, `{plans_dir}`, `{snapshot_version}`, `{ordinal}`

**Current prompt** (to replace):

```
Rewrite the working spec to address the resolution.
Preserve what was working. Only change what needs to change.
Output ONLY the rewritten spec in markdown format.
```

**New prompt**:

```
## Task
Rewrite plan-{ordinal} to address the resolution.

## Context Paths
- Task spec: {task_spec_path}
- Resolution event: {resolve_event_path}
- Previous plan: {plan_path}

Read these files to understand what needs to change.

## Snapshot
A snapshot has been created at plans-{snapshot_version}/
Edit the working copy at {plans_dir}/plan-{ordinal}.md

## Output
Write the updated plan directly to the working copy path above.
```

---

#### `spec_writer` (phase1) - Variable Alignment

**Current variables**: `{ticket}`, `{triage}`
**New variables**: `{ticket_path}`, `{triage_path}`, `{task_spec_path}`, `{version}`

**Prompt stays similar, just variable renames**. Conflict context injection handled by handler, not prompt change.

---

#### `plan_writer` (phase1) - Variable Alignment

**Current variables**: `{spec}`, `{triage}`
**New variables**: `{spec_path}`, `{triage_path}`, `{plans_dir}`, `{version}`

**Prompt stays similar, just variable renames**. Conflict context injection handled by handler, not prompt change.

---

#### Also update in `types.ts`

- Remove `patch_downstream` from `RewriteDecision` type (already done)
- Remove `patch_downstream` from `resolve.ts` VALID_REWRITE_DECISIONS (already done)

### Events

```ts
// In resolve (TTY) - after user approval
appendEvent(sessionId, {
  event: 'resolve:approved',
  metadata: {
    decision: 'refine_local' | 'regenerate_remaining' | 'revisit_spec',
    reasoning: '...',
    affectedPlans: ['plan-2'], // if applicable
  },
});

// In runner (cross-phase handling)
appendEvent(sessionId, {
  event: 'revisit_spec:started',
  metadata: {
    previousVersion: 1,
    newVersion: 2,
  },
});

// In snapshot command
appendEvent(sessionId, {
  event: 'snapshot:created',
  metadata: {
    type: 'plans',
    version: 1,
    snapshotVersion: 2,
    path: 'snapshots/v1/plans-2/',
  },
});
```

---

## Part 7: Acceptance Criteria

### Functional

- [ ] `kautopilot snapshot spec 1` creates backup in snapshots/v1/
- [ ] `kautopilot snapshot plans 1` backs up entire plans folder
- [ ] Snapshot numbering auto-increments
- [ ] Session resolution works without --session flag (via status.yaml)
- [ ] `resolve` shows kloop evidence and analyzes conflict
- [ ] `resolve` proposes decision with reasoning
- [ ] `resolve` clarifies with user if they disagree
- [ ] User approval via event (not regex parsing)
- [ ] `refine_local` rewrites only current plan
- [ ] `regenerate_remaining` rewrites current + downstream plans
- [ ] `revisit_spec` writes conflict-context.yaml
- [ ] `revisit_spec` signal triggers runner cross-phase handling
- [ ] Runner creates vN+1 directory and copies conflict context
- [ ] Runner restarts phase1 with new version
- [ ] `spec_writer` reads conflict context and injects into prompt
- [ ] `plan_writer` reads conflict context and injects into prompt
- [ ] All prompts use paths, not inlined content
- [ ] Snapshot called by handlers before LLM edits

### Non-Functional

- [ ] Snapshot command completes in <100ms
- [ ] Snapshot storage uses copy (no dedup needed initially)
- [ ] LLM prompts are 50%+ smaller (paths vs inline)
- [ ] Audit trail is complete and human-readable
- [ ] Cross-phase mechanics clearly documented

---

## Part 8: Open Questions

1. **Garbage collection** - should old snapshots be cleaned up?
   - Proposed: keep last 5 per artifact type, add `kautopilot gc` command later

2. **Conflict context cleanup** - when to delete conflict-context.yaml?
   - Proposed: keep for audit, never auto-delete

3. **Multiple conflicts** - what if v2 also fails and goes to v3?
   - Proposed: each version has its own conflict-context.yaml, chain is preserved

4. **Partial plan completion** - if plan-1 is committed but plan-2 fails during `regenerate_remaining`, does plan-1 stay committed?
   - Proposed: yes, already-committed plans are not affected, only pending plans regenerated

---

## Part 9: Out of Scope

- Snapshot diff/merge tools
- Snapshot restoration UI
- Conflict pattern library (future: autodetect common conflicts)
- Interactive snapshot browsing
- Multi-session snapshot management
