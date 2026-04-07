# Spec: Conflict Resolution & Versioned Artifacts

## Summary

Restructure conflict resolution to properly route back to phase1, add versioned artifact snapshots for audit trail, and simplify prompts for spec/plan writers.

---

## Part 1: Conflict Resolution & Feedback

### Two Feedback Paths

Both paths lead to the same outcome: new epoch v{N+1} with feedback.md.

| Context                     | Phase   | Trigger                              | TTY        |
| --------------------------- | ------- | ------------------------------------ | ---------- |
| **Implementation conflict** | Phase 2 | kloop failure / max_situations       | `resolve`  |
| **PR feedback**             | Phase 3 | User wants changes after merge-ready | `feedback` |

### Flow

```
Phase 2: running → conflict → resolve (TTY)
                              ↓
                              resolve:
                              1. Show kloop evidence
                              2. Discuss with user
                              3. Write feedback.md
                              4. Return 'revisit_spec' signal
                              ↓
                              Runner: create v{N+1}, start phase1

Phase 3: poll → merge-ready → feedback_check
                                ↓
                                User chooses "I have feedback"
                                ↓
                                feedback (TTY):
                                1. Review PR state with user
                                2. Discuss what needs improvement
                                3. Write feedback.md
                                4. Return 'revisit_spec' signal
                                ↓
                                Runner: create v{N+1}, start phase1
```

### Cross-Phase Mechanics

**Problem:** Phase state machines can't transition to other phases. Each phase has its own context type and runner.

**Solution:** Return special signals that the **runner** intercepts, not the state machine.

```ts
// In phase2/resolve.ts
// After discussion with user, write feedback
writeFileSync(snapshotPath(sessionId, version, 'feedback.md'), feedbackText);
return 'revisit_spec'; // Runner intercepts this

// In runner (src/phases/runner.ts)
const result = await runPhase2State(state, ctx);
if (result === 'revisit_spec') {
  await handleRevisitSpec(sessionId, ctx);
  return; // Exit phase2 runner
}
```

### `resolve` (phase2) - Simplified TTY

**Purpose**: Analyze conflict with user, write feedback for next iteration.

**Behavior**:

1. Load kloop evidence via `kloop describe`
2. Load paths (not inlined content):
   - Latest spec: `~/.kautopilot/<session>/artifacts/v<N>/task-spec-{latest}.md`
   - Current plan: from plans directory
3. Discuss with user what went wrong and how to fix
4. Write `feedback.md` to `artifacts/v<N>/feedback.md`
5. Return `'revisit_spec'` signal

**Prompt structure**:

```
## Context Paths
- Task spec: {task_spec_path}
- Current plan: {plan_path}
- Plans directory: {plans_dir}

Read these files to understand the original intent.

## Kloop Evidence

{kloop_evidence}

## Discussion

Discuss with the user:
1. What specifically went wrong?
2. Is this a plan implementation issue or a spec constraint issue?
3. What should change in the spec to address this?

## Feedback

When ready, write the feedback to {feedback_path}
The feedback will be used to guide the next iteration.

After writing feedback, return the revisit_spec signal.
```

**Variables**:

- `{task_spec_path}` - latest versioned spec (from `findLatestSpecPath`)
- `{plan_path}` - current plan
- `{plans_dir}` - plans directory
- `{kloop_evidence}` - output from `kloop describe`
- `{feedback_path}` - `artifacts/v{N}/feedback.md`

### `feedback` (phase3) - TTY for PR Feedback

**Purpose**: Collect feedback after PR is merge-ready, write for next iteration.

**Behavior**:

1. Load PR state (URL, checks, threads)
2. Load paths (not inlined content):
   - Latest spec: `~/.kautopilot/<session>/artifacts/v<N>/task-spec-{latest}.md`
   - Plans directory: `~/.kautopilot/<session>/artifacts/v<N>/plans-{latest}/`
3. Review PR with user - what needs improvement
4. Write `feedback.md` to `artifacts/v<N>/feedback.md`
5. Return `'revisit_spec'` signal

**Prompt structure**:

```
## Context Paths
- Task spec: {task_spec_path}
- Plans: {plans_dir}

Read these files to understand the original intent.

## PR State
- URL: {pr_url}
- Checks status: {checks_status}
- Open threads: {thread_count}

## Discussion

Discuss with the user:
1. What about the PR needs improvement?
2. Is this an implementation issue or a spec issue?
3. What should change in the spec to address this?

## Feedback

When ready, write the feedback to {feedback_path}
The feedback will be used to guide the next iteration.

After writing feedback, return the revisit_spec signal.
```

**Variables**:

- `{task_spec_path}` - latest versioned spec
- `{plans_dir}` - latest plans directory
- `{pr_url}` - PR URL
- `{checks_status}` - summary of CI checks
- `{thread_count}` - number of open review threads
- `{feedback_path}` - `artifacts/v{N}/feedback.md`

### Removed States

- `rewrite_spec` → removed (revisit_spec goes directly to phase1)
- `amend_spec` → removed

### Simplified Decisions

Only one decision: **revisit_spec** - go back to phase1 with feedback.

Removed `refine_local`, `regenerate_remaining`, `patch_downstream` - these are now handled by the natural iteration flow: write feedback → phase1 rewrites spec → phase1 rewrites plans → kloop runs.

---

## Part 2: Versioned Artifacts

### Core Concept

**Repo has working copies. Global has snapshots.**

- LLM edits working copies in repo (clean, single file per artifact)
- After each edit cycle, handler calls snapshot command
- Snapshots are stored in `~/.kautopilot/<session>/artifacts/v<N>/` with version numbers

### Repo Structure (Working Copies)

```
<repo>/
└── spec/
    └── <ticket-id>/
        └── v<N>/
            ├── task-spec.md       # Working copy (LLM edits this)
            ├── triage.md           # Not versioned (doesn't change)
            └── plans/
                ├── plan-1.md       # Working copies
                ├── plan-2.md
                └── plan-3.md
```

### Global Structure (Snapshots)

```
~/.kautopilot/
├── <session-id>/
│   ├── artifacts/
│   │   ├── ticket.md              # Session-level (not versioned)
│   │   └── v1/
│   │       ├── task-spec-1.md     # First write
│   │       ├── task-spec-2.md     # After first feedback round
│   │       ├── task-spec-3.md     # After second feedback round
│   │       ├── plans-1/           # First write
│   │       │   ├── plan-1.md
│   │       │   └── plan-2.md
│   │       ├── plans-2/           # After rewrite
│   │       │   ├── plan-1.md
│   │       │   └── plan-2.md
│   │       ├── feedback.md        # Written by resolve TTY
│   │       └── contract.json      # Epoch metadata
│   ├── v2/                        # New epoch after revisit_spec
│   │   ├── task-spec-1.md         # Full rewrite addressing feedback
│   │   ├── plans-1/               # Incremental plans (only remaining work)
│   │   │   └── plan-1.md
│   │   └── contract.json          # (no feedback.md here - references v1/feedback.md)
│   ├── config.yaml
│   ├── log.jsonl
│   └── status.yaml
```

### Versioning Semantics

**Two numberings:**

1. **Epoch version (vN)** - `artifacts/v1/`, `artifacts/v2/`
   - Incremented on `revisit_spec` (cross-phase reset)
   - Each epoch is a fresh attempt at the ticket

2. **Snapshot version (-N)** - `task-spec-1.md`, `task-spec-2.md`
   - Incremented within each epoch
   - Per-epoch: each epoch starts fresh at 1

**Example evolution:**

```
v1/
├── task-spec-1.md     # Initial spec
├── task-spec-2.md     # After user feedback in spec_writer
├── plans-1/           # Initial plans
├── plans-2/           # After user feedback in plan_writer
├── feedback.md        # From resolve (conflict found) → caused v2
└── contract.json

v2/                    # New epoch after revisit_spec
├── task-spec-1.md     # Fresh spec addressing v1/feedback.md
├── plans-1/           # Incremental plans (remaining work only)
├── feedback.md        # From resolve (if v2 also fails) → caused v3
└── contract.json

v3/                    # If v2 also had a conflict
├── task-spec-1.md     # Fresh spec addressing v2/feedback.md
├── plans-1/           # Incremental plans from v2's state
└── contract.json
```

**Feedback reference chain:**

- `v{N}/spec_writer` reads `v{N-1}/feedback.md` (reason we're at v{N})
- `v{N}/resolve` writes `v{N}/feedback.md` (why v{N} failed)
- Each epoch's feedback.md is preserved, not copied

---

## Part 3: Snapshot Command

### Command

```bash
kautopilot snapshot <spec|plans> <epoch-version> [--session <id>]
```

**Purpose**: Called by LLM within TTY session after each edit cycle. Creates versioned snapshot of working copies.

### Behavior

**Spec snapshot:**

```bash
# LLM calls this after writing/editing task-spec.md
kautopilot snapshot spec 1
# 1. Find next available number in artifacts/v1/
# 2. Copy repo: spec/<ticket>/v1/task-spec.md → artifacts/v1/task-spec-{N}.md
# 3. Output version info for LLM to display to user

# Output:
SNAPSHOT_VERSION=2
SNAPSHOT_PATH=~/.kautopilot/<session>/artifacts/v1/task-spec-2.md
```

**Plans snapshot:**

```bash
# LLM calls this after writing/editing plans
kautopilot snapshot plans 1
# 1. Find next available number in artifacts/v1/
# 2. Copy entire folder: spec/<ticket>/v1/plans/ → artifacts/v1/plans-{N}/
# 3. Output version info

# Output:
SNAPSHOT_VERSION=2
SNAPSHOT_PATH=~/.kautopilot/<session>/artifacts/v1/plans-2/
```

### Session Resolution

Session is optional. Resolution order:

1. `--session <id>` flag (explicit)
2. Environment variable `KAUTOPILOT_SESSION`
3. Look for `status.yaml` in current directory tree (walk up to git root)
4. Error if not found

### Finding Next Version

```ts
function findNextSpecVersion(sessionId: string, epochVersion: number): number {
  const artifactDir = `${sessionDir(sessionId)}/artifacts/v${epochVersion}`;
  const files = readdirSync(artifactDir);
  const versions = files
    .filter(f => f.match(/^task-spec-(\d+)\.md$/))
    .map(f => parseInt(f.match(/^task-spec-(\d+)\.md$/)![1]));
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

function findLatestSpecPath(sessionId: string, epochVersion: number): string | null {
  const next = findNextSpecVersion(sessionId, epochVersion);
  const current = next - 1;
  if (current === 0) return null;
  return `${sessionDir(sessionId)}/artifacts/v${epochVersion}/task-spec-${current}.md`;
}
```

---

## Part 4: Handler Integration

### spec_writer Flow

```
TTY starts with prompt:
- Output path: spec/<ticket>/v<N>/task-spec.md (repo working copy)
- Feedback path: artifacts/v{N-1}/feedback.md (if this is a new epoch from revisit_spec)

Within TTY loop:
1. LLM reads previous spec (if exists) and/or feedback
2. LLM writes to task-spec.md
3. LLM calls: kautopilot snapshot spec <epoch>
   → Creates: artifacts/v<N>/task-spec-{next}.md
4. LLM asks user for feedback in TTY
5. User provides feedback OR approves
6. If feedback: loop back to step 2 (edit → snapshot → ask)
7. If approved: LLM exits TTY

Result: Multiple snapshots created per feedback cycle (task-spec-1.md, task-spec-2.md, ...)
```

**Spec vs Plans Semantics:**

| Artifact    | Type                          | On revisit_spec (vN → vN+1)                                           |
| ----------- | ----------------------------- | --------------------------------------------------------------------- |
| `task-spec` | Declarative (what we want)    | **FULL reconstruction** - rewrite entire spec with feedback addressed |
| `plans`     | Imperative (how to get there) | **INCREMENTAL** - only remaining work, LLM assesses code state        |

### plan_writer Flow

```
TTY starts with prompt:
- Output dir: spec/<ticket>/v<N>/plans/ (repo working copy)
- Spec path: artifacts/v<N>/task-spec-{latest}.md
- Feedback path: artifacts/v{N-1}/feedback.md (if new epoch from revisit_spec)
- Previous plans: artifacts/v{N-1}/plans-{latest}/ (if new epoch, for reference)

Within TTY loop:
1. LLM reads spec, feedback, previous plans, and checks codebase state
2. LLM writes plans to spec/<ticket>/v<N>/plans/
3. LLM calls: kautopilot snapshot plans <epoch>
   → Creates: artifacts/v<N>/plans-{next}/
4. LLM asks user for feedback in TTY
5. User provides feedback OR approves
6. If feedback: loop back to step 2 (edit → snapshot → ask)
7. If approved: LLM exits TTY

Result: Multiple plan snapshots created per feedback cycle (plans-1/, plans-2/, ...)
```

**After revisit_spec (new epoch):**

When starting v{N} after a conflict in v{N-1}:

- LLM checks actual codebase state (git history, what's committed)
- LLM reads v{N-1}/feedback.md to understand what went wrong
- LLM writes only plans for remaining work (incremental, not full rewrite)

**Key insight for plans after revisit_spec:**

The LLM does NOT trust metadata like `contract.json` or `manifest.json`. It grounds itself in actual code state:

```
Inputs for v2 plans (within TTY):
1. Actual codebase state (git diff, what's committed)
2. v2/task-spec-{latest}.md (new spec - just written in spec_writer TTY)
3. v1/feedback.md (what went wrong - from previous epoch's resolve)
4. v1/plans-{latest}/ (reference - what was attempted)

LLM decides:
- What's already done (check git history, code state)
- What needs changing (from feedback)
- What's new (from spec changes)

Output:
- Plans for remaining work only (incremental)
```

**Prompt mechanics for spec_writer and plan_writer:**

The snapshot command is called by the LLM as a compulsory step within the existing TTY approval flow:

```
## Workflow (extends existing approval mechanics)

1. Read the context files listed above
2. Write/edit the output file(s)
3. Run snapshot:
   - For spec: kautopilot snapshot spec {epoch}
   - For plans: kautopilot snapshot plans {epoch}
4. Present your work to the user
5. Ask for feedback
6. If feedback provided:
   - Incorporate feedback
   - Edit the files again
   - Run snapshot again (version increments automatically)
   - Loop back to step 4
7. When user approves:
   - Log approval event (existing mechanic)
   - Exit TTY
```

**Existing mechanics preserved:**

- Approval event logging (`appendEvent` with approval metadata)
- TTY handoff via `spawnTTYWithTurnTracking`
- Step recording (`writeStepInit`)

**New mechanic added:**

- Snapshot call is compulsory after each edit cycle (step 3)
- Snapshot version auto-increments within epoch

**Variables for Prompts**

**spec_writer:**

- `{task_spec_working_path}` - `spec/<ticket>/v<N>/task-spec.md` (repo)
- `{task_spec_snapshot_path}` - `artifacts/v<N>/task-spec-{next}.md` (will be created)
- `{previous_spec_path}` - `artifacts/v<N>/task-spec-{prev}.md` (if exists within same epoch)
- `{previous_epoch_feedback_path}` - `artifacts/v{N-1}/feedback.md` (if new epoch from revisit_spec)
- `{triage_path}` - `spec/<ticket>/v<N>/triage.md`
- `{ticket_path}` - `artifacts/ticket.md`

**plan_writer:**

- `{plans_working_dir}` - `spec/<ticket>/v<N>/plans/` (repo)
- `{plans_snapshot_dir}` - `artifacts/v<N>/plans-{next}/` (will be created)
- `{previous_plans_dir}` - `artifacts/v<N>/plans-{prev}/` (if exists within same epoch)
- `{spec_path}` - `artifacts/v<N>/task-spec-{latest}.md`
- `{previous_epoch_feedback_path}` - `artifacts/v{N-1}/feedback.md` (if new epoch from revisit_spec)
- `{previous_epoch_plans_dir}` - `artifacts/v{N-1}/plans-{latest}/` (if new epoch, for reference)
- `{triage_path}` - `spec/<ticket>/v<N>/triage.md`

**resolve:**

- `{task_spec_path}` - `artifacts/v<N>/task-spec-{latest}.md`
- `{plan_path}` - current plan path
- `{plans_dir}` - plans directory
- `{kloop_evidence}` - from `kloop describe`
- `{feedback_path}` - `artifacts/v<N>/feedback.md` (to write)

**feedback (phase3):**

- `{task_spec_path}` - `artifacts/v<N>/task-spec-{latest}.md`
- `{plans_dir}` - `artifacts/v<N>/plans-{latest}`
- `{pr_url}` - PR URL
- `{checks_status}` - summary of CI checks status
- `{thread_count}` - number of open review threads
- `{feedback_path}` - `artifacts/v<N>/feedback.md` (to write)

---

## Part 5: Runner-Level Cross-Phase Handling

### State Machine Reconstruction

The state machine reconstructs from WAL events via `ensureStatus()`. Phase and version are set by `phase{N}:started` events.

### Runner Signal Interception

```ts
async function runPhase2(sessionId: string): Promise<void> {
  let state = 'setup_run';
  const ctx = await loadPhase2Context(sessionId);

  while (state !== 'done' && state !== 'phase3') {
    const result = await runPhase2State(state, ctx);

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

  // 1. Mark v{oldVersion} as superseded
  supersedEpoch(sessionId, oldVersion, newVersion);

  // 2. Write version superseded event
  appendEvent(sessionId, {
    event: 'version:superseded',
    version: oldVersion,
    metadata: { supersededBy: newVersion, reason: 'revisit_spec' },
  });

  // 3. Write phase2 completion event
  appendEvent(sessionId, {
    event: 'phase2:completed',
    version: oldVersion,
    metadata: { reason: 'revisit_spec' },
  });

  // 4. Create new epoch directory
  const newVersionDir = `${sessionDir(sessionId)}/artifacts/v${newVersion}`;
  mkdirSync(newVersionDir, { recursive: true });

  // NOTE: Do NOT copy feedback.md - each epoch has its own
  // v{N} reads v{N-1}/feedback.md, v{N} writes v{N}/feedback.md

  // 5. Write phase1 start event with new version
  appendEvent(sessionId, {
    event: 'phase1:started',
    version: newVersion,
    metadata: { previousVersion: oldVersion, reason: 'revisit_spec' },
  });

  // 6. Reconstruct status
  ensureStatus(sessionId);

  // 7. Start phase1 runner
  await runPhase1(sessionId);
}
```

---

## Part 6: Implementation Checklist

### New Files

- `src/cli/snapshot.ts` - snapshot CLI command
- `src/core/artifact-versioning.ts` - `findNextSpecVersion`, `findLatestSpecPath`, `findNextPlansVersion`, `findLatestPlansPath`

### Modified Files

- `src/phases/phase2/resolve.ts` - simplified TTY, write feedback.md, return revisit_spec
- `src/phases/phase3/feedback.ts` - TTY handoff, write feedback.md, return revisit_spec
- `src/phases/runner.ts` - add `revisit_spec` signal handling for both phase2 and phase3
- `src/core/types.ts` - update resolve prompt, add snapshot workflow to spec_writer/plan_writer prompts
- `src/phases/phase1/write-spec.ts` - inject snapshot workflow into prompt, handle feedback.md reference
- `src/phases/phase1/write-plans.ts` - inject snapshot workflow into prompt, handle feedback.md reference, previous epoch plans
- Delete: `src/phases/phase2/rewrite-spec.ts` (removed state)

**Note: Existing mechanics preserved:**

- Approval event logging (`appendEvent` with approval metadata)
- TTY handoff via `spawnTTYWithTurnTracking`
- Step recording (`writeStepInit`)
- All existing prompt variables and context building
- Session resolution from `status.yaml`

**Only additions:**

- Snapshot CLI command (new)
- Snapshot workflow injected into prompts (compulsory step)
- Version lookup helpers (new)
- feedback.md reference for new epochs (new variable)

### Events

```ts
// In resolve - after writing feedback
appendEvent(sessionId, {
  event: 'resolve:completed',
  version,
  metadata: { feedbackWritten: true },
});

// In snapshot command
appendEvent(sessionId, {
  event: 'snapshot:created',
  metadata: {
    type: 'spec' | 'plans',
    epochVersion: 1,
    snapshotVersion: 2,
    path: 'artifacts/v1/task-spec-2.md',
  },
});

// In runner (cross-phase)
appendEvent(sessionId, {
  event: 'version:superseded',
  version: 1,
  metadata: { supersededBy: 2, reason: 'revisit_spec' },
});
```

---

## Part 7: Acceptance Criteria

### Functional

- [ ] Repo working copies: `spec/<ticket>/v<N>/task-spec.md`, `plans/plan-*.md`
- [ ] Global snapshots: `artifacts/v<N>/task-spec-{N}.md`, `plans-{N}/`
- [ ] `kautopilot snapshot spec <epoch>` copies repo spec to global
- [ ] `kautopilot snapshot plans <epoch>` copies repo plans folder to global
- [ ] Snapshot numbering per-epoch (each epoch starts at 1)
- [ ] Session resolution works without --session flag
- [ ] Snapshot command called by LLM within TTY (after each edit cycle)
- [ ] Multiple snapshots per TTY session (one per feedback round)
- [ ] `resolve` writes `feedback.md` to current epoch (`v<N>/feedback.md`)
- [ ] `resolve` returns `revisit_spec` signal
- [ ] `feedback` (phase3) uses TTY with its own prompt
- [ ] `feedback` writes `feedback.md` to current epoch (`v<N>/feedback.md`)
- [ ] `feedback` returns `revisit_spec` signal
- [ ] Runner handles `revisit_spec` from both phase2 and phase3
- [ ] Runner creates v{N+1} directory (does NOT copy feedback.md)
- [ ] `spec_writer` reads `v{N-1}/feedback.md` when starting new epoch
- [ ] `plan_writer` at new epoch checks codebase, writes incremental plans
- [ ] Each epoch's `feedback.md` preserved (not overwritten)
- [ ] LLM doesn't trust metadata - grounds in actual code state

### Non-Functional

- [ ] `bun run check` passes with zero errors
- [ ] Snapshot command completes in <100ms
- [ ] All prompts use paths, not inlined content
- [ ] Audit trail complete in artifacts/
- [ ] Cross-phase mechanics documented

---

## Part 8: Open Questions

1. **Garbage collection** - should old snapshots be cleaned up?
   - Proposed: keep last 5 per artifact type per epoch

2. **Multiple conflicts** - what if v2 also fails?
   - **Solved**: Each epoch writes its own `v{N}/feedback.md`. Chain preserved: v3 reads v2/feedback.md, v2 reads v1/feedback.md.

---

## Part 9: Out of Scope

- Artifact diff/merge tools
- Artifact restoration UI
- Interactive artifact browsing
- Multi-session management
