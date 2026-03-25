# Artifacts

All artifacts stored in the global session folder, versioned by spec version. Full history, addressable for debugging. Every step writes to a deterministic path.

## Global Directory Structure

```
~/.kautopilot/
├── index.db              -- session lookup table
├── orgs/{name}/          -- per-org ticket scripts (see Org Scripts below)
│   ├── extract-ticket    -- extract ticket ID from branch name
│   ├── get-ticket        -- fetch ticket details as markdown
│   ├── start-ticket      -- transition: todo → in progress
│   └── transition        -- arbitrary state transition
│
└── {id}/                 -- per-session state, config, logs, artifacts
    ├── config.yaml
    ├── log.jsonl
    ├── lock.pid
    └── artifacts/
        └── v{N}/
            ├── phase1/
            ├── phase2/
            └── phase3/
```

## Org Scripts

Per-org ticket integration scripts at `~/.kautopilot/orgs/{name}/`. When these exist, `init` uses them instead of LLM-based detection. See [cli.md](cli.md#org-init--create-or-re-init-org-ticket-scripts) for the full interface spec and `kautopilot org init` command.

| Script           | Input                    | Output                  | Purpose                          |
| ---------------- | ------------------------ | ----------------------- | -------------------------------- |
| `extract-ticket` | stdin: branch name       | stdout: ticket ID       | Extract ticket ID from branch    |
| `get-ticket`     | arg: ticket ID           | stdout: ticket markdown | Fetch ticket title + description |
| `start-ticket`   | arg: ticket ID           | exit code only          | Transition: todo → in progress   |
| `transition`     | arg: ticket ID, from, to | exit code only          | Arbitrary state transition       |

**Fallback chain:** org scripts → `SETUP.md` → LLM detection → ask user. **Local mode:** all ticket ops are no-ops.

---

## Directory Tree

```
~/.kautopilot/{id}/
├── config.yaml
├── log.jsonl
├── lock.pid                       # PID of running process (exists while running)
│
└── artifacts/
    └── v{N}/
        │
        ├── phase1/                              # planning artifacts
        │   ├── ticket.md                        # fetched ticket content
        │   ├── task-spec.md                     # the approved spec
        │   ├── spec-review.json                 # spec quality check result + issues
        │   ├── spec-feedback.json               # user arbitration of spec issues
        │   ├── plans-review.json                # plans quality check result + issues
        │   ├── plans-feedback.json              # user arbitration of plan issues
        │   ├── feedback.md                      # user feedback (v2+ only)
        │   └── plans/
        │       ├── plan-1.md
        │       └── plan-2.md
        │
        ├── phase2/                              # implementation artifacts
        │   └── plan-{M}/
        │       ├── spec.md                      # plan-level: what was fed to implementation loop
        │       └── state.json                   # plan-level: {finalRunId, commitSha, commitMessage}
        │
        └── phase3/                              # polish artifacts
            └── cycle-{C}/
                ├── poll-result.json            # raw GitHub API data + computed state
                ├── prefilter.json              # threads closed deterministically (outdated, ghosted)
                ├── eval-results.json           # all fan-out LLM eval results
                ├── resolve-output.json         # TTY ambiguity resolution decisions
                └── prereview.md                # CodeRabbit local review (Part A)
```

## Phase-specific artifacts

### Phase 1

| Artifact              | Written by                | Content                                      |
| --------------------- | ------------------------- | -------------------------------------------- |
| `ticket.md`           | Org script or LLM + fetch | Fetched ticket content from Jira/ClickUp/etc |
| `task-spec.md`        | TTY handoff               | The approved task specification              |
| `spec-review.json`    | LLM (`--print`)           | `{result: "pass"\|"fail", issues: [...]}`    |
| `spec-feedback.json`  | Inquirer                  | `{valid: [...], invalid: [...]}`             |
| `plans-review.json`   | LLM (`--print`)           | `{result: "pass"\|"fail", issues: [...]}`    |
| `plans-feedback.json` | Inquirer                  | `{valid: [...], invalid: [...]}`             |
| `feedback.md`         | TTY handoff               | User feedback from prior version (v2+ only)  |
| `plans/*.md`          | TTY handoff               | Individual implementation plans              |

### Phase 2

| Artifact              | Written by                 | Content                                     |
| --------------------- | -------------------------- | ------------------------------------------- |
| `plan-{M}/spec.md`    | Pure TS (copy from plans/) | Original plan content fed to implementation |
| `plan-{M}/state.json` | Pure TS                    | `{finalRunId, commitSha, commitMessage}`    |

Implementation run artifacts (reviews, verdicts, evidence, logs, metrics) are stored by the implementation tool. kautopilot records the run ID in `plan-{M}/state.json` for lookup.

### Phase 3

| Artifact                        | Written by      | Content                                                 |
| ------------------------------- | --------------- | ------------------------------------------------------- |
| `cycle-{C}/poll-result.json`    | Pure TS         | Raw GitHub API data + computed state + merge policy     |
| `cycle-{C}/prefilter.json`      | Pure TS         | `{closed: [{threadId, reason}], skipped: [...]}`        |
| `cycle-{C}/eval-results.json`   | LLM fan-out     | All unit verdicts, replies, code fixes, ambiguity flags |
| `cycle-{C}/resolve-output.json` | TTY handoff     | User's decisions on ambiguous items                     |
| `cycle-{C}/prereview.md`        | LLM (`--print`) | CodeRabbit local review findings                        |

## State Reconstruction (no status.yaml)

`kautopilot status` reconstructs state from `log.jsonl` — no separate status file. The log IS the source of truth.

### How it works

```typescript
function reconstructState(log: LogEntry[], now: Date): SessionState {
  // 1. Find the last event
  const lastEvent = log[log.length - 1]

  // 2. Determine what's currently running
  //    Last ":started" without a matching ":completed" → running
  const startedWithoutCompleted = log
    .filter(e => e.event.endsWith(':started'))
    .filter(start => !log.some(end =>
      end.event === start.event.replace(':started', ':completed')
    ))
    .pop()

  // 3. Compute durations from timestamps
  const phaseStarted = log.find(e => e.event.includes(':started'))
  const currentStepStarted = startedWithoutCompleted ?? lastEvent
  const phaseElapsed = now - new Date(phaseStarted.ts)
  const stepElapsed = now - new Date(currentStepStarted.ts)

  // 4. Extract metadata from events
  //    (pushCycle, prNumber, mergePolicy, etc. are in event metadata)

  return {
    phase: ...,
    currentStep: ...,
    running: !!startedWithoutCompleted,
    phaseElapsed,
    stepElapsed,
    stats: { totalReplies, totalResolved, pushCycles },
  }
}
```

### Why no status.yaml

- **Snapshots go stale.** If a process crashes mid-step, status.yaml shows the wrong state.
- **The log is already complete.** Every `:started` and `:completed` is recorded with timestamps.
- **Reconstruction is cheap.** Scan the last few entries — it's a small file.
- **No sync issues.** No file to write on every transition, no risk of corruption.

## Deterministic Paths

```typescript
function artifactPath(version: number, phase: string, ...segments: string[]): string {
  return `~/.kautopilot/${id}/artifacts/v${version}/${phase}/${segments.join('/')}`;
}

// Examples:
artifactPath(1, 'phase1', 'task-spec.md');
// → ~/.kautopilot/{id}/artifacts/v1/phase1/task-spec.md

artifactPath(1, 'phase2', 'plan-1', 'state.json');
// → ~/.kautopilot/{id}/artifacts/v1/phase2/plan-1/state.json

artifactPath(1, 'phase3', 'cycle-1', 'eval-results.json');
// → ~/.kautopilot/{id}/artifacts/v1/phase3/cycle-1/eval-results.json
```
