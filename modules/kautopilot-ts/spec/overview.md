# kautopilot

End-to-end task completion from ticket to merge-ready PR. A TypeScript binary that orchestrates planning, implementation, and polish phases — replacing the kagent-autopilot Claude Code skill with a deterministic, cheaper alternative.

## Goal

Convert the kagent-autopilot skill (~20 markdown step files executed by spawned Claude agents) into a single `kautopilot` binary. The skill burns tokens on every state transition (even mechanical ones like "read JSON, update step field, write JSON"). The binary handles control flow, state management, and mechanical steps directly in TypeScript — only calling Claude when LLM reasoning is actually needed.

## What Changes

| Aspect           | Skill (current)                            | Binary (kautopilot)                      |
| ---------------- | ------------------------------------------ | ---------------------------------------- |
| State management | Spawn haiku agents to read/write JSON      | Direct SQLite + log-based reconstruction |
| Mechanical steps | Spawn Claude agents for git, file ops      | Pure TypeScript, no LLM call             |
| Control flow     | Claude reasons about what step to run next | TypeScript state machine                 |
| LLM steps        | Spawned team agents with full prompts      | TTY handoff or `--print` subprocess      |
| Cost             | Every transition burns tokens              | Only steps needing reasoning burn tokens |
| Determinism      | Prompt drift, context issues               | Explicit code paths                      |

## State Architecture

State lives in four places: a global index, a global session directory, org ticket scripts, and the repo itself.

```
~/.kautopilot/
├── index.db              -- lightweight lookup: id → repo, worktree, git_root, ticket
├── orgs/{name}/          -- per-org ticket scripts (deterministic, no LLM)
│   ├── extract-ticket    -- extract ticket ID from branch name
│   ├── get-ticket        -- fetch ticket details as markdown
│   ├── start-ticket      -- transition: todo → in progress
│   └── transition        -- arbitrary state transition
└── {id}/                 -- per-session state, config, logs
    ├── config.yaml       -- roles, settings, repo config, runtime state
    └── log.jsonl         -- append-only event log (source of truth for state)

{repo}/                   -- committed spec files
└── spec/{ticketId}/      -- part of the repo, source of truth
    ├── ticket.md
    ├── v1/
    │   ├── task-spec.md
    │   ├── plans/
    │   │   ├── plan-1.md
    │   │   └── plan-2.md
    │   └── feedback.md
    └── v2/
        └── ...
```

### index.db — Minimal Lookup Table

The DB does one thing: given a worktree, find the session. Everything else lives in `config.yaml` and `log.jsonl`.

```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,       -- auto-generated (8-char hex)
  repo_path      TEXT NOT NULL,
  worktree       TEXT NOT NULL,
  git_root       TEXT NOT NULL,          -- full remote URL
  git_root_host  TEXT NOT NULL,          -- normalized: "github.com/atomi/api-server"
  ticket_id      TEXT,
  branch         TEXT,
  local          INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_sessions_worktree ON sessions(repo_path, worktree);
```

- `git_root_host`: normalized from remote URL (strip `git@`, `https://`, `.git`, lowercase) for `--repo` filtering
- `local`: 1 if local mode session
- `created_at` / `updated_at`: avoids reading log.jsonl for every session in `ps`
- `kautopilot init` → detect git_root + worktree, upsert into index.db, create `~/.kautopilot/{id}/` if new
- `kautopilot status` → query by current worktree → reconstruct state from `log.jsonl`
- `kautopilot ps` → list rows from index.db
- One session per worktree (unique constraint)

### config.yaml — Single Source of Truth

All session state lives in one file per session:

```yaml
# Static config (set during setup, rarely changes)
roles:
  planner: claude-haiku
  researcher: claude-sonnet
  implementer: claude-sonnet
  # ...
steps:
  write_spec: claude-sonnet
  # ...

settings:
  maxIterations: 10
  implementerTimeout: 30
  # ...

repo:
  org: atomi
  baseBranch: main
  ticketSystem: jira
  # ...

# Runtime state (updated every transition)
runtime:
  phase: plan # plan | implementation | polish | completed | failed
  branch: feature/PE-1234
  ticketId: PE-1234
  ticketTitle: '...'
  prNumber: null
  specVersion: 1
  specDir: spec/PE-1234/v1
  currentSubPlanIndex: 0
  pushCycle: 0
```

### log.jsonl — Event Log (Source of Truth)

Append-only event log at `~/.kautopilot/{id}/log.jsonl`. Every state transition writes an event. `kautopilot status` reconstructs current state from the log — no separate status file.

```jsonl
{"ts":"2026-03-24T10:00:00Z","event":"init:started"}
{"ts":"2026-03-24T10:00:01Z","event":"init:completed","id":"a1b2c3d4","ticketId":"PE-1234","local":false}
{"ts":"2026-03-24T10:01:00Z","event":"start:started","phase":"plan"}
{"ts":"2026-03-24T10:01:01Z","event":"write_spec:started","version":1}
{"ts":"2026-03-24T10:05:00Z","event":"write_spec:completed","version":1}
...
```

**Version convention:** All phase events include `version`. The version is set during Phase 1 and persists for the rest of the session. CLI events (`init:*`, `start:*`, `stop:*`) do not include version.

### No status.yaml

State is reconstructed from `log.jsonl` — the log IS the source of truth. No separate snapshot file to keep in sync. See [artifacts.md](artifacts.md#state-reconstruction-no-statusyaml) for how `kautopilot status` works.

### Why This Split

| Location                | Holds                                             | Reason                                                                   |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `index.db`              | repo path, worktree, git root, ticket, timestamps | O(1) lookup by worktree, cross-repo awareness, `ps` without reading logs |
| `orgs/{name}/`          | ticket scripts per org                            | Deterministic ticket ops without LLM — scripts are just shell            |
| `lock.pid`              | PID of running kautopilot process                 | Prevents concurrent sessions on same worktree                            |
| `config.yaml`           | roles, settings, repo config, runtime state       | Single source of truth for config                                        |
| `log.jsonl`             | append-only event log with version                | Source of truth for state, retry/resume, audit                           |
| Repo `spec/{ticketId}/` | task-spec.md, plans, feedback                     | Committed to git, audit trail, part of the codebase                      |

## Runtime

- **Bun** exclusively (uses `bun:sqlite`, `Bun.spawn`, `Bun.file`)
- **Config:** `~/.kautopilot/{id}/config.yaml` (roles, settings, repo config, runtime state)
- **Prompt templates:** bundled in the binary package, loaded at runtime from a `prompts/` directory
- **Claude binaries:** resolved from config (`claude-haiku`, `claude-sonnet`, etc.) — treated as Claude Code CLI with different model backends

## Execution Modes

Four ways kautopilot interacts with LLMs:

| Mode                        | When                                                | How                                                                                    |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--print` (non-interactive) | Quality checks, spec rewriting, commit messages     | `claude --print -p "..."` — structured output parsed as JSON                           |
| TTY handoff (interactive)   | Spec writing, conflict resolution, feedback capture | Spawn Claude with inherited stdio — user gets full interactive session                 |
| Inquirer (user only)        | Approvals, issue triage                             | Pure UI — no LLM, just yes/no/select prompts                                           |
| Local                       | Quick/interactive use without ticket systems        | `--local` flag on `init`/`start` — TTY handoff generates spec + plans, no ticket fetch |

## CLI

Full command reference: [cli.md](cli.md).

```
kautopilot init [TICKET_ID]   # Phase 0: create session, configure, setup repo
kautopilot start [--phase]    # Begin execution (auto-inits if needed)
kautopilot status [ID]        # Show session state (local or global)
kautopilot stop [ID]          # Kill and cleanup
kautopilot logs [phase]       # Tail event log
kautopilot ps                 # List all sessions
kautopilot org init <name>    # Create or re-init org ticket scripts
```

## Phases

| Phase              | Description                          | Spec                                                 |
| ------------------ | ------------------------------------ | ---------------------------------------------------- |
| 0 — Init           | Session creation, config, repo setup | [cli.md](cli.md)                                     |
| 1 — Plan           | Ticket → approved spec + plans       | [phase1-plan.md](phase1-plan.md)                     |
| 2 — Implementation | Execute plans                        | [phase2-implementation.md](phase2-implementation.md) |
| 3 — Polish         | Push, PR, poll, fix cycle            | [phase3-polish.md](phase3-polish.md)                 |

**Note:** Phase 0 (`init`) is a CLI command, not a state machine phase. It creates the session and sets up the repo. Phase 1 starts at `write_spec` (or `feedback` for v2+).

## Artifacts

All artifacts stored globally, versioned by spec version. See [artifacts.md](artifacts.md).
