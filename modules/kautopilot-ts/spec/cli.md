# CLI Interface

Full command tree for `kautopilot`. See [overview.md](overview.md) for architecture and state design.

## Command Tree

```
kautopilot
├── init [TICKET_ID]       # Phase 0: create session, configure, setup repo
│   --local                #   local mode (TTY handoff to generate spec + plans)
│
├── start                  # Begin execution (auto-inits if needed, plan by default)
│   --phase <phase|step>   #   force start at specific phase or step
│   --local                #   local mode (auto-inits with --local if needed)
│
├── status [ID]            # Local (no ID): session state from log.jsonl
│   --json                 #   Global (ID given): full session details
│                          #   from index.db + log.jsonl
│
├── stop [ID]              # Local (no ID): kill processes, release lock
│   --force                #   Global (ID given): kill + optionally delete
│                          #   session directory and index.db row
│
├── logs [phase]           # Session-scoped: tail log.jsonl
│   --tail N               #   last N entries
│   --json                 #   raw JSONL
│
├── ps                     # Global: list all sessions (docker ps)
│   --repo <origin>        #   filter by git root
│   --all                  #   include stopped/completed
│   --json                 #   machine-readable
│
└── org                   # Org ticket script management
    ├── init <name>        #   Create or re-init org ticket scripts
    └── ls                 #   List configured orgs
```

### Aliases

`--phase` accepts short forms: `plan`, `impl` → `implementation`, `polish`.

`--phase impl:setup_run` → jump to specific step within a phase.

---

## `init` — Phase 0

Create session, configure, and setup repo. Does NOT run phases.

```
kautopilot init [TICKET_ID]
kautopilot init --local
```

### Behavior

1. Check lock.pid — if locked, error: "Session is already running."
2. Detect git root and worktree
3. Generate session ID (8-char hex)
4. Upsert row in `~/.kautopilot/index.db`
5. Create `~/.kautopilot/{id}/config.yaml` with defaults
6. Present config to user via inquirer: roles, dev-loop settings, repo defaults
7. User confirms or edits
8. Write final config to disk
9. Create feature branch if on main/master
10. Acquire PID lock

**With ticket ID (non-local):**

- Resolve repo config via org script resolution chain (see [Org Scripts](#org-scripts)):
  1. Org scripts exist at `~/.kautopilot/orgs/{org}/` → use them (deterministic, no LLM)
  2. `SETUP.md` in repo root → use as-is
  3. LLM detection → guess from CI files, README, git remote
  4. Ask user → manual config via inquirer
- Present detected config to user for confirmation
- Fetch ticket details (via org script or LLM), build `ticket.md`, set `specDir`

**With `--local`:**

- Generate ticket ID: `local-{shortRandom}` (e.g. `local-a3f2`)
- Set `runtime.local: true`, `repo.ticketSystem: null`
- Spawn Claude interactively (TTY handoff) to generate:
  - `spec/{ticketId}/ticket.md`
  - `spec/{ticketId}/v1/spec.md`
  - `spec/{ticketId}/v1/plans/plan-1.md`
- Config: `runtime.local: true`, `repo.ticketSystem: null`

### Output

```
Session initialized: a1b2c3d4
Ticket:    PE-1234
Branch:    feature/PE-1234
Config:    ~/.kautopilot/a1b2c3d4/config.yaml
Next:      kautopilot start
```

Local mode output:

```
Spawning Claude to generate spec and plans...
[TTY handoff — Claude interactively creates ticket.md, v1/spec.md, v1/plans/plan-1.md]

Session initialized: a1b2c3d4
Ticket:    local-a3f2
Branch:    feature/local-a3f2
Spec:      spec/local-a3f2/v1/spec.md
Plans:     spec/local-a3f2/v1/plans/plan-1.md
Next:      kautopilot start [--phase impl] [--phase polish]
```

### Errors

| Condition              | Message                                                                | Next Step          |
| ---------------------- | ---------------------------------------------------------------------- | ------------------ |
| Already locked         | "Session is already running (PID {pid}). Use `kautopilot stop` first." | `kautopilot stop`  |
| Not in a git repo      | "Not a git repository."                                                | Navigate to a repo |
| Ticket not found       | "Could not find ticket {id} in {system}."                              | Check ticket ID    |
| Init already completed | "Session already initialized. Use `kautopilot start`."                 | `kautopilot start` |

---

## `start` — Begin Execution

Start (or resume) phase execution. Auto-inits if session doesn't exist.

```
kautopilot start
kautopilot start --phase impl
kautopilot start --phase impl:setup_run
kautopilot start --local
kautopilot start --phase impl --local
```

### Behavior

1. If no session exists → auto-run `init` (with `--local` if `--local` is set)
2. Check lock.pid — if locked, error
3. Acquire PID lock
4. Determine starting phase:
   - No `--phase` → resume from last incomplete step in log (or start at plan if fresh)
   - `--phase plan` → start at Phase 1 plan
   - `--phase impl` → jump to implementation (requires spec + plans)
   - `--phase impl:setup_run` → jump to specific step (requires plan index)
   - `--phase polish` → jump to polish (requires committed code on branch)
5. Log `start:started` + `phase_start:forced` if jumping
6. Execute phase/step
7. Log `start:completed`

### Phase/Step Jumping Validation

| Target           | Required State             | Error if Missing                                                    |
| ---------------- | -------------------------- | ------------------------------------------------------------------- |
| `plan`           | config.yaml (auto-inits)   | "No config. Run `kautopilot init` first."                           |
| `impl`           | spec + plans exist         | "No approved spec. Complete planning first or use `start --local`." |
| `impl:setup_run` | spec + specific plan index | "Plan {N} does not exist."                                          |
| `polish`         | committed code on branch   | "No implementation found."                                          |
| `polish:poll`    | PR exists in config        | "No PR found."                                                      |

Jump events logged as `phase_start:forced`.

### Output

```
No session found. Initializing...
Session initialized: a1b2c3d4
Ticket:    PE-1234
Branch:    feature/PE-1234
Starting phase: plan
```

Jump output:

```
Session:   a1b2c3d4
Jumping to: implementation (user-specified)
```

### Errors

| Condition                    | Message                                                                | Next Step                             |
| ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| Already locked               | "Session is already running (PID {pid}). Use `kautopilot stop` first." | `kautopilot stop`                     |
| No config (and no ticket)    | "No config. Run `kautopilot init` first."                              | `kautopilot init`                     |
| Missing spec for impl        | "No approved spec. Complete planning first or use `start --local`."    | `kautopilot start` or `start --local` |
| Missing plan index           | "Plan {N} does not exist."                                             | Check plan number                     |
| No implementation for polish | "No implementation found."                                             | `start --phase impl`                  |
| No PR for polish:poll        | "No PR found."                                                         | `start --phase polish`                |

---

## `status` — Show Session State

Overloaded: no ID = local (current worktree), with ID = global (any directory).

```
kautopilot status
kautopilot status a1b2c3d4
kautopilot status --json
```

### Behavior

| Mode                         | Scope  | Behavior                                                     |
| ---------------------------- | ------ | ------------------------------------------------------------ |
| `kautopilot status`          | Local  | Reconstruct state from `log.jsonl`, show phase/step/duration |
| `kautopilot status a1b2c3d4` | Global | Same reconstruction for session `a1b2c3d4` (any directory)   |
| `kautopilot status --json`   | Local  | Machine-readable JSON output                                 |

### Output

```
Session:   a1b2c3d4
Ticket:    PE-1234
Branch:    feature/PE-1234
Repo:      github.com/atomi/api-server

Phase:     implementation
Step:      running (plan-2)
Status:    running

Duration:  47m 12s
Step:      3m 45s
```

### Errors

| Condition            | Message                              | Next Step         |
| -------------------- | ------------------------------------ | ----------------- |
| No local session     | "No session found in this worktree." | `kautopilot init` |
| Session ID not found | "Session {id} not found in index."   | `kautopilot ps`   |
| Corrupted log        | "Could not parse log.jsonl."         | Check log file    |

---

## `stop` — Kill and Cleanup

Overloaded: no ID = local, with ID = global (kill + optional cleanup).

```
kautopilot stop
kautopilot stop --force
kautopilot stop a1b2c3d4
kautopilot stop a1b2c3d4 --force
```

### Behavior

| Mode                               | Scope  | Behavior                                                         |
| ---------------------------------- | ------ | ---------------------------------------------------------------- |
| `kautopilot stop`                  | Local  | Kill processes, release lock                                     |
| `kautopilot stop --force`          | Local  | Skip confirmation                                                |
| `kautopilot stop a1b2c3d4`         | Global | Kill processes, then prompt to delete session dir + index.db row |
| `kautopilot stop a1b2c3d4 --force` | Global | Kill + delete without confirmation                               |

Stop sequence:

1. Check lock.pid — if no running session, print "Session is not running."
2. Confirm (unless `--force`)
3. Log `stop:started`
4. Kill processes in order:
   - `dev-loop cancel` (graceful, archives run)
   - `kill(-pid, SIGTERM)` on kautopilot process group
   - If not dead in 5s → `kill(-pid, SIGKILL)`
5. Log `stop:completed`
6. Remove `lock.pid`
7. If global mode (ID given): prompt to delete `~/.kautopilot/{id}/` and remove index.db row

### Output

```
Session a1b2c3d4 stopped.
```

Global with delete prompt:

```
? Delete session directory and index entry? (y/N): y
Session a1b2c3d4 stopped and removed.
```

### Errors

| Condition                 | Message                                 | Next Step       |
| ------------------------- | --------------------------------------- | --------------- |
| No lock.pid (not running) | "Session is not running."               | —               |
| Local session not found   | "No session found in this worktree."    | `kautopilot ps` |
| Session ID not found      | "Session {id} not found in index."      | `kautopilot ps` |
| Kill failed               | "Failed to kill process {pid}: {error}" | Manual cleanup  |

---

## `logs` — Tail Event Log

```
kautopilot logs
kautopilot logs plan
kautopilot logs --tail 20
kautopilot logs --json
```

### Behavior

- Reads `~/.kautopilot/{id}/log.jsonl`
- No phase filter → show all events
- With phase → filter events matching that phase prefix
- `--tail N` → show last N entries
- `--json` → raw JSONL output
- Default: human-readable, last 50 entries

### Output

```
10:00:00 setup:started
10:00:01 setup:completed
10:00:02 repo_setup:started
10:00:15 repo_setup:completed ticketId=PE-1234
10:01:00 write_spec:started version=1
...
```

---

## `ps` — List All Sessions

Global: list all sessions across repos (docker ps).

```
kautopilot ps
kautopilot ps --repo atomi
kautopilot ps --all
kautopilot ps --json
```

### Behavior

- Queries `index.db` for all sessions
- Default: only running sessions (has lock.pid with alive process)
- `--all`: include stopped/completed
- `--repo <origin>`: filter by git_root_host (substring match)
- For each session: reconstruct phase/step/duration from log.jsonl
- `--json`: machine-readable output

### Output

```
SESSION   TICKET     REPO                        BRANCH                      PHASE           STATUS
a1b2c3d4  PE-1234    github.com/atomi/api-server  feature/PE-1234-add-auth    implementation  running (47m)
e5f6g7h8  CU-86ev0   github.com/vungle/dashboard  feature/CU-86ev0-refactor   plan            running (12m)
b2c3d4e5  local-a3f  github.com/atomi/cli         feature/test-fix            completed       stopped (2h ago)
```

### Errors

| Condition          | Message                                                         | Next Step         |
| ------------------ | --------------------------------------------------------------- | ----------------- |
| No sessions        | "No sessions found."                                            | `kautopilot init` |
| index.db not found | "No index.db found. Run `kautopilot init` to create a session." | `kautopilot init` |

---

## `org init` — Create or Re-Init Org Ticket Scripts

Create deterministic ticket integration scripts for an org. Re-running overwrites existing scripts (prompts first).

```
kautopilot org init atomi
```

### Behavior

1. Check if `~/.kautopilot/orgs/{name}/` exists
   - Exists → prompt: "Org '{name}' already exists. Overwrite? (y/N)"
   - `--force` → skip prompt
2. Create `~/.kautopilot/orgs/{name}/` directory
3. Generate scaffold scripts for each required interface
4. Open editor for user to customize scripts
5. Validate scripts: run each with `--dry-run` to verify interface compliance

### Org Script Interface

Each org provides four scripts at `~/.kautopilot/orgs/{name}/`:

| Script           | Input                                                | Output                        | Purpose                                |
| ---------------- | ---------------------------------------------------- | ----------------------------- | -------------------------------------- |
| `extract-ticket` | stdin: branch name (e.g. `feature/PE-1234-add-auth`) | stdout: ticket ID (`PE-1234`) | Extract ticket ID from any branch name |
| `get-ticket`     | arg: ticket ID                                       | stdout: ticket markdown       | Fetch ticket title + description       |
| `start-ticket`   | arg: ticket ID                                       | exit code only                | Transition: todo → in progress         |
| `transition`     | arg: ticket ID, arg: from-state, arg: to-state       | exit code only                | Arbitrary state transition             |

All scripts:

- Exit 0 on success, non-zero on failure
- Write errors to stderr
- Are plain shell scripts (bash, sh, or any executable)

### Example: atomi org

```
~/.kautopilot/orgs/atomi/
├── extract-ticket       # parses "PE-1234" from branch, "CU-86ev0" from clickup-style
├── get-ticket           # calls jira API or clickup API for ticket details
├── start-ticket         # POST to Jira transition API
└── transition           # POST to Jira/ClickUp transition API with from/to states
```

`extract-ticket`:

```bash
#!/bin/bash
# Extract Jira ticket from branch name
grep -oE '[A-Z]+-[0-9]+' | head -1
```

`get-ticket`:

```bash
#!/bin/bash
TICKET_ID="$1"
# Fetch from Jira API, output as markdown
curl -s -H "Authorization: Bearer $JIRA_TOKEN" \
  "https://atomi.atlassian.net/rest/api/2/issue/$TICKET_ID" | jq -r '
    "# \(.fields.summary)\n\n\(.fields.description // "No description")\n\n**Status:** \(.fields.status.name)\n**Priority:** \(.fields.priority.name)"
'
```

### Fallback Chain in `init`

When `kautopilot init PE-1234` runs:

```
1. Detect git remote → extract org name (e.g., "github.com/atomi" → "atomi")
2. Check ~/.kautopilot/orgs/atomi/ → scripts exist?
   ├─ YES → use org scripts (deterministic, no LLM)
   │        - extract-ticket to validate branch naming
   │        - get-ticket to fetch ticket content
   │        - start-ticket to transition to in-progress
   └─ NO  → check SETUP.md in repo root
            ├─ YES → use SETUP.md config
            └─ NO  → LLM detection (spawn --print, detect from CI/README/git)
                     └─ on failure → ask user via inquirer
```

### Local Mode: All Ticket Ops are No-Ops

In `--local` mode, `runtime.local: true` → all ticket operations are skipped:

- `extract-ticket` → not called (ticket ID is `local-{random}`)
- `get-ticket` → not called (ticket.md written by TTY handoff)
- `start-ticket` / `transition` → not called (no ticket system)

No org scripts needed for local mode.

### Output

```
kautopilot org init atomi
Org:       atomi
Scripts:   ~/.kautopilot/orgs/atomi/
  extract-ticket    ✓ interface valid
  get-ticket        ✓ interface valid
  start-ticket      ✓ interface valid
  transition        ✓ interface valid

Edit scripts to customize. Press Enter when done.
[opens $EDITOR on ~/.kautopilot/orgs/atomi/]
```

Re-init:

```
kautopilot org init atomi
Org 'atomi' already exists. Overwrite? (y/N): y
Scripts:   ~/.kautopilot/orgs/atomi/
  extract-ticket    ✓ interface valid
  get-ticket        ✓ interface valid
  start-ticket      ✓ interface valid
  transition        ✓ interface valid
```

```
kautopilot org ls
ORG        SCRIPTS
atomi      extract-ticket, get-ticket, start-ticket, transition
vungle     extract-ticket, get-ticket
```

### Errors

| Condition               | Message                                                 | Next Step       |
| ----------------------- | ------------------------------------------------------- | --------------- |
| Script fails validation | "Script {name} failed: {error}"                         | Edit script     |
| Script non-executable   | "Script {name} is not executable. Run: chmod +x {path}" | Fix permissions |

---

## Design Decisions

### Start auto-inits

- `start` auto-runs init if the session doesn't exist yet. No need to call `init` separately — but you can for explicit setup.
- `init` creates the session, writes config, fetches ticket (or spawns TTY for local mode), creates branch. Does NOT run phases.
- `start` begins execution. Can be called multiple times (retry, jump phases).
- Both `start` and `init` accept `--local`.

### Local Mode

- `kautopilot init --local` or `kautopilot start --local` → generates `local-{shortRandom}` ticket ID
- Spawns Claude interactively (TTY handoff) to generate: `ticket.md`, `v1/spec.md`, `v1/plans/plan-1.md`
- Same directory structure as non-local — just the init path differs (TTY instead of ticket fetch + manual spec writing)
- Config gets `runtime.local: true`, `repo.ticketSystem: null`
- Once artifacts exist, user can jump to any phase: `start --phase impl`, `start --phase polish`
- No `--interactive` flag needed — local mode always uses TTY for init

### Org Scripts (Deterministic Ticket Integration)

- Org scripts at `~/.kautopilot/orgs/{name}/` provide a deterministic interface for ticket operations — no LLM needed when they exist.
- The fallback chain (org scripts → SETUP.md → LLM → user) means kautopilot works out of the box for any repo, but is fully deterministic for known orgs.
- Scripts are plain shell — easy to write, test, and version. No dependency on kautopilot internals.
- Local mode doesn't need ticket scripts at all — all ticket ops are no-ops.
- Org name is derived from git remote: `git@github.com:atomi/api-server.git` → `atomi`. Configurable via `repo.org` in config.yaml.

### PID Locking

- Location: `~/.kautopilot/{id}/lock.pid`
- Content: PID as decimal string
- `start` checks lock before running: if PID file exists + process alive → error
- Stale lock (process dead) → auto-cleanup with warning
- `stop` removes lock after killing processes
- Signal handlers (SIGINT, SIGTERM, exit) clean up lock on kautopilot exit
- `init` also acquires lock (prevents concurrent init on same worktree)

---

## Event Log Entries

New event types added by CLI commands:

```jsonl
{"ts":"...","event":"init:started"}
{"ts":"...","event":"init:completed","id":"a1b2c3d4","ticketId":"PE-1234","local":false}
{"ts":"...","event":"start:started","phase":"plan"}
{"ts":"...","event":"start:completed","phase":"plan"}
{"ts":"...","event":"phase_start:forced","to":"implementation","reason":"user_start_phase"}
{"ts":"...","event":"stop:started"}
{"ts":"...","event":"stop:completed","processesKilled":2}
{"ts":"...","event":"stop:completed","processesKilled":2,"global":true,"deleted":true}
```

Existing phase events remain unchanged — these new events wrap around them.
