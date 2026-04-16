# Spec: Scratch Artifact Protocol (Sandboxed Agent Output)

## Summary

Add a `.kloop/scratch/` directory inside the agent's CWD as the single output channel for all agents (regardless of harness). After each agent step completes, the kloop host runner promotes scratch files to the global session directory (`~/.kloop/{runId}/...`).

This unifies output across all harnesses — Claude (permission-based), Codex (hard sandbox), Gemini, OpenCode — without requiring agents to write outside their CWD.

## Motivation

- **Codex sandbox**: `codex exec --full-auto` restricts filesystem writes to the workspace directory. Agents cannot write to `~/.kloop/` directly. Currently Codex agents fail silently when instructed to write verdicts, reviews, evidence, etc. to global paths.
- **Unified output contract**: All harnesses should use the same output mechanism regardless of sandbox model. A local scratch dir works for Claude (no restrictions), Codex (workspace-only), Gemini, and OpenCode.
- **Host-side control**: The runner already orchestrates agent lifecycle. Promoting files from scratch to global storage is a natural extension — it gives the runner visibility into what agents produce and enables validation before promotion.
- **No IPC complexity**: Avoids Unix sockets, HTTP daemons, or stdout protocols. Files in CWD are the simplest possible IPC mechanism.

## Scope

In scope:

- `.kloop/scratch/` directory layout and file naming conventions
- Per-artifact metadata format (JSON frontmatter or companion `.meta.json`)
- Host-side promotion logic in `AgentRunner` (after each agent step)
- Prompt updates for all agent roles to write to scratch paths
- Cleanup of scratch files after successful promotion
- Graceful handling when scratch files are missing (non-sandboxed agents may write directly)

Out of scope:

- Implementing `kloop internal` as a standalone CLI subcommand (the promotion is done by the runner, not by agents calling a command)
- Changing how agents read input (they still read from global `~/.kloop/` paths — reading is not restricted by Codex sandbox)
- Changing the global session directory structure
- Changing event types or status materialization

## Design Principles

1. **Write local, promote global**: Agents write to `.kloop/scratch/` in their CWD. The host runner copies to `~/.kloop/{runId}/...`. Agents never touch global paths for output.
2. **Metadata-driven routing**: Each scratch file includes metadata (run ID, loop, role, index) so the runner knows exactly where to promote it without relying on directory structure or naming conventions.
3. **Promote-then-wipe lifecycle**: At every loop boundary (and on signal interrupts), the runner promotes valid scratch files and then deletes the entire `.kloop/` folder in CWD for a clean slate. No stale-file detection logic needed — every loop starts fresh.
4. **Signal-safe promotion**: On SIGTERM/SIGINT, the runner force-promotes pending scratch files before exiting. If the process is hard-killed, orphaned scratch files are recovered on the next loop start or session start.
5. **Optional for non-sandboxed agents**: Claude and Gemini agents can continue writing directly to global paths as a fallback. The runner checks scratch first, then falls back to existing behavior.
6. **No behavioral change for existing harnesses**: Claude and Gemini prompts can be updated to use scratch paths, but the runner must also support the legacy direct-write path during the transition period.

## Scratch Directory Layout

```
.kloop/scratch/
├── verdict-reviewer-0.json          # Reviewer verdict
├── verdict-reviewer-0.json.meta     # Promotion metadata
├── review-reviewer-0.md             # Review content
├── review-reviewer-0.md.meta        # Promotion metadata
├── evidence-self-review.md          # Implementer evidence
├── evidence-self-review.md.meta     # Promotion metadata
├── evidence-addressed-reviews.md    # Implementer evidence
├── evidence-addressed-reviews.md.meta
├── learnings.md                     # Implementer learnings
├── learnings.md.meta
├── synthesis-review-summary.md      # Synthesizer output
├── synthesis-review-summary.md.meta
├── checkpoint-result.json           # Checkpointer output
├── checkpoint-result.json.meta
├── conflict.md                      # Checkpointer conflict analysis
├── conflict.md.meta
├── verdict-verifier-0.json          # Verifier verdict
├── verdict-verifier-0.json.meta
```

## Scratch File Naming Convention

```
{artifactType}-{qualifier}.{ext}
```

| Artifact Type | Qualifier           | Extension | Writer       |
| ------------- | ------------------- | --------- | ------------ |
| `verdict`     | `reviewer-{index}`  | `.json`   | Reviewer     |
| `verdict`     | `verifier-{index}`  | `.json`   | Verifier     |
| `review`      | `reviewer-{index}`  | `.md`     | Reviewer     |
| `evidence`    | `self-review`       | `.md`     | Implementer  |
| `evidence`    | `addressed-reviews` | `.md`     | Implementer  |
| `learnings`   | _(none)_            | `.md`     | Implementer  |
| `synthesis`   | `review-summary`    | `.md`     | Synthesizer  |
| `checkpoint`  | `result`            | `.json`   | Checkpointer |
| `conflict`    | _(none)_            | `.md`     | Checkpointer |

## Metadata Format

Each scratch file has a companion `.meta` JSON file (same name + `.meta` extension). Example:

```json
{
  "artifact": "verdict",
  "role": "reviewer",
  "index": 0,
  "runId": "abc123",
  "loop": 3,
  "phase": 1,
  "timestamp": "2026-04-15T10:30:00Z"
}
```

### Metadata Fields

| Field       | Type     | Description                                                                                                         |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `artifact`  | `string` | Artifact type (mirrors naming: `verdict`, `review`, `evidence`, `learnings`, `synthesis`, `checkpoint`, `conflict`) |
| `role`      | `string` | Agent role (`implementer`, `reviewer`, `verifier`, `synthesizer`, `checkpointer`)                                   |
| `index`     | `number` | Agent index within its role (0-based). Omit for single-instance roles (implementer, synthesizer, checkpointer).     |
| `runId`     | `string` | The kloop run ID                                                                                                    |
| `loop`      | `number` | The loop/iteration number (0-based)                                                                                 |
| `phase`     | `number` | Review/verify phase index (0-based). Omit if not applicable.                                                        |
| `timestamp` | `string` | ISO 8601 timestamp of when the agent wrote the file                                                                 |

### Why Separate `.meta` Files

- Agents write the content file and the metadata file independently — a partially written content file won't corrupt metadata.
- The runner can check for `.meta` existence to determine if a scratch file is complete (an agent that crashes mid-write won't leave a `.meta` file).
- No need for JSON-in-markdown frontmatter or binary format parsing.

## Promotion Routing

The runner uses metadata to route each scratch file to the correct global path:

| Artifact     | Metadata Conditions    | Destination Path                                                   |
| ------------ | ---------------------- | ------------------------------------------------------------------ |
| `verdict`    | `role: "reviewer"`     | `~/.kloop/{runId}/loop-{loop}/verdicts/reviewer-{index}.json`      |
| `verdict`    | `role: "verifier"`     | `~/.kloop/{runId}/loop-{loop}/verdicts/verifier-{index}.json`      |
| `review`     | `role: "reviewer"`     | `~/.kloop/{runId}/loop-{loop}/reviews/reviewer-{index}.md`         |
| `evidence`   | `role: "implementer"`  | `~/.kloop/{runId}/loop-{loop}/evidence/{qualifier}.md`             |
| `learnings`  | `role: "implementer"`  | `~/.kloop/{runId}/learnings.md`                                    |
| `synthesis`  | `role: "synthesizer"`  | `~/.kloop/{runId}/loop-{loop}/synthesis/review-summary.md`         |
| `checkpoint` | `role: "checkpointer"` | `~/.kloop/{runId}/loop-{loop}/checkpointer/checkpoint-result.json` |
| `conflict`   | `role: "checkpointer"` | `~/.kloop/{runId}/conflict.md`                                     |

## Promotion Logic

**File: `src/agents/runner.ts`** (new private method on `AgentRunner`)

```typescript
interface ScratchMeta {
  artifact: string;
  role: string;
  index?: number;
  runId: string;
  loop: number;
  phase?: number;
  timestamp: string;
}

async promoteScratchFiles(params: {
  scratchDir: string; // absolute path to .kloop/scratch in agent's CWD
}): Promise<{ promoted: number; skipped: number; errors: number }> {
  const { scratchDir } = params;
  let promoted = 0, skipped = 0, errors = 0;

  // 1. List all .meta files in scratch dir
  const entries = await fs.readdir(scratchDir).catch(() => [] as string[]);
  const metaFiles = entries.filter(e => e.endsWith('.meta'));

  for (const metaFile of metaFiles) {
    const metaPath = path.join(scratchDir, metaFile);
    const contentFile = metaPath.replace(/\.meta$/, ''); // strip .meta suffix

    // 2. Read and validate metadata
    const metaContent = await this.safeReadFile(metaPath);
    if (!metaContent) { skipped++; continue; }

    let meta: ScratchMeta;
    try {
      meta = JSON.parse(metaContent);
    } catch { errors++; continue; }

    // 3. Check content file exists (incomplete writes have no content yet)
    const contentExists = await this.safeFileExists(contentFile);
    if (!contentExists) { skipped++; continue; }

    // 4. Resolve destination path from metadata (runId + loop drive routing)
    const destPath = this.resolveScratchDestination(meta);
    if (!destPath) { errors++; continue; }

    // 5. Ensure destination directory exists and copy
    try {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(contentFile, destPath);
      promoted++;
    } catch (err) {
      errors++;
      console.log(`Warning: failed to promote scratch file ${contentFile}: ${err}`);
    }
  }

  return { promoted, skipped, errors };
}
```

Note: this method **does not delete** scratch files individually. Per-file deletion is unnecessary because the entire `.kloop/` folder is wiped at the next loop boundary (see Recovery & Cleanup below). Promotion is purely additive — copy valid files to global paths, leave scratch alone.

### Promotion Timing

Promotion happens at three points:

| Trigger                   | Promotion Point                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------ |
| **After agent step**      | After each agent's tmux session exits, before the runner reads promoted files        |
| **Loop start (recovery)** | At the start of every loop iteration, before any agent runs (recovers crash orphans) |
| **Signal interrupt**      | On SIGTERM/SIGINT, before the runner exits (graceful shutdown)                       |

Per-agent-step promotion mapping:

| Agent Step     | Promotion Point                                                |
| -------------- | -------------------------------------------------------------- |
| Implementer    | After `runImplementer` returns, before learnings/evidence read |
| Reviewer       | After `runReviewer` returns, before verdict/review read        |
| Verifier       | After `runVerifier` returns, before verdict read               |
| Checkpointer   | After `runCheckpointer` returns, before checkpoint-result read |
| Synthesizer    | After `runSynthesizer` returns, before summary read            |
| Re-Synthesizer | After `runReSynthesizer` returns, before summary read          |

## Recovery & Cleanup Lifecycle

The runner manages `.kloop/` in CWD with a **promote-then-wipe** pattern at every loop boundary. This handles crashes, interrupts, and resumes uniformly without needing per-file staleness detection.

### Loop Start

At the start of every loop iteration (including loop 0 of a new or resumed session):

```typescript
async prepareLoopWorkspace(cwd: string): Promise<void> {
  const kloopDir = path.join(cwd, '.kloop');
  const scratchDir = path.join(kloopDir, 'scratch');

  // 1. Recover: promote any pending scratch files (from a prior crash)
  //    The runId + loop in each .meta route the file to its correct destination,
  //    even if it belongs to a previous loop or session.
  if (await this.safeFileExists(scratchDir)) {
    await this.promoteScratchFiles({ scratchDir });
  }

  // 2. Wipe: delete the entire .kloop/ folder for a clean slate
  await fs.rm(kloopDir, { recursive: true, force: true });

  // 3. Recreate scratch dir for the upcoming agent step
  await fs.mkdir(scratchDir, { recursive: true });
}
```

The wipe is intentionally aggressive — it removes the entire `.kloop/` folder, not just `.kloop/scratch/`. This ensures any junk a harness leaves behind in `.kloop/` (logs, temp files, partial writes) is cleared every loop.

### Signal Handling

The runner installs handlers for SIGTERM and SIGINT:

```typescript
function installSignalHandlers(runner: AgentRunner, scratchDir: string) {
  const handler = async (signal: string) => {
    console.log(`Received ${signal}, force-promoting scratch files before exit`);
    try {
      await runner.promoteScratchFiles({ scratchDir });
    } catch (err) {
      console.log(`Warning: force-promotion failed: ${err}`);
    }
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
```

After force-promotion the process exits without wiping `.kloop/`. The next loop start (or next session start) will perform recovery + wipe.

### Hard Crash Recovery

If the runner is killed without a chance to run signal handlers (SIGKILL, OOM, power loss), scratch files remain in `.kloop/scratch/`. The next invocation — whether a new session, a resumed session, or simply the next loop iteration — will promote them on entry via `prepareLoopWorkspace()`.

Because routing is metadata-driven (the `runId` + `loop` in each `.meta` file determine the destination), promoted orphans land in their correct historical loop directories under `~/.kloop/{runId}/loop-{loop}/...` rather than the current loop. No data is lost or misfiled.

### Fallback Behavior

The read path in the runner is always the global path. Promotion just ensures the file ends up there:

```typescript
// After promotion attempt:
const { promoted } = await this.promoteScratchFiles({ scratchDir });

// Read verdict — works whether it was promoted from scratch or written directly
const verdictContent = await this.safeReadFile(
  path.join(paths.loopVerdictsPath(runId, iteration), `reviewer-${reviewerIndex}.json`),
);
```

No conditional logic needed. Claude/Gemini agents that write directly to global paths still work; their output is read from the same place as promoted scratch files.

## Prompt Updates

### Scratch Path Variable

Add a new prompt variable to all agent prompt builders:

```typescript
// In prompt builder functions:
scratchDir: string; // e.g., "/path/to/workspace/.kloop/scratch"
```

The scratch dir is always `{cwd}/.kloop/scratch` where `cwd` is the workspace the agent runs in.

### Implementer Prompt Changes

Replace direct write paths with scratch paths:

```
Before: Write your self-review to {evidenceDir}/self-review.md
After:  Write your self-review to {scratchDir}/evidence-self-review.md
        Create the metadata file {scratchDir}/evidence-self-review.md.meta with:
        {"artifact":"evidence","role":"implementer","runId":"{runId}","loop":{loop},"timestamp":"<ISO>"}
```

Same pattern for:

- `evidence-addressed-reviews.md` + `.meta`
- `learnings.md` + `.meta`

### Reviewer Prompt Changes

```
Before: Write your verdict to {verdictsDir}/reviewer-{index}.json
After:  Write your verdict to {scratchDir}/verdict-reviewer-{index}.json
        Create the metadata file {scratchDir}/verdict-reviewer-{index}.json.meta with:
        {"artifact":"verdict","role":"reviewer","index":{index},"runId":"{runId}","loop":{loop},"phase":{phase},"timestamp":"<ISO>"}
```

Same pattern for `review-reviewer-{index}.md`.

### Checkpointer Prompt Changes

```
Before: Write checkpoint result to {checkpointResultFile}
After:  Write checkpoint result to {scratchDir}/checkpoint-result.json
        Create the metadata file {scratchDir}/checkpoint-result.json.meta with:
        {"artifact":"checkpoint","role":"checkpointer","runId":"{runId}","loop":{loop},"timestamp":"<ISO>"}
```

Same for `conflict.md`.

### Synthesizer / Verifier Prompt Changes

Same pattern as above — replace global output paths with `{scratchDir}/` paths.

## Agent Instructions Summary

Each agent prompt includes a concise scratch protocol block:

```
## Output Protocol

Write all output files to {scratchDir}/ with the naming convention:
  {artifactType}-{qualifier}.{ext}        (content file)
  {artifactType}-{qualifier}.{ext}.meta   (metadata file)

The metadata file must be a single-line JSON object:
  {"artifact":"<type>","role":"<role>","runId":"{runId}","loop":{loop},"timestamp":"<ISO-8601>"}

Include "index" and "phase" fields when applicable. Write the .meta file LAST —
it signals that the content file is complete.
```

## Files to Change

| File                          | Change                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `src/agents/runner.ts`        | Add `promoteScratchFiles()` and `prepareLoopWorkspace()` methods; call after each agent step |
| `src/agents/prompts.ts`       | Add `scratchDir` variable to all prompt builders; update write instructions                  |
| `src/deps.ts` or path helpers | Add `scratchDir` path helper (derives from `cwd`)                                            |
| `src/loop/runner.ts`          | Call `prepareLoopWorkspace()` at loop start; install signal handlers; pass scratch dir       |

## Functional Definition of Done

### Promotion mechanics

- [ ] Scratch files with valid `.meta` are promoted to correct global paths
- [ ] Scratch files without `.meta` are skipped (incomplete writes)
- [ ] `.meta` files without a content file are skipped (mid-write crash)
- [ ] Promotion failure logs a warning and continues processing other files
- [ ] Promotion does NOT delete files individually — cleanup is handled by the loop-start wipe
- [ ] Routing uses `runId` and `loop` from `.meta` so orphans land in their historical loop dirs

### Recovery & cleanup lifecycle

- [ ] At every loop start, runner promotes pending scratch files THEN wipes `.kloop/` entirely
- [ ] Loop-start recovery runs on new sessions, resumed sessions, AND mid-session loop transitions
- [ ] After wipe, runner recreates `.kloop/scratch/` for the upcoming agent step
- [ ] SIGTERM and SIGINT handlers force-promote pending scratch files before exit
- [ ] Hard-killed runners (SIGKILL/OOM) leave orphans that are recovered on next loop start

### Fallback compatibility

- [ ] If no scratch files exist, runner reads from global paths (existing behavior)
- [ ] If promotion produces partial results, runner reads whatever is in global paths
- [ ] Claude agents work with both scratch and direct-write prompts during transition

### Prompt correctness

- [ ] All agent prompts include scratch output instructions
- [ ] Scratch dir path is correctly resolved to `{cwd}/.kloop/scratch`
- [ ] Metadata includes all required fields for routing
- [ ] Agent instructions say "write .meta file LAST" to signal completion

### Codex sandbox validation

- [ ] Codex agents can write to `.kloop/scratch/` within their workspace
- [ ] Codex agents cannot write to `~/.kloop/` directly (sandbox enforced)
- [ ] After Codex agent step, scratch files are promoted to global session
- [ ] Codex verdicts, reviews, evidence, learnings all appear in global session

### Observability

- [ ] Promotion count logged per agent step (promoted/skipped/errors)
- [ ] Scratch directory is clean after successful promotion
- [ ] Failed promotions preserve files for debugging

## Non-Functional Definition of Done

### Backwards compatibility

- [ ] Existing Claude/Gemini/OpenCode agents continue to work (fallback to global path reads)
- [ ] No config format changes required
- [ ] No changes to event types or status materialization

### Simplicity

- [ ] No IPC mechanism (no sockets, HTTP, stdout parsing)
- [ ] No new CLI subcommands
- [ ] Metadata format is plain JSON, not YAML or TOML
- [ ] No new dependencies

### Robustness

- [ ] Partial agent writes (content without .meta) are handled gracefully
- [ ] Stale scratch from crashed previous runs is cleaned up
- [ ] Promotion errors don't crash the runner

## Test Scenarios

### Normal operation

1. Codex agent writes verdict to scratch, runner promotes to global `verdicts/reviewer-0.json`.
2. Codex agent writes review to scratch, runner promotes to global `reviews/reviewer-0.md`.
3. Claude agent writes directly to global path (no scratch), runner reads it via fallback.
4. Multiple reviewers write to scratch in parallel — all files promoted correctly.
5. Implementer writes learnings to scratch — promoted to `~/.kloop/{runId}/learnings.md`.
6. Checkpointer writes `checkpoint-result.json` and `conflict.md` to scratch — both promoted.
7. Synthesizer writes `synthesis-review-summary.md` to scratch — promoted to synthesis dir.

### Loop-start cleanup

8. New loop starts — `prepareLoopWorkspace()` promotes pending scratch, then wipes entire `.kloop/`.
9. After wipe, `.kloop/scratch/` is recreated and empty for the next agent step.
10. `.kloop/` folder does not exist at loop start (clean workspace) — recreated without errors.

### Crash recovery

11. Agent writes content file but crashes before `.meta` — skipped during recovery, wiped on next loop.
12. Runner killed by SIGTERM mid-loop — signal handler promotes pending scratch, then exits.
13. Runner hard-killed (no signal handler) — orphans in `.kloop/scratch/` are promoted on next loop start.
14. Orphaned scratch from loop 2 of a previous session — promoted to correct loop-2 global paths (not current loop).

### Edge cases

15. `.kloop/` contains non-scratch junk from a harness — entire folder wiped at loop start.
16. Promotion of one file fails (e.g., permission error) — remaining files still promoted, warning logged.

## Known Limitations

- Agents still **read** from global `~/.kloop/` paths (reviews, evidence, previous learnings). Reading is not restricted by Codex sandbox (Codex can read any path), so this works today. If a future Codex version restricts reads too, a read-side scratch protocol would be needed.
- The `.meta` file approach requires agents to write two files per artifact. An alternative (frontmatter in markdown, JSON envelope) was considered but rejected for simplicity — separate files avoid parsing ambiguity.
- No atomic write guarantee within the sandbox. If Codex kills an agent mid-write, the content file may be partial. The `.meta`-last convention mitigates this (runner skips files without metadata).
- Loop-start wipe is destructive: any user-created files in `.kloop/` (outside `.kloop/scratch/`) will be deleted. The `.kloop/` folder is treated as runner-owned scratch space — agents and users should not put persistent data there.
- Signal handlers cannot guarantee promotion completes before exit (e.g., if the OS forcibly terminates after a grace period). Hard-crash recovery on next loop start is the backstop.

## Future Extensions

- **Scratch validation**: Runner could validate verdict JSON schema before promotion (reject malformed verdicts).
- **Artifact size limits**: Runner could reject scratch files exceeding a size threshold.
- **Read-side scratch**: If harnesses restrict reads in the future, the runner could pre-populate scratch with input files before launching the agent.
- **Structured logging**: Emit a `scratch_promoted` event type to `events.jsonl` for each promotion.
