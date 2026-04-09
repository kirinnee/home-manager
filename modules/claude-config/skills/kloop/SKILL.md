---
name: kloop
description: 'Spec-driven development with multi-reviewer consensus. Use when running /kloop to plan a spec, run the kloop loop, watch for conflicts, and resolve them interactively.'
argument-hint: '[SPEC_FILE]'
---

# kloop — Spec-Driven Development with Multi-Reviewer Consensus

Orchestrate a kloop run from spec planning through conflict resolution.

## Reference: kloop CLI Commands

| Command                                   | Description                                                         |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `kloop setup`                             | View or set user-level default config (`--config <path>` to import) |
| `kloop init`                              | Create a new run directory (`--spec`, `--config`, `--workspace`)    |
| `kloop run [id]`                          | Start a run (`-d` for daemon mode)                                  |
| `kloop ps`                                | List active runs (`-a` for all, `--workspace`, `--json`)            |
| `kloop status [id]`                       | Current snapshot of a run (`--json`)                                |
| `kloop describe [id]`                     | Full history: all loops, verdicts, exit code, timings (`--json`)    |
| `kloop logs [id]`                         | Show run log (`-f` follow, `--since <duration>`)                    |
| `kloop view [id] [loop] [role] [ordinal]` | View agent logs (`-f` follow, `--since`)                            |
| `kloop review [id]`                       | Show reviewer verdicts and reasoning                                |
| `kloop summary [id]`                      | LLM-evaluated run summary (`--force` to regenerate)                 |
| `kloop metrics [query]`                   | Query metrics (`--run`, `--json`)                                   |
| `kloop cancel [id]`                       | Cancel a running run                                                |
| `kloop link [id]`                         | Symlink run spec+config into CWD/.kloop/ for editing                |
| `kloop attach [id]`                       | Attach to run's tmux session                                        |
| `kloop remove [ids...]`                   | Delete run(s) (`--force`, supports prefix matching)                 |
| `kloop reset`                             | Reset global config to defaults                                     |

If no run ID is provided, most commands resolve the run from the current workspace.

## Workflow

### Phase 1: Config Setup

Read the current default config:

```bash
kloop setup
```

Show the user the default config output, then ask:

**"Is this config acceptable?"**

- If **yes**: skip to Phase 2. Let `kloop init` use the default config.
- If **no**: proceed to generate a new config.

#### Agent Detection (only if user rejects default)

Run a shell command to detect available agent binaries:

```bash
(compgen -c | grep -E '^(claude|gemini)' || true) | sort -u
```

Also check for base binaries: `command -v claude` and `command -v gemini`.

Categorize the found binaries:

- **Claude agents**: `claude`, `claude-auto-zai`, `claude-auto-mm`, `claude-auto-seed`, `claude-auto-anthropic`, etc.
- **Gemini agents**: `gemini`, `gemini-auto`, etc.

Present the findings and ask the user to configure:

1. **Implementers** (who writes code): which binaries and their weights (for weighted random selection)
2. **Reviewers** (per phase): which binaries review the code. Multiple phases allowed.
3. **Conflict checker**: which binary handles conflict detection

Use AskUserQuestion to let the user pick. Generate a YAML config like:

```yaml
implementers:
  claude: 1
  gemini-auto:gemini: 1

reviewPhases:
  - - claude
    - gemini-auto:gemini:0

maxIterations: 10
implementerTimeout: 30
reviewerTimeout: 15
conflictCheckThreshold: 2
firstLoopFullReview: false
previousReviewPropagation: 0
```

Write this config to a temp file and note the path for the init command. Also save it as the new default via `kloop setup --config <tempfile>`.

**Important config format notes:**

- Bare binary name (e.g. `claude`) defaults to Claude harness
- Explicit format: `binary:harness` (e.g. `gemini-auto:gemini`)
- Reviewer format: `binary:harness:flag` where flag is 0 or 1 (noVerdictAsFailure)
- Only `claude` and `gemini` harnesses are supported

### Phase 2: Spec Setup

Ask the user for a spec file path, or let them type a spec description.

- If they provide a file path: use `--spec <path>` when running init
- If they type a description: write it to a temp file and use `--spec <temp>`
- If they want the default template: don't pass `--spec` at all

### Phase 3: Init

Run the init command:

```bash
kloop init [--spec <spec>] [--config <config>] [--workspace <path>]
```

Capture the run ID from the output. Remember the run directory (`~/.kloop/<runId>`).

### Phase 4: Run (Daemon Mode)

```bash
kloop run -d <runId>
```

### Phase 5: Watch Loop

Poll the run status every 10 seconds:

```bash
kloop status <runId>
```

Continue polling while the status shows the run is active (running, implementing, reviewing, etc.).

**On conflict detected:**

1. Stop polling
2. Read the conflict details from `~/.kloop/<runId>/conflict.md`
3. **Verify the conflict**:
   - A conflict is a spec defect where **no possible implementation can satisfy all requirements simultaneously**
   - Apply the litmus test: "Imagine giving the implementer 10x intelligence and 10x more attempts. Could it eventually fulfil the spec? If NO, that is a conflict."
   - Check for: contradictory constraints, circular dependencies, impossible environmental constraints, fundamentally ambiguous requirements
   - **Important**: Reviewer disagreement alone is NOT a conflict — use reviewer feedback as a clue for _where to look_, not as evidence of a conflict
   - If the analysis concludes this is NOT a real conflict (just implementation/review issues), tell the user and resume watching
4. If it IS a real conflict, present the conflict to the user with:
   - The exact conflicting spec requirements (quote the spec)
   - Why they conflict
   - Which reviewers flagged this
5. Discuss resolution with the user — edit the spec together to resolve the conflict
6. Once the spec is updated, resume: `kloop run` (uses the same run, picks up from the resolved conflict)

**On successful completion:**

- Report the final status (`kloop describe <runId>` for full history)
- Show a summary if available (`kloop summary <runId>`)
- Show review verdicts (`kloop review <runId>`)

**On error/timeout/crash:**

- Report the error
- Suggest the user check logs (`kloop logs <runId>`) or attach to the session (`kloop attach <runId>`)

### Cleanup

After the run finishes (success or cancel), offer to:

- View the full run history (`kloop describe <runId>`)
- View the summary (`kloop summary <runId>`)
- View review verdicts (`kloop review <runId>`)
- View agent logs (`kloop view <runId>`)
- Clean up the run (`kloop remove <runId>`)
