# Kagent v3 Specification

## Overview

Kagent is a CLI tool that orchestrates AI agents in iterative development cycles. The system operates at three hierarchical levels: **Tasks**, **Runs**, and **Loops**.

| Level    | Purpose                               | Completion Criteria                    |
| -------- | ------------------------------------- | -------------------------------------- |
| **Task** | Complete a ticket → ready-to-merge PR | CI passes + required reviewers approve |
| **Run**  | Implement spec.md → one commit        | All AI reviewers approve               |
| **Loop** | One iteration within a run            | Implementer + reviewers complete       |

**Key Architectural Notes:**

- **Runs are first-class** and can operate independently of tasks
- **Tasks are optional** wrappers that add ticket/PR integration around runs
- **Specs live at run level** — each run has its own `spec.md`
- **Pointer-based** — uses ordinal numbers and pointer files, no file movement

## Git Safety Rules

**CRITICAL: These rules must NEVER be violated by any agent or automation.**

### Forbidden Operations

1. **NEVER force push** (`git push --force`, `git push -f`, `git push --force-with-lease`)
2. **NEVER push to branches other than the task's working branch**
3. **NEVER push directly to `main`, `master`, or any protected branch**
4. **NEVER delete remote branches**
5. **NEVER rebase commits that have been pushed**
6. **NEVER use `git reset --hard` on pushed commits**

### Required Practices

1. Only push to the currently checked-out branch
2. Use regular `git push` (with upstream tracking)
3. If push fails due to conflicts, pull and merge (never force)
4. If pull/merge fails, stop and wait for user intervention
5. Verify current branch before any push operation

### Branch Assumption

The task branch must already exist before starting kagent. User is responsible for creating and checking out the branch. Kagent only pushes to the currently checked-out branch.

### Pull/Merge Failure

If `git pull` or merge fails (conflicts, network issues, etc.):

1. Mark the current loop as **failed**
2. Stop execution immediately
3. Prompt user for manual intervention
4. User must resolve the issue and restart

---

## Core Concepts

### Hierarchy

```
Project
├── TICKETS.md                    # Ticket system configuration (repo-level)
└── {state-dir}/                  # Configurable, default: .kagent
    ├── config.json               # Agent configuration
    ├── .current-task             # Pointer: "1" (ordinal of active task)
    ├── .current-run              # Pointer: "5" (ordinal of active run)
    │
    ├── task-1/                   # Task folder (optional, wraps runs)
    │   ├── task.json             # Task metadata (ticket, branch, PR)
    │   └── .current-run          # Pointer: "3" (active run for this task)
    │
    ├── task-2/                   # Another task
    │
    ├── run-1/                    # Run folder (can be standalone or in task)
    │   ├── run.json              # Run metadata (includes optional taskId)
    │   ├── .current-loop         # Pointer: "2" (active loop)
    │   ├── spec.md               # What to implement (run-level)
    │   ├── current/              # Active loop (always named "current")
    │   │   ├── agents/           # Agent state files
    │   │   ├── evidence/         # Implementer outputs
    │   │   ├── learnings/        # Loop-scoped learnings only
    │   │   ├── reviews/          # Reviewer outputs
    │   │   ├── verdicts/         # Reviewer decisions
    │   │   └── logs/             # Raw agent logs
    │   └── loop-1/, loop-2/, ... # Completed loops
    │
    ├── run-2/                    # Another run
    └── run-N/
```

**Note:** The state directory is configurable via `--state-dir` flag or `KAGENT_STATE_DIR` environment variable. Default is `.kagent`.

### Task

A **Task** represents work from a ticket (GitHub Issue, Jira, etc.) through to a PR that is ready to merge (CI passed + required reviewers approved). One task = one PR with potentially multiple commits (runs).

**Prerequisites:**

- User must already be on the correct feature branch
- Branch must already exist and be checked out

**Task lifecycle:**

1. Detect ticket ID from branch (or prompt if detection fails) → fetch ticket details
2. Move ticket to "In Progress" status
3. Create first run and generate initial spec from ticket (AI-assisted)
4. Execute run → if approved, commit and push
5. Create or update PR
6. Poll for CI status and human reviews
7. If feedback received → create new run with updated spec
8. Repeat until CI passes and required reviewers approve
9. Move ticket to "In Review" status (ready to merge)
10. Notify user (manual merge)
11. On merge → move ticket to "Done" status

**Task ↔ Run Relationship:**

- Tasks contain runs, but runs don't need tasks
- `task.json.taskId` references the active run by ordinal
- `run.json.taskId` optionally references the parent task
- When `kagent task` creates a run, both references are set
- Standalone runs (from `kagent init` + `kagent run`) have `taskId: null`

### Run

A **Run** is a complete execution cycle for a `spec.md`. One successful run = one commit.

**Two Modes of Operation:**

1. **Standalone Mode** (`kagent init` + `kagent run`):
   - User writes `spec.md` manually or from a template
   - No ticket, no PR, no CI integration
   - One successful run = local commit (optional push)
   - Useful for: experiments, refactoring, projects without ticket system

2. **Task Mode** (`kagent task`):
   - Spec initially generated from ticket by AI
   - User can edit before run starts
   - After each run, AI generates new spec based on CI/review feedback
   - Runs continue until ticket is complete and PR is approved

**Run lifecycle:**

1. Initialize `run-{N}/` directory with `spec.md`
2. Execute loops until all reviewers approve
3. On success:
   - Stage all changes
   - Commit with message following conventions
   - Pull from remote (to sync any changes)
   - If pull/merge fails → mark loop as FAILED, stop, prompt user
   - Push to task branch (NEVER force push)
   - If push fails → mark loop as FAILED, prompt user
   - If in task mode: create PR on first push, update on subsequent pushes
4. On failure (max iterations/cancelled): do not push; stop and prompt user

**Cancellation Detection:**

The loop re-reads `run.json` between phases. If the status is `cancelled`, stop immediately.

**Cancellation can happen two ways:**

1. **User runs `kagent cancel`:**
   - Marks current run's `run.json` status as "cancelled"
   - Kills all tmux sessions for this run
   - Clears the `.current-run` pointer (or updates to different run)
   - Does NOT immediately delete data — run remains in `run-{N}/` for inspection

2. **Process crash / system failure:**
   - On restart, check `run.json` status
   - If "running" but no active agents → mark as "failed"
   - Kill any orphaned tmux sessions

**Phase Boundary Check:**

- Before starting each phase (implementer → reviewers → decision)
- Re-read `run.json`
- If status is "cancelled" or `run.json` no longer exists:
  - Stop immediately
  - Clear the `.current-run` pointer
  - Return to user with status

### Loop

A **Loop** is a single iteration within a run:

1. Implementer phase - AI implements/fixes based on spec + learnings
2. Reviewer phase - Multiple AI reviewers evaluate the implementation
3. Decision - Continue to next loop or complete

When a loop ends:

- Move `current/` to `loop-{N}/`
- Create fresh `current/` structure
- Learnings from `loop-{N}/learnings/` are available to next loop (by reading them)
- Review feedback from `loop-{N}/reviews/` is passed to next implementer
- **Working tree changes are preserved** between loops (no git reset)

**Learnings Scope:**

Learnings are **loop-scoped only**, not accumulated at task or run level.

- Each loop has its own `learnings/learnings.md`
- Next loop can read previous loops' learnings from `loop-{N}/learnings/`
- No automatic accumulation or aggregation

---

## Configuration

### TICKETS.md (Repository-Level)

Located at the repository root, this file tells kagent where tickets come from and how to interact with them.

```markdown
# Ticket Configuration

## Source

Type: github

# Options: github, jira, linear, clickup

## Ticket ID Detection

# Pattern to extract ticket ID from branch name

# Use {ticket-id} as placeholder for the ID

Branch Pattern: feat/{ticket-id}-\*

# Examples:

# feat/GH-123-add-auth → GH-123

# fix/PROJ-456-bug-fix → PROJ-456

# feature/ISSUE-789-thing → ISSUE-789

# Extraction is best-effort and fuzzy (no regex semantics).

# If branch doesn't match or is ambiguous, prompt user for ticket ID.

## Access Method

Method: cli

# Options: cli, browser, mcp

# - cli: Use gh/jira CLI to fetch ticket details

# - browser: Open the ticket in a browser (implementation-defined)

# - mcp: Use MCP tools to fetch ticket details

## CLI Commands (if method is cli)

Fetch: gh issue view {id} --json title,body,labels,assignees,state

# For Jira: jira issue view {id} --template json

## Ticket Transitions

# Define commands to run at each phase to update ticket status

# Use {id} as placeholder for ticket ID

on_start: |
gh issue edit {id} --add-label "in-progress" --remove-label "todo"

on_ready_to_merge: |
gh issue edit {id} --add-label "in-review" --remove-label "in-progress"

on_completion: |
gh issue close {id}

# For Jira:

# on_start: jira issue transition {id} "In Progress"

# on_ready_to_merge: jira issue transition {id} "In Review"

# on_completion: jira issue transition {id} "Done"

## Commit/PR Conventions

Commit messages follow repository conventions. PRs use the repository template if present; otherwise use a generic summary.
```

**Ticket ID Detection:**

1. Extract from current branch name using "Branch Pattern" from TICKETS.md
2. If branch doesn't match pattern → prompt user for ticket ID
3. User can also provide explicitly: `kagent task --ticket PROJ-123`

### config.json

```json
{
  "implementers": [
    { "binary": "claude", "weight": 70 },
    { "binary": "claude-opus", "weight": 20 },
    { "binary": "gemini-pro", "weight": 10 }
  ],
  "reviewers": ["claude-reviewer-1", "claude-reviewer-2"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15
}
```

| Field                   | Type     | Default                             | Description                             |
| ----------------------- | -------- | ----------------------------------- | --------------------------------------- |
| `implementers`          | array    | `[{binary: "claude", weight: 100}]` | Implementer binaries with weights       |
| `implementers[].binary` | string   | -                                   | Binary name for implementer             |
| `implementers[].weight` | number   | -                                   | Selection weight (higher = more likely) |
| `reviewers`             | string[] | `["claude"]`                        | Binary names for reviewer agents        |
| `maxIterations`         | number   | 10                                  | Maximum loops per run                   |
| `implementerTimeout`    | number   | 30                                  | Implementer timeout in minutes          |
| `reviewerTimeout`       | number   | 15                                  | Reviewer timeout in minutes             |

**Implementer Selection:**

- During each implementing phase, one implementer is randomly selected based on weights
- Weights are relative: `[70, 20, 10]` means 70%, 20%, 10% probability
- Selection is recorded in agent state for reproducibility

### spec.md

**Location:** `{state-dir}/run-{N}/spec.md`

Markdown file describing what needs to be implemented for this specific run.

**Creation:**

- **Standalone mode:** User creates `spec.md` manually, or from a template
- **Task mode:** AI generates initial `spec.md` from ticket title + body

**Evolution (Task Mode Only):**

When a run completes but CI fails or reviews come back:

1. AI reads feedback:
   - CI: failure logs, error messages
   - Reviews: comments, change requests
2. AI generates new spec for next run:
   - Identifies what needs to change
   - Preserves completed requirements
   - Adds new requirements from feedback
   - Marks addressed feedback
3. New run is created with updated `spec.md`

**Spec Scope:**

Each run has its own `spec.md`. The spec defines:

- What needs to be implemented
- Acceptance criteria
- Any constraints or requirements

When a run completes successfully, its `spec.md` is considered fulfilled.

---

## Directory Structure

### Pointer-Based Architecture

**No file movement.** Pointer files track what's active:

```
{state-dir}/                      # Configurable, default: .kagent
│
├── config.json                   # Agent configuration
├── .current-task                 # Pointer: "1" (ordinal of active task, empty if none)
├── .current-run                  # Pointer: "5" (ordinal of active run)
│
├── task-1/                       # Task folder (optional)
│   ├── task.json                 # Task metadata (ticket, branch, PR)
│   ├── .current-run              # Pointer: "3" (active run for this task)
│   └── (run data lives at top level, not nested)
│
├── task-2/                       # Another task
│
├── run-1/                        # Run folder (can be standalone or in task)
│   ├── run.json                  # Run metadata (includes optional taskId)
│   ├── .current-loop             # Pointer: "2" (active loop)
│   ├── spec.md                   # What to implement (run-level)
│   ├── current/                  # Active loop (always named "current")
│   │   ├── agents/
│   │   │   ├── implementer.json
│   │   │   └── reviewer-{i}.json
│   │   ├── evidence/
│   │   │   ├── build-output.log
│   │   │   ├── test-output.log
│   │   │   └── evidence.md
│   │   ├── learnings/            # Loop-scoped only
│   │   │   └── learnings.md
│   │   ├── reviews/
│   │   │   └── reviewer-{i}.md
│   │   ├── verdicts/
│   │   │   └── reviewer-{i}.json
│   │   └── logs/
│   │       ├── implementer.jsonl
│   │       └── reviewer-{i}.jsonl
│   └── loop-1/, loop-2/, ...     # Completed loops
│
├── run-2/                        # Another run
└── run-N/
```

**Pointer Resolution:**

- `.current-task` → which `task-N/` is active (or empty if no task)
- `.current-run` → which `run-N/` is active
- `task-N/.current-run` → which run is active for this task
- `run-N/.current-loop` → which loop is active within this run

**Historical data is implicit:**

- Old runs/tasks/loops remain in their directories
- Active ones are pointed to by `.current-*` files
- Everything is discoverable by listing directories
- No file movement — just create new `run-{N+1}/` and update pointer

---

## Pointer Resolution

### Finding the Active Run

```typescript
function getActiveRun(): RunPath | null {
  // 1. Check explicit pointer
  if (exists('.current-run')) {
    const ordinal = read('.current-run');
    return `run-${ordinal}`;
  }

  // 2. Find highest numbered run
  const runs = listDirectories('run-*');
  if (runs.length === 0) return null;

  const highest = runs.sort().last(); // run-5 > run-3
  return highest;
}
```

### Starting a New Run

```typescript
function startNewRun(taskId?: number): number {
  // 1. Find next ordinal
  const runs = listDirectories('run-*');
  const nextOrdinal = runs.length + 1;

  // 2. Create run directory
  const runDir = `run-${nextOrdinal}`;
  createDirectory(runDir);

  // 3. Initialize run.json
  write(`${runDir}/run.json`, {
    id: nextOrdinal,
    taskId: taskId ?? null,
    status: 'running',
    currentLoop: 0,
  });

  // 4. Update pointer
  write('.current-run', String(nextOrdinal));

  if (taskId) {
    write(`task-${taskId}/.current-run`, String(nextOrdinal));
  }

  return nextOrdinal;
}
```

### Completing a Loop (Starting Next)

```typescript
function completeLoop(runOrdinal: number): void {
  const runDir = `run-${runOrdinal}`;

  // 1. Read current loop pointer
  const currentLoop = read(`${runDir}/.current-loop`);

  // 2. Move current/ to loop-{n}/
  rename(`${runDir}/current`, `${runDir}/loop-${currentLoop}`);

  // 3. Create new current/
  createDirectory(`${runDir}/current`);
  createDirectory(`${runDir}/current/agents`);
  createDirectory(`${runDir}/current/evidence`);
  createDirectory(`${runDir}/current/learnings`);
  createDirectory(`${runDir}/current/reviews`);
  createDirectory(`${runDir}/current/verdicts`);
  createDirectory(`${runDir}/current/logs`);

  // 4. Update loop pointer
  write(`${runDir}/.current-loop`, String(currentLoop + 1));
}
```

### Crash Recovery

```typescript
function recoverState(): RecoveryState {
  const state: RecoveryState = {};

  // 1. What was the active task?
  state.activeTask = exists('.current-task') ? read('.current-task') : null;

  // 2. What was the active run?
  state.activeRun = exists('.current-run') ? read('.current-run') : null;

  // 3. If active run, what was the active loop?
  if (state.activeRun) {
    const runDir = `.kagent/run-${state.activeRun}`;
    state.activeLoop = exists(`${runDir}/.current-loop`) ? read(`${runDir}/.current-loop`) : null;

    // 4. Check which agents were running
    if (state.activeLoop) {
      const loopDir = `${runDir}/current`;
      state.agents = loadAgentStates(`${loopDir}/agents`);

      // 5. Kill orphaned tmux sessions
      killOrphanedSessions(state.agents);
    }
  }

  return state;
}
```

---

## Data Schemas

### task.json

```json
{
  "id": 1,
  "runId": 5,
  "ticket": {
    "source": "github",
    "id": "123",
    "title": "Add user authentication",
    "body": "...",
    "status": "in_progress"
  },
  "branch": "feat/GH-123-add-user-auth",
  "pr": {
    "number": 456,
    "url": "https://github.com/org/repo/pull/456",
    "status": "open"
  },
  "status": "running",
  "startedAt": "2025-01-27T10:00:00Z",
  "completedAt": null
}
```

| Field           | Type         | Description                                                                   |
| --------------- | ------------ | ----------------------------------------------------------------------------- |
| `id`            | number       | Ordinal task identifier (1, 2, 3, ...)                                        |
| `runId`         | number       | Ordinal of the currently active run for this task                             |
| `ticket.source` | enum         | `github`, `jira`, `linear`, `clickup`                                         |
| `ticket.id`     | string       | Ticket ID (auto-detected from branch or user-provided)                        |
| `ticket.title`  | string       | Ticket title                                                                  |
| `ticket.body`   | string       | Ticket description                                                            |
| `ticket.status` | string       | Current ticket status (tracked for transitions)                               |
| `branch`        | string       | Branch name (recorded at task init for reference)                             |
| `pr.number`     | number       | PR number (null if not created)                                               |
| `pr.url`        | string       | PR URL                                                                        |
| `pr.status`     | enum         | `draft`, `open`, `merged`, `closed`                                           |
| `status`        | enum         | `running`, `waiting_ci`, `waiting_review`, `completed`, `abandoned`, `failed` |
| `startedAt`     | ISO datetime | Task start time                                                               |
| `completedAt`   | ISO datetime | Task end time                                                                 |

**Note:** Branch is recorded at task initialization for reference/history. Kagent still only pushes to the currently checked-out branch.

### run.json

```json
{
  "id": 5,
  "taskId": 1,
  "status": "running",
  "currentLoop": 2,
  "startedAt": "2025-01-27T10:00:00Z",
  "completedAt": null,
  "result": null
}
```

| Field         | Type         | Description                                                             |
| ------------- | ------------ | ----------------------------------------------------------------------- |
| `id`          | number       | Ordinal run identifier (1, 2, 3, ...)                                   |
| `taskId`      | number\|null | Parent task ordinal (null if standalone run)                            |
| `status`      | enum         | `running`, `completed`, `cancelled`, `failed`                           |
| `currentLoop` | number       | Current loop number (1-indexed)                                         |
| `startedAt`   | ISO datetime | Run start time                                                          |
| `completedAt` | ISO datetime | Run end time (null if running)                                          |
| `result`      | enum         | `approved`, `rejected`, `max_iterations`, `cancelled` (null if running) |

### Agent State: `agents/{role}.json`

Each agent (implementer and each reviewer) maintains its own state file:

```json
{
  "id": "session-uuid",
  "role": "implementer",
  "reviewerIndex": null,
  "binary": "claude",
  "status": "running",
  "phase": "executing",
  "tmuxSession": "kagent-5-2-impl",
  "pid": 12345,
  "lastHeartbeat": "2025-01-27T10:10:00Z",
  "iteration": 2,
  "startedAt": "2025-01-27T10:05:00Z",
  "completedAt": null,
  "exitCode": null,
  "timedOut": false,
  "verdict": null
}
```

| Field           | Type         | Description                                           |
| --------------- | ------------ | ----------------------------------------------------- |
| `id`            | string       | Unique session identifier                             |
| `role`          | enum         | `implementer`, `reviewer`                             |
| `reviewerIndex` | number       | Index for reviewers (null for implementer)            |
| `binary`        | string       | CLI binary used                                       |
| `status`        | enum         | `pending`, `running`, `completed`, `error`, `timeout` |
| `phase`         | enum         | `starting`, `executing`, `finalizing`                 |
| `tmuxSession`   | string       | Tmux session name                                     |
| `pid`           | number       | Process ID for crash detection                        |
| `lastHeartbeat` | ISO datetime | Last heartbeat timestamp                              |
| `iteration`     | number       | Loop number this agent belongs to                     |
| `startedAt`     | ISO datetime | Agent start time                                      |
| `completedAt`   | ISO datetime | Agent end time                                        |
| `exitCode`      | number       | Process exit code                                     |
| `timedOut`      | boolean      | Whether agent timed out                               |
| `verdict`       | enum         | `approved`, `rejected` (reviewers only)               |

### Verdict: `verdicts/reviewer-{i}.json`

```json
{
  "verdict": "approved",
  "reasoning": "Implementation meets all spec requirements..."
}
```

---

## Logging & Streaming

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Execution                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  cat {prompt} | {binary} --output-format stream-json 2>&1       │
│                              │                                   │
│                              ▼                                   │
│                       ┌──────────┐                               │
│                       │   tee    │                               │
│                       └────┬─────┘                               │
│                            │                                     │
│              ┌─────────────┴─────────────┐                       │
│              │                           │                       │
│              ▼                           ▼                       │
│    ┌─────────────────┐         ┌─────────────────┐              │
│    │ logs/{agent}.jsonl │       │ kagent format │              │
│    │ (raw JSON lines)│         │ (pretty print)  │              │
│    └─────────────────┘         └─────────────────┘              │
│                                         │                        │
│                                         ▼                        │
│                                   Terminal/Tmux                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Principle: Unified Formatter

The **same formatter** is used for:

1. **Live streaming** - Inside tmux sessions during execution
2. **Log viewing** - When running `kagent logs view`

This is achieved by making `kagent format` a standalone streaming subcommand:

- Reads JSON lines from stdin
- Pretty prints to stdout
- Can be piped from any source (live agent, stored log file)

### Execution Command Template

```bash
cat "{promptFile}" | {binary} --dangerously-skip-permissions \
  --verbose --print --output-format stream-json 2>&1 | \
  tee "{logsDir}/{agent}.jsonl" | \
  kagent format
```

### Log Storage Format

Logs are stored as JSON Lines (`.jsonl`):

- One JSON event per line
- Preserves complete Claude output
- Can be replayed through formatter later

### Log Formatter Output

The formatter produces **pretty-printed, human-readable output** (not raw JSON). The same formatter is used for both live streaming and log viewing.

**Output Format:**

```
══════════════════════════════════════════════════════════════
  SESSION START
  cwd: /path/to/project
  session: abc123
══════════════════════════════════════════════════════════════

┌─ CLAUDE ─────────────────────────────────────────────────────
│ I'll start by reading the specification to understand
│ what needs to be implemented.
└──────────────────────────────────────────────────────────────

  ⚡ Read
     /path/to/spec.md

     ↳ /path/to/spec.md
     │ # Specification
     │ ## Requirements
     │ - Feature A
     │ ... (12 more lines)

┌─ CLAUDE ─────────────────────────────────────────────────────
│ Now I'll implement the feature...
└──────────────────────────────────────────────────────────────

  ⚡ Edit
     /src/feature.ts
     - old code here
     + new code here

  ⚡ Bash
     $ npm test

     │ PASS src/feature.test.ts
     │ ✓ should do something (5ms)

══════════════════════════════════════════════════════════════
  SESSION COMPLETE
══════════════════════════════════════════════════════════════
  Duration: 5m 23s
  Turns: 12
  Cost: $0.45

  Result:
  Implementation complete. All tests passing.
```

**Formatting Rules:**

| Event Type           | Format                               |
| -------------------- | ------------------------------------ |
| `system.init`        | Yellow box with session info         |
| `assistant` text     | Green bordered box                   |
| `assistant` tool_use | Blue tool name + dimmed input        |
| `user` tool_result   | Dimmed output, truncated to 15 lines |
| `result`             | Magenta box with duration/turns/cost |

**Tool Input Formatting:**

| Tool        | Format                                |
| ----------- | ------------------------------------- |
| `Read`      | File path                             |
| `Write`     | File path + content preview (5 lines) |
| `Edit`      | File path + diff (`- old` / `+ new`)  |
| `Bash`      | `$ command`                           |
| `Glob`      | Pattern + path                        |
| `Grep`      | `/pattern/` + path                    |
| `TodoWrite` | Checkboxes (`✓`, `→`, `○`)            |
| `Task`      | `[subagent_type] description`         |
| Other       | Compact JSON (truncated to 200 chars) |

**Truncation:**

- Tool results: max 15 lines, then `... (N more lines)`
- Line length: max 100 chars
- Long JSON: max 200 chars

### Formatter Reference Implementation

```typescript
import pc from 'picocolors';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
}

interface Message {
  role?: string;
  content?: ContentBlock[];
}

interface LogEntry {
  type: string;
  subtype?: string;
  message?: Message | string;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  cwd?: string;
  session_id?: string;
}

export function formatLogEntry(entry: LogEntry): void {
  switch (entry.type) {
    case 'system':
      formatSystemEntry(entry);
      break;
    case 'assistant':
      formatAssistantEntry(entry);
      break;
    case 'user':
      formatUserEntry(entry);
      break;
    case 'result':
      formatFinalResult(entry);
      break;
    default:
      console.log(pc.dim(`[${entry.type}]`));
  }
}

function formatSystemEntry(entry: LogEntry): void {
  if (entry.subtype === 'init') {
    console.log(pc.yellow('══════════════════════════════════════════════════════════════'));
    console.log(pc.yellow(`  SESSION START`));
    if (entry.cwd) console.log(pc.dim(`  cwd: ${entry.cwd}`));
    if (entry.session_id) console.log(pc.dim(`  session: ${entry.session_id}`));
    console.log(pc.yellow('══════════════════════════════════════════════════════════════'));
  } else if (typeof entry.message === 'string') {
    console.log(pc.yellow(`[system] ${entry.message}`));
  }
}

function formatAssistantEntry(entry: LogEntry): void {
  const message = entry.message as Message | undefined;
  if (!message?.content) return;

  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      console.log(pc.green('┌─ CLAUDE ─────────────────────────────────────────────────────'));
      for (const line of block.text.split('\n')) {
        console.log(pc.green('│ ') + line);
      }
      console.log(pc.green('└──────────────────────────────────────────────────────────────'));
    } else if (block.type === 'tool_use' && block.name) {
      console.log(pc.blue(`  ⚡ ${block.name}`));
      if (block.input) {
        const formatted = formatToolInput(block.name, block.input);
        for (const line of formatted.split('\n')) {
          console.log(pc.dim(`     ${line}`));
        }
      }
    }
  }
}

function formatUserEntry(entry: LogEntry): void {
  const message = entry.message as Message | undefined;
  if (!message?.content) return;

  for (const block of message.content) {
    if (block.type === 'tool_result' && block.content) {
      const lines = block.content.split('\n');
      const maxLines = 15;
      const displayLines = lines.slice(0, maxLines);

      for (const line of displayLines) {
        const truncatedLine = line.length > 100 ? line.slice(0, 100) + '...' : line;
        console.log(pc.dim(`     │ ${truncatedLine}`));
      }

      if (lines.length > maxLines) {
        console.log(pc.dim(`     │ ... (${lines.length - maxLines} more lines)`));
      }
    }
  }
}

function formatFinalResult(entry: LogEntry): void {
  console.log(pc.magenta('══════════════════════════════════════════════════════════════'));
  console.log(pc.magenta('  SESSION COMPLETE'));
  console.log(pc.magenta('══════════════════════════════════════════════════════════════'));

  if (entry.duration_ms) {
    const mins = Math.floor(entry.duration_ms / 60000);
    const secs = Math.floor((entry.duration_ms % 60000) / 1000);
    console.log(pc.dim(`  Duration: ${mins}m ${secs}s`));
  }
  if (entry.num_turns) {
    console.log(pc.dim(`  Turns: ${entry.num_turns}`));
  }
  if (entry.total_cost_usd) {
    console.log(pc.dim(`  Cost: $${entry.total_cost_usd.toFixed(2)}`));
  }
  if (entry.result) {
    console.log(pc.white('  Result:'));
    for (const line of entry.result.split('\n')) {
      console.log(`  ${line}`);
    }
  }
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `${input.file_path}`;
    case 'Write': {
      const content = (input.content as string)?.split('\n').slice(0, 5).join('\n') || '';
      return `${input.file_path}\n${truncate(content, 200)}`;
    }
    case 'Edit':
      return `${input.file_path}\n- ${truncate(input.old_string as string, 100)}\n+ ${truncate(input.new_string as string, 100)}`;
    case 'Bash':
      return `$ ${input.command}`;
    case 'Glob':
      return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
    case 'Grep':
      return `/${input.pattern}/${input.path ? ` in ${input.path}` : ''}`;
    case 'TodoWrite': {
      const todos = input.todos as Array<{ content: string; status: string }> | undefined;
      if (todos) {
        return todos
          .map(t => {
            const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
            return `${icon} ${t.content}`;
          })
          .join('\n');
      }
      return JSON.stringify(input).slice(0, 200);
    }
    case 'Task':
      return `[${input.subagent_type}] ${input.description || ''}\n${truncate(input.prompt as string, 150)}`;
    default:
      const json = JSON.stringify(input);
      return json.length > 200 ? json.slice(0, 200) + '...' : json;
  }
}

function truncate(str: string | undefined, maxLen: number): string {
  if (!str) return '';
  const single = str.replace(/\n/g, ' ').trim();
  return single.length <= maxLen ? single : single.slice(0, maxLen) + '...';
}
```

---

## CLI Commands

### Interactive Mode

Most viewing commands support **interactive mode** when called without arguments. This allows users to browse and select options without knowing exact IDs or names.

Interactive mode uses arrow keys and fuzzy search to navigate:

- Run selection → shows run ID, date, status, loop count
- Loop selection → shows loop number, verdict, duration
- Agent selection → shows role, status, binary

Example flows:

```bash
# Interactive: prompts for run, then loop, then agent
$ kagent logs view
? Select run: (Use arrow keys)
❯ abc12345 - Jan 27 - completed (3 loops)
  def67890 - Jan 26 - cancelled (1 loop)

? Select loop: (Use arrow keys)
❯ Loop 3 - approved - 5m 23s
  Loop 2 - rejected - 8m 12s
  Loop 1 - rejected - 12m 45s

? Select agent: (Use arrow keys)
❯ implementer - completed
  reviewer-0 - approved
  reviewer-1 - approved

# Direct: skip prompts with arguments
$ kagent logs view --run abc12345 --loop 2 implementer
```

---

### `kagent task`

Start or resume a task from a ticket.

```bash
kagent task [options]
kagent task --resume

Options:
  --ticket <id>         Explicit ticket ID (e.g., "PROJ-123", "GH-456")
  --source <type>       Force ticket source (github, jira, linear, clickup)
  --state-dir <path>    State directory (default: .kagent)
  --resume              Resume existing task
```

**Prerequisites:**

- Must already be on a feature branch (not main/master)
- Branch must exist and be checked out

**Behavior:**

1. Verify on feature branch (fail if on main/master)
2. Load TICKETS.md configuration
3. If `--resume`:
   - Load existing task state
   - Continue from where it left off
4. If new task:
   - Detect ticket ID:
     a. If `--ticket` provided → use that
     b. Else → extract from branch name using TICKETS.md "Branch Pattern"
     c. If extraction fails → prompt user interactively
   - Fetch ticket details (based on TICKETS.md access method)
   - Move ticket to "In Progress"
   - Generate initial spec from ticket (AI-assisted)
   - Initialize task state
5. Execute task loop (runs → commit → PR → wait → repeat)

### `kagent task status`

Show current task status including PR and CI state.

```bash
kagent task status [options]

Options:
  --json    Output as JSON
  --watch   Continuously poll and update display
```

**Output:**

```
Task: feat/GH-123-add-user-auth
Ticket: #123 - Add user authentication
PR: #456 (open) - https://github.com/org/repo/pull/456

Status: waiting_review
  CI: ✓ passed (3m ago)
  Reviews: 1/2 approved
    ✓ alice - approved
    ✗ bob - changes requested: "Need error handling for edge cases"

Run: 2 (completed)
  Loops: 3
  Last commit: abc1234 "feat(GH-123): add auth flow"
```

### `kagent task abandon`

Abandon current task without merging.

```bash
kagent task abandon [options]

Options:
  --force    Skip confirmation
  --keep-branch    Don't delete the branch
```

### `kagent task check`

Manually trigger a check for CI and review status.

```bash
kagent task check [options]

Options:
  --continue    If all checks pass, continue to next action
```

### Modes

- **Task mode (`kagent task`)**: Full automation with ticket/PR/CI integration. Creates task-{N}/ and associated runs. Specs are generated from ticket and updated by AI based on CI/review feedback.

- **Standalone mode (`kagent init` + `kagent run`)**: Single-run workflow without ticket system, PR, or CI integration. Creates run-{N}/ directly (no task wrapper). Specs are user-authored.

### `kagent init`

Initialize project configuration and create a new run with spec.md (standalone mode).

```bash
kagent init [options]

Options:
  --implementers <list>         Comma-separated implementer:weight pairs
                                (e.g., "claude:70,claude-opus:30")
  --reviewers <binaries>        Comma-separated reviewer binaries
  --max-iterations <n>          Max loops per run (default: 10)
  --implementer-timeout <mins>  Implementer timeout (default: 30)
  --reviewer-timeout <mins>     Reviewer timeout (default: 15)
  --state-dir <path>            State directory (default: .kagent)
```

**Behavior:**

1. Creates state directory structure
2. Creates or updates `config.json` with implementers array
3. Creates new `run-{N}/` directory
4. Creates `run-{N}/spec.md` template or opens in editor
5. Updates `.current-run` pointer

**Example:**

```bash
kagent init --implementers "claude:70,claude-opus:20,gemini:10" --reviewers "claude,claude-strict"
```

**Note:** For ticket-based work, use `kagent task` instead. `kagent init` is for standalone runs without ticket/PR integration.

### `kagent run`

Start or resume a development loop run.

```bash
kagent run [options]
kagent run --ordinal <N>    # Run specific run by ordinal

Options:
  --continue    Continue from last loop (don't reset)
```

**Behavior:**

1. Determine which run to execute:
   - If `--ordinal` provided → use that run
   - Else → read `.current-run` pointer
   - If no pointer → prompt user to select or create new run
2. Validate config and spec exist
3. Execute loops until:
   - All reviewers approve (completed)
   - Max iterations reached (failed)
   - User cancellation (cancelled)
   - Cancellation checks occur between phases
4. On successful completion in task mode:
   - Stage, commit, push changes
   - Create or update PR
5. If run failed or cancelled, do not push; prompt user to continue or stop.

**Note:** In standalone mode, `kagent run` does not create PRs or interact with tickets/CI.

### `kagent status`

Show current run and agent status.

```bash
kagent status [ordinal] [options]

Arguments:
  ordinal    Run ordinal to show status for (uses .current-run if omitted)

Options:
  --json    Output as JSON
  --loop    Show specific loop details (interactive selector)
```

**Behavior:**

- If no ordinal provided, reads `.current-run` pointer
- If no pointer, prompts user to select from available runs

**Output:**

```
Run: 5 (running)
Loop: 2 of 10

Agents:
  ● implementer     running   claude       kagent-5-2-impl    pid: 12345
  ● reviewer-0      pending   claude-r1    -
  ● reviewer-1      pending   claude-r2    -

Evidence: ✓ build-output.log, ✓ test-output.log
Learnings: loop-1/learnings/learnings.md
```

### `kagent attach`

Attach to a running agent's tmux session.

```bash
kagent attach [agent]

Arguments:
  agent    Agent to attach to (implementer, reviewer-0, etc.)
```

**Interactive mode (default):** When called without arguments, shows selector of currently running agents with their status and duration:

```
? Select agent to attach: (Use arrow keys)
❯ implementer  - running 5m 23s  - claude     (kagent-5-2-impl)
  reviewer-0   - running 2m 10s  - claude-r1  (kagent-5-2-rev-0)
  reviewer-1   - pending         - claude-r2
```

### `kagent cancel`

Cancel the current run.

```bash
kagent cancel [options]

Options:
  --force    Skip confirmation
```

**Behavior:**

1. Load the active run from `.current-run` pointer
2. Mark the run's `run.json` status as "cancelled"
3. Kill all tmux sessions for this run (matched by run ordinal in session name)
4. The run data remains in `run-{N}/` for inspection
5. Clear the `.current-run` pointer (or update to different run)

**Cancellation Flow:**

- Cancellation marks the run but doesn't immediately stop execution
- At the next phase boundary (implementer → reviewers → decision):
  - Re-read `run.json`
  - If status is "cancelled" → stop immediately
  - Run remains in `run-{N}/` as a record

**Notes:**

- Cancellation is run-scoped; it must never kill tmux sessions from other runs.
- The run ordinal is encoded in the tmux session name, enabling safe filtering.

### `kagent logs`

View and manage agent logs.

```bash
kagent logs list [run-ordinal]
kagent logs view [options] [agent]
kagent logs tail [options] [agent]

Options:
  --loop <n>     Loop number (interactive if omitted)
  --run <n>      Run ordinal (interactive if omitted)
  --raw          Output raw JSON instead of formatted
  --follow, -f   Follow log output (for tail)
```

**Interactive mode:** When `view` or `tail` is called without arguments:

1. Select run (current or from available runs)
2. Select loop (current or completed within run)
3. Select agent (implementer or reviewer-{i})

**View Command:**
The `view` command pipes the log file through the same formatter:

```bash
# Internal implementation:
cat "{state-dir}/run-{N}/loop-{L}/logs/{agent}.jsonl" | kagent format
# or for current loop:
cat "{state-dir}/run-{N}/current/logs/{agent}.jsonl" | kagent format
```

### `kagent history`

Manage run and task history.

```bash
kagent history list [options]
kagent history show <ordinal> [options]

Options:
  --loops        Show loop details
  --verdicts     Show verdict summaries
  --loop <n>     Show specific loop
```

**Interactive mode:** When `list` is called, shows all runs and tasks:

```
Runs:
  5  - completed  - Jan 27  - 3 loops  - (task: 1)
  4  - cancelled - Jan 27  - 1 loop   - (standalone)
  3  - completed - Jan 26  - 2 loops  - (task: 1)

Tasks:
  1  - running   - Jan 27  - PR: #456
```

**Output for `history show <ordinal>`:**

```
Run: 5
Status: completed
Started: Jan 27, 2025 10:00 AM
Completed: Jan 27, 2025 10:25 AM
Duration: 25m 12s

Loops: 3 total
  Loop 1: rejected (2 of 2 reviewers)
  Loop 2: rejected (1 of 2 reviewers)
  Loop 3: approved (2 of 2 reviewers)
```

### `kagent format`

Format Claude stream-json output (used internally and for log viewing).

```bash
kagent format [options]

Options:
  --color     Force color output
  --no-color  Disable color output
```

**Usage:**

```bash
# Live formatting in tmux
cat prompt | claude --output-format stream-json | kagent format

# View stored log
cat {state-dir}/task/run/loop-1/logs/implementer.jsonl | kagent format
```

---

## Task Lifecycle

### Phase 1: Initialization

```
1. Verify prerequisites:
   - User is on a feature branch (not main/master)
   - Branch already exists and is checked out
2. Load TICKETS.md configuration
3. Detect ticket ID:
   - If --ticket flag provided → use that
   - Else → extract from branch name using "Branch Pattern" from TICKETS.md
     Example: branch "feat/GH-123-add-auth" with pattern "feat/{ticket-id}-*" → "GH-123"
   - If extraction fails → prompt user interactively
4. Fetch ticket details based on access method:
   - cli: Run configured fetch command
   - browser: Open the ticket in a browser (implementation-defined), prompt user to confirm they've read it
   - mcp: Use MCP tools to fetch
5. Move ticket to "In Progress" status (run on_start command from TICKETS.md)
6. Create task state in {state-dir}/task-{N}/
7. Create first run:
   - Generate initial spec from ticket (AI-assisted)
   - AI reads ticket title + body
   - AI generates spec.md with requirements
   - User can review/edit before proceeding
8. Update .current-task and .current-run pointers
```

### Phase 2: Implementation (Run Loop)

```
1. Execute current run (see Run/Loop lifecycle below)
   - Each loop within the run selects implementer based on weights
2. On successful run (all AI reviewers approve):
   - Stage all changes
   - Commit with message following repository conventions
   - Pull from remote (to sync any changes)
   - If pull/merge fails:
     → Mark loop as FAILED
     → Stop execution
     → Prompt user: "Merge conflict detected. Please resolve manually and restart."
     → Exit and wait for user
   - Push to task branch (NEVER force push)
   - If push fails:
     → Mark loop as FAILED
     → Prompt user for manual intervention
     → Exit and wait for user
   - If first push (no PR exists yet):
     → Create PR immediately after push
   - Else:
     → PR already exists, push updates it automatically
   - Create next run with updated spec (based on CI/reviews)
3. Update task status to waiting_ci
4. On run failure (max iterations/cancelled): do not push; stop and prompt user for manual input.
```

### Phase 3: CI Monitoring

```
1. Poll CI status via gh CLI:
   gh pr checks {pr-number} --json name,state,conclusion
2. Display progress to user
3. On CI completion:
   - If failed → AI analyzes failure, updates spec, → Phase 2
   - If passed → Phase 4
```

### Phase 4: Review Monitoring

```
1. Poll review status via gh CLI:
   gh pr view {pr-number} --json reviews,comments
2. On new reviews/comments:
   - AI reads all feedback
   - AI categorizes: approval, change request, question, comment
3. If all reviewers approved → Phase 5
4. If changes requested:
   - AI updates spec based on feedback
   - Create new run with updated spec
   - Return to Phase 2 (new run)
```

### Phase 5: Completion

```
1. All conditions met:
   - CI passed
   - All required reviewers approved
2. Move ticket to "In Review" status (ready to merge)
3. Notify user: "Task ready for merge"
4. User manually merges (no auto-merge)
5. On merge detection (via polling):
   - Move ticket to "Done" status (per TICKETS.md transitions)
   - Update task status to completed
   - Archive task to {state-dir}/archive/
```

---

### Spec Update (AI-Assisted, Task Mode Only)

When feedback is received (CI failure or review comments), the AI generates a new spec for the next run:

```
1. Load previous run's spec.md
2. Load feedback:
   - CI: failure logs, error messages
   - Reviews: comments, change requests
3. AI generates new spec for next run:
   - Identifies what needs to change
   - Preserves completed requirements
   - Adds new requirements from feedback
   - Marks addressed feedback
4. Create new run-{N+1}/ directory
5. Write new spec.md to run-{N+1}/spec.md
6. Update pointers (.current-run, task-{M}/.current-run)
```

**Spec Update Prompt Template:**

```markdown
# Spec Update Task

## Previous Run's Specification

{contents of run-{N}/spec.md}

## Feedback to Address

### CI Failures (if any)

{CI error logs}

### Review Comments (if any)

{reviewer comments with author and timestamp}

## Instructions

1. Analyze the feedback carefully
2. Generate a NEW specification for the next run that addresses ALL feedback
3. Do not remove requirements that were already implemented in previous runs
4. Add new sections for new requirements
5. Be specific about what needs to change in this run

Write the new specification to {state-dir}/run-{N+1}/spec.md
```

---

## Loop Lifecycle

### Test/Build Command Discovery (Deterministic)

Auto-detect in order:

1. Makefile targets: `make test`, `make build`
2. Taskfile.yml tasks: `task test`, `task build`
3. justfile recipes: `just test`, `just build`
4. CI configuration commands (use the exact test/build commands from CI)

If none are detected, prompt the user for the commands before running tests/builds.

### Phase 1: Implementer

```
1. Create task/run/current/ directory structure (if first loop) or clear it (do not reset the git working tree)
2. Select implementer binary using weighted random selection:
   - Load implementers array from config.json
   - Calculate total weight
   - Generate random number, select based on cumulative weights
   - Record selected binary in agent state
3. Initialize task/run/current/agents/implementer.json (status: pending, binary: selected)
4. Build implementer prompt:
   - Include spec
   - Include learnings from all previous loops (task/run/loop-*/learnings/)
   - Include review feedback from last loop if rejected
   - Instructions to write evidence and learnings
5. Update agent state (status: running, phase: starting)
6. Execute in tmux:
   - Prompt piped to selected binary
   - Output tee'd to logs and formatter (pretty-printed)
7. On completion:
   - Update agent state (status: completed, exitCode)
   - Verify evidence files created
   - Read learnings.md if exists
```

**Weighted Random Selection Algorithm:**

```typescript
function selectImplementer(implementers: Array<{ binary: string; weight: number }>): string {
  const totalWeight = implementers.reduce((sum, i) => sum + i.weight, 0);
  let random = Math.random() * totalWeight;

  for (const impl of implementers) {
    random -= impl.weight;
    if (random <= 0) {
      return impl.binary;
    }
  }

  return implementers[0].binary; // Fallback
}
```

### Phase 2: Reviewers (Parallel)

```
For each reviewer (parallel):
1. Initialize task/run/current/agents/reviewer-{i}.json (status: pending)
2. Build reviewer prompt:
   - Include spec
   - Reference evidence files in task/run/current/evidence/
   - Strict review criteria
   - Instructions to write review and verdict
3. Update agent state (status: running)
4. Execute in tmux
5. On completion:
   - Parse verdict from task/run/current/verdicts/reviewer-{i}.json
   - Update agent state (verdict: approved/rejected)
```

### Phase 3: Decision

```
1. Collect all verdicts from task/run/current/verdicts/
2. Check consensus:
   - All approved → Run complete
   - Any rejected → Continue to next loop
   - Max iterations → Run failed
3. Complete loop: move `run-{N}/current/` to `run-{N}/loop-{n}/`
4. Create fresh `run-{N}/current/` structure
5. Proceed to Phase 1 of next loop (or end run)
```

### Loop Completion (Before Next Loop)

```
1. Move run-{N}/current/ contents to run-{N}/loop-{n}/
2. Create fresh run-{N}/current/ structure
3. Learnings from run-{N}/loop-{n}/learnings/ are available to next implementer
4. Review feedback from run-{N}/loop-{n}/reviews/ is passed to next implementer
5. Keep working tree changes between loops (no reset).
```

---

## Starting a New Run

When a run completes and a new run starts (due to CI failure or review feedback):

```
1. Create new run-{N+1}/ directory
2. Generate new spec.md for this run (AI-assisted in task mode)
3. Update .current-run pointer to N+1
4. If in task mode, update task-{M}/.current-run pointer
5. Start new run
```

Previous run data remains in run-{N}/ for reference.

## Task Completion

When a task is completed (merged) or abandoned:

```
1. Update task-{N}/task.json status to "completed" or "abandoned"
2. Clear .current-task pointer
3. Task data remains in task-{N}/ for historical reference
```

All tasks, runs, and loops remain on disk for historical reference.

---

## Agent Prompts

### Implementer Prompt Template

```markdown
# Implementation Task

## Specification

{contents of spec.md}

## Learnings from Previous Iterations

{concatenated learnings from all previous loops in current run}

## Previous Review Feedback

{if rejected in previous loop, include reviewer feedback}

## Instructions

1. Read and understand the specification completely
2. If there are learnings or review feedback above, address those issues first
3. Implement the required changes
4. Run ALL tests and verify they pass (see Test/Build Command Discovery)
5. Run the build and verify it succeeds (see Test/Build Command Discovery)
6. Write evidence to {state-dir}/task/run/current/evidence/:
   - build-output.log: Complete build command output
   - test-output.log: Complete test command output
   - evidence.md: Summary of what you verified and how
7. Write learnings to {state-dir}/task/run/current/learnings/learnings.md:
   - Document any roadblocks encountered
   - Note workarounds or discoveries
   - Document any decisions made and why
   - This helps the next iteration if reviewers find issues

## Important

- Do not interact with the user. Work autonomously.
- Be thorough - reviewers will verify your work independently.
- If tests fail, fix them before completing.
- If build fails, fix it before completing.
- Document everything in evidence so reviewers can verify.

## Git Safety - CRITICAL

- NEVER use `git push --force` or `git push -f`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches
- NEVER rebase pushed commits
- If push fails, use `git pull` and merge, never force
```

### Reviewer Prompt Template

````markdown
# Code Review Task

## Specification

{contents of spec.md}

## Your Task

1. Review the current implementation against the specification
2. Check the evidence in {state-dir}/task/run/current/evidence/
3. Run `git diff` to see the changes
4. Run the tests yourself to verify they pass (see Test/Build Command Discovery)
5. Run the build yourself to verify it succeeds (see Test/Build Command Discovery)
6. Write your review to {state-dir}/task/run/current/reviews/reviewer-{i}.md
7. Write your verdict to {state-dir}/task/run/current/verdicts/reviewer-{i}.json:
   ```json
   {
     "verdict": "approved" or "rejected",
     "reasoning": "Your detailed reasoning here"
   }
   ```
````

## Review Criteria - BE STRICT

You must verify ALL of the following. Reject if ANY criterion fails:

### 1. Specification Compliance

- Does the implementation address EVERY requirement in the spec?
- Are there any spec requirements that were missed or partially implemented?
- Does the behavior match what was specified exactly?

### 2. Code Quality

- Is the code clean, readable, and maintainable?
- Are there any obvious bugs or logic errors?
- Is error handling appropriate?
- Are edge cases handled?

### 3. Testing

- Do ALL tests pass? (Run them yourself, don't trust evidence alone)
- Is test coverage adequate for the changes?
- Are there missing test cases for important scenarios?

### 4. Build & Integration

- Does the build succeed without warnings? (Run it yourself)
- Are there any type errors or linting issues?
- Does the change integrate properly with existing code?

### 5. Security

- Are there any security vulnerabilities introduced?
- Is user input properly validated?
- Are there any injection risks (SQL, XSS, command injection)?

### 6. Evidence Verification

- Did the implementer provide complete evidence?
- Do the evidence files match what you observe when running commands yourself?
- Are there any discrepancies between claimed and actual results?

## Verdict Guidelines

**APPROVE only if:**

- ALL specification requirements are fully implemented
- ALL tests pass when you run them
- Build succeeds when you run it
- Code quality is acceptable
- No security issues identified
- Evidence is accurate and complete

**REJECT if:**

- ANY specification requirement is missing or incomplete
- ANY test fails
- Build fails or has errors
- Significant code quality issues
- Security vulnerabilities present
- Evidence is missing, incomplete, or inaccurate
- You have ANY doubt about the implementation correctness

When in doubt, REJECT. It is better to have another iteration than to approve incomplete work.

## Git Safety - CRITICAL

- NEVER use `git push --force` or `git push -f`
- NEVER push to any branch other than the current task branch
- NEVER push to main, master, or any protected branch
- NEVER delete branches
- NEVER rebase pushed commits
- Reject if you see any evidence of force pushing or unsafe git operations

```

---

## Error Handling

### Git Pull/Merge Failure
- Mark current loop as `failed`
- Stop execution immediately
- Display error: "Merge conflict or pull failure. Please resolve manually."
- Wait for user to resolve and restart
- **Never** attempt to force push or auto-resolve

### Git Push Failure
- Mark current loop as `failed`
- Stop execution immediately
- Display error with details
- Wait for user intervention
- **Never** retry with force push

### Run Failure (task mode)
- Do not commit or push
- Stop execution and prompt user to continue or stop

### Agent Timeout
- Mark agent status as `timeout`
- Verdict defaults to `rejected`
- Continue to next agent/phase

### Agent Error (non-zero exit)
- Mark agent status as `error`
- Verdict defaults to `rejected`
- Log error details

### Missing Evidence
- Implementer completion without evidence files
- Warning logged, continue to reviewers
- Reviewers may reject due to missing evidence

### Missing Verdict
- Reviewer completion without verdict file
- Attempt to parse from review file
- Default to `rejected` if unparseable

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KAGENT_STATE_DIR` | State directory | `.kagent` |
| `KAGENT_IMPLEMENTERS` | Default implementers (`binary:weight,...`) | `claude:100` |
| `KAGENT_REVIEWERS` | Default reviewer binaries (comma-sep) | `claude` |
| `KAGENT_MAX_ITERATIONS` | Default max loops per run | `10` |
| `KAGENT_MAX_RUNS` | Default max runs per task | `20` |
| `KAGENT_IMPLEMENTER_TIMEOUT` | Default implementer timeout (mins) | `30` |
| `KAGENT_REVIEWER_TIMEOUT` | Default reviewer timeout (mins) | `15` |
| `KAGENT_POLL_INTERVAL` | CI/review poll interval (seconds) | `60` |
| `GITHUB_TOKEN` | GitHub API token (for gh CLI) | from gh auth |
| `JIRA_TOKEN` | Jira API token (if using Jira) | - |

---

## Tmux Session Naming

Format: `kagent-{runOrdinal}-{loop}-{role}[-{index}]`

Examples:
- `kagent-5-2-impl` - Implementer, run 5, loop 2
- `kagent-5-2-rev-0` - Reviewer 0, run 5, loop 2
- `kagent-5-2-rev-1` - Reviewer 1, run 5, loop 2

---

## Summary

This design separates concerns into three levels:

| Level | Scope | Artifact | Completion |
|-------|-------|----------|------------|
| **Task** | Ticket → ready-to-merge PR | Ready to merge | CI + required approvals |
| **Run** | Spec → Commit | Git commit | AI reviewer consensus |
| **Loop** | Iteration | Evidence + verdicts | Implementer + reviewers done |

### Key Features

- **Pointer-Based Architecture** = No file movement, just update `.current-*` files
- **Ordinals** = Simple numbering (1, 2, 3) instead of random IDs
- **Runs are First-Class** = Can operate standalone without tasks
- **Specs at Run Level** = Each run has its own spec.md
- **TICKETS.md** = Repository-level ticket configuration
  - Ticket source and access method (CLI, browser, MCP)
  - Branch pattern for ticket ID extraction
  - Ticket status transitions (In Progress → In Review → Done)
  - Commit and PR templates
- **Git Safety** = Strict rules preventing force push and branch mistakes
  - Pull/merge failure → stop and wait for user
  - Never force push, never push to wrong branch
- **Ticket ID from Branch** = Auto-extract ticket ID using pattern from TICKETS.md
- **Pre-existing Branch** = User creates/checks out branch, kagent only pushes to it
- **PR on First Push** = Create PR immediately after first successful push
- **Weighted Implementers** = Array of implementers with weights for random selection
- **AI-Assisted Spec Updates** (Task mode) = Automatically incorporate CI/review feedback into new run specs
- **Interactive CLI** = Browse and select without memorizing IDs
- **Pretty-Printed Logs** = Human-readable formatter (not raw JSON)
- **Historical Data** = Complete history by listing directories
- **Learnings are Loop-Scoped** = Each loop has its own learnings, not accumulated
- **Configurable State Dir** = `--state-dir` or `KAGENT_STATE_DIR`
- **Crash Recovery** = Detect state from pointers, kill orphaned agents

### Command Hierarchy

```

# Task mode (with ticket/PR integration)

kagent task [--ticket ID] # Start task (auto-detects ticket from branch)
kagent task --resume # Resume existing task
kagent task status # Show task + PR + CI status
kagent task check # Poll CI/reviews
kagent task abandon # Abandon task

# Standalone mode (no ticket/PR)

kagent init # Initialize config + create run with spec
kagent run # Start run (uses .current-run or prompts)
kagent run --ordinal <N> # Run specific run

# Both modes

kagent status # Show run status
kagent attach # Attach to agent tmux
kagent cancel # Cancel current run

kagent logs view # View agent logs
kagent history list # List all runs/tasks
kagent history show <N> # Show specific run/task details

kagent format # Standalone formatter

```

```
