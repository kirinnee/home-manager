# Kagent v3 Specification & Definition of Complete

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

---

## Part 1: Architecture Requirements

### 1.1 Stateless OOP with Dependency Injection

- [ ] All service classes are stateless (no mutable instance state)
- [ ] Dependencies passed via constructors only
- [ ] Pure data structures in `src/lib/structures.ts` (no methods)
- [ ] Service objects in `src/lib/services.ts` (methods, DI, structures as params)
- [ ] Interfaces for impure operations in `src/lib/interfaces.ts`

### 1.2 Project Structure

Code is organized by **domain/feature**, not by type. Each domain folder contains its own structures, interfaces, and services.

```
src/
├── cli.ts                    # CLI entry point (Commander.js)
├── lib/                      # Pure code organized by domain
│   ├── config/               # Configuration domain
│   │   ├── structures.ts     # Config, ImplementerConfig
│   │   ├── interfaces.ts     # IConfigLoader
│   │   └── service.ts        # ConfigService
│   ├── run/                  # Run lifecycle domain
│   │   ├── structures.ts     # Run, RunStatus, RunResult
│   │   ├── interfaces.ts     # IRunRepository
│   │   └── service.ts        # RunService
│   ├── loop/                 # Loop lifecycle domain
│   │   ├── structures.ts     # Loop state types
│   │   └── service.ts        # LoopService
│   ├── task/                 # Task lifecycle domain
│   │   ├── structures.ts     # Task, TaskStatus, PR
│   │   ├── interfaces.ts     # ITaskRepository
│   │   └── service.ts        # TaskService
│   ├── agent/                # Agent execution domain
│   │   ├── structures.ts     # AgentState, AgentRole, AgentStatus
│   │   ├── interfaces.ts     # IAgentRunner
│   │   └── service.ts        # ImplementerSelectionService
│   ├── logging/              # Log formatting domain
│   │   ├── structures.ts     # LogEntry, ContentBlock, Message
│   │   └── service.ts        # LogFormatterService
│   ├── pointer/              # Pointer resolution domain
│   │   └── service.ts        # PointerService
│   ├── prompt/               # Prompt building domain
│   │   └── service.ts        # PromptService
│   ├── verdict/              # Verdict parsing domain
│   │   ├── structures.ts     # Verdict, VerdictResult
│   │   └── service.ts        # VerdictService
│   ├── ticket/               # Ticket integration domain
│   │   ├── structures.ts     # Ticket, TicketSource, TicketsConfig
│   │   └── service.ts        # TicketsConfigService
│   ├── spec/                 # Spec management domain
│   │   └── service.ts        # SpecService
│   ├── shared/               # Shared types used across domains
│   │   └── types.ts          # Common enums, utility types
│   └── index.ts              # Library exports (re-exports from domains)
└── adapters/                 # Impure/stateful operations
    ├── console.adapter.ts
    ├── filesystem.adapter.ts
    ├── environment.adapter.ts
    ├── process.adapter.ts
    ├── tmux.adapter.ts       # Tmux session management
    ├── git.adapter.ts        # Git operations
    ├── clock.adapter.ts      # Time operations
    └── index.ts

test/
├── unit/                     # Unit tests for lib/ only (fast, pure)
│   ├── config/               # Tests mirror lib/ structure
│   ├── run/
│   ├── loop/
│   └── ...
├── int/                      # Integration tests (end-to-end)
└── fixtures/
    └── bin/                  # Fake agent binaries for testing
```

**Domain Organization Rules:**

- Each domain folder contains its own `structures.ts`, `interfaces.ts`, and `service.ts`
- A domain may omit files it doesn't need (e.g., no interfaces if no external deps)
- Cross-domain imports are allowed within `lib/` (import from sibling domains)
- `shared/types.ts` contains types used by multiple domains (e.g., ISO datetime type)
- `index.ts` re-exports public APIs from all domains

### 1.3 Separation of Concerns

- [ ] `src/lib/` contains ONLY pure code (testable without mocks in unit tests)
- [ ] `src/lib/` organized by domain (not by type)
- [ ] Each domain has its own `structures.ts`, `interfaces.ts`, `service.ts`
- [ ] `src/lib/shared/` contains cross-domain types and utilities
- [ ] `src/lib/index.ts` re-exports public APIs from all domains
- [ ] `src/adapters/` contains ALL impure operations (filesystem, process, git, tmux)
- [ ] Adapters import interfaces from `lib/{domain}/interfaces.ts`
- [ ] CLI commands are thin wrappers that wire adapters to services

### 1.4 Required Domains and Services

| Domain     | Service                       | Responsibility                                          |
| ---------- | ----------------------------- | ------------------------------------------------------- |
| `config/`  | `ConfigService`               | Load/save config.json, merge with defaults/env vars     |
| `pointer/` | `PointerService`              | Read/write pointer files (.current-task/run/loop)       |
| `task/`    | `TaskService`                 | Task lifecycle operations (create, update, abandon)     |
| `run/`     | `RunService`                  | Run lifecycle operations (create, update, complete)     |
| `loop/`    | `LoopService`                 | Loop lifecycle (create loop-N/, get previous learnings) |
| `spec/`    | `SpecService`                 | Spec file operations (create from ticket, update)       |
| `agent/`   | `ImplementerSelectionService` | Weighted random selection of implementer                |
| `verdict/` | `VerdictService`              | Parse verdicts, determine consensus                     |
| `prompt/`  | `PromptService`               | Build implementer and reviewer prompts                  |
| `logging/` | `LogFormatterService`         | Format stream-json to pretty output                     |
| `ticket/`  | `TicketsConfigService`        | Parse TICKETS.md, extract ticket ID from branch         |

**Service Method Requirements:**

- [ ] Pure functions (given same input, same output)
- [ ] Stateless (no side effects, no mutations)
- [ ] Accept structures as parameters
- [ ] Return new structures (immutable)

### 1.5 Required Adapter Interfaces

| Interface      | Operations                                        |
| -------------- | ------------------------------------------------- |
| `IFilesystem`  | Read/write files, create directories, list dirs   |
| `IProcess`     | Spawn processes, get exit codes                   |
| `IEnvironment` | Read environment variables                        |
| `IConsole`     | Print output, read input                          |
| `ITmux`        | Create/kill sessions, attach, list sessions       |
| `IGit`         | Status, diff, add, commit, push, pull, branch ops |
| `IClock`       | Get current time (for testability)                |

**Adapter Requirements:**

- [ ] Real implementations for production use
- [ ] Memory/mock implementations for testing

---

## Part 2: Git Safety Rules

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

## Part 3: Directory Structure & Data Schemas

### 3.1 Pointer-Based Architecture

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
│   ├── .current-loop             # Pointer: "2" (active loop ordinal)
│   ├── spec.md                   # What to implement (run-level)
│   ├── loop-1/                   # First loop
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
│   └── loop-2/, loop-3/, ...     # Subsequent loops
│
├── run-2/                        # Another run
└── run-N/
```

**Pointer Resolution:**

- `.current-task` → which `task-N/` is active (or empty if no task)
- `.current-run` → which `run-N/` is active
- `task-N/.current-run` → which run is active for this task
- `run-N/.current-loop` → which `loop-N/` is active within this run

**Historical data is implicit:**

- Old runs/tasks/loops remain in their directories
- Active ones are pointed to by `.current-*` files
- Everything is discoverable by listing directories
- No file movement — just create new `loop-{N+1}/` and update pointer

### 3.2 Data Structures Checklist (by Domain)

#### `config/structures.ts`

- [ ] `Config` - Agent configuration (implementers, reviewers, timeouts)
- [ ] `ImplementerConfig` - Binary name + weight for weighted selection

#### `task/structures.ts`

- [ ] `Task` - Task metadata (ticket, branch, PR, status)
- [ ] `TaskStatus`: `running`, `waiting_ci`, `waiting_review`, `completed`, `abandoned`, `failed`
- [ ] `PR` - PR number, URL, status
- [ ] `PRStatus`: `draft`, `open`, `merged`, `closed`

#### `run/structures.ts`

- [ ] `Run` - Run metadata (id, taskId, status, currentLoop)
- [ ] `RunStatus`: `running`, `completed`, `cancelled`, `failed`
- [ ] `RunResult`: `approved`, `rejected`, `max_iterations`, `cancelled`

#### `agent/structures.ts`

- [ ] `AgentState` - Agent execution state (role, binary, status, tmux session, pid)
- [ ] `AgentRole`: `implementer`, `reviewer`
- [ ] `AgentStatus`: `pending`, `running`, `completed`, `error`, `timeout`
- [ ] `AgentPhase`: `starting`, `executing`, `finalizing`

#### `verdict/structures.ts`

- [ ] `Verdict` - Reviewer verdict (approved/rejected + reasoning)
- [ ] `VerdictResult`: `approved`, `rejected`

#### `ticket/structures.ts`

- [ ] `Ticket` - Ticket source, ID, title, body, status
- [ ] `TicketSource`: `github`, `jira`, `linear`, `clickup`
- [ ] `TicketsConfig` - Parsed TICKETS.md configuration
- [ ] `AccessMethod`: `cli`, `browser`, `mcp`

#### `logging/structures.ts`

- [ ] `LogEntry` - Parsed stream-json log entry
- [ ] `ContentBlock` - Message content block (text, tool_use, tool_result)
- [ ] `Message` - Assistant/user message structure

### 3.3 config.json Schema

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

**Implementer Selection Algorithm:**

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

### 3.4 task.json Schema

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

### 3.5 run.json Schema

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

### 3.6 Agent State Schema: `agents/{role}.json`

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

### 3.7 Verdict Schema: `verdicts/reviewer-{i}.json`

```json
{
  "verdict": "approved",
  "reasoning": "Implementation meets all spec requirements..."
}
```

---

## Part 4: Configuration

### 4.1 TICKETS.md (Repository-Level)

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

### 4.2 Environment Variables

| Variable                     | Description                              | Default      |
| ---------------------------- | ---------------------------------------- | ------------ |
| `KAGENT_STATE_DIR`           | State directory                          | `.kagent`    |
| `KAGENT_IMPLEMENTERS`        | Default implementers (`binary:weight,…`) | `claude:100` |
| `KAGENT_REVIEWERS`           | Default reviewer binaries (comma-sep)    | `claude`     |
| `KAGENT_MAX_ITERATIONS`      | Default max loops per run                | `10`         |
| `KAGENT_MAX_RUNS`            | Default max runs per task                | `20`         |
| `KAGENT_IMPLEMENTER_TIMEOUT` | Default implementer timeout (mins)       | `30`         |
| `KAGENT_REVIEWER_TIMEOUT`    | Default reviewer timeout (mins)          | `15`         |
| `KAGENT_POLL_INTERVAL`       | CI/review poll interval (seconds)        | `60`         |
| `GITHUB_TOKEN`               | GitHub API token (for gh CLI)            | from gh auth |
| `JIRA_TOKEN`                 | Jira API token (if using Jira)           | -            |

---

## Part 5: CLI Commands

### 5.1 Command Summary

```
# Task mode (with ticket/PR integration)
kagent task [--ticket ID]     # Start task (auto-detects ticket from branch)
kagent task --resume          # Resume existing task
kagent task status            # Show task + PR + CI status
kagent task check             # Poll CI/reviews
kagent task abandon           # Abandon task

# Standalone mode (no ticket/PR)
kagent init                   # Initialize config + create run with spec
kagent run                    # Start run (uses .current-run or prompts)
kagent run --ordinal <N>      # Run specific run

# Both modes
kagent status                 # Show run status
kagent attach                 # Attach to agent tmux
kagent cancel                 # Cancel current run

kagent logs view              # View agent logs
kagent history list           # List all runs/tasks
kagent history show <N>       # Show specific run/task details

kagent format                 # Standalone formatter
```

### 5.2 Interactive Mode

Most viewing commands support **interactive mode** when called without arguments. This allows users to browse and select options without knowing exact IDs or names.

Interactive mode uses arrow keys and fuzzy search to navigate:

- Run selection → shows run ID, date, status, loop count
- Loop selection → shows loop number, verdict, duration
- Agent selection → shows role, status, binary

### 5.3 Task Mode Commands

#### `kagent task`

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

#### `kagent task status`

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

#### `kagent task abandon`

Abandon current task without merging.

```bash
kagent task abandon [options]

Options:
  --force    Skip confirmation
  --keep-branch    Don't delete the branch
```

#### `kagent task check`

Manually trigger a check for CI and review status.

```bash
kagent task check [options]

Options:
  --continue    If all checks pass, continue to next action
```

### 5.4 Standalone Mode Commands

#### `kagent init`

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

**Note:** For ticket-based work, use `kagent task` instead. `kagent init` is for standalone runs without ticket/PR integration.

#### `kagent run`

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

### 5.5 Common Commands

#### `kagent status`

Show current run and agent status.

```bash
kagent status [ordinal] [options]

Arguments:
  ordinal    Run ordinal to show status for (uses .current-run if omitted)

Options:
  --json    Output as JSON
  --loop    Show specific loop details (interactive selector)
```

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

#### `kagent attach`

Attach to a running agent's tmux session.

```bash
kagent attach [agent]

Arguments:
  agent    Agent to attach to (implementer, reviewer-0, etc.)
```

**Interactive mode (default):** Shows selector of currently running agents:

```
? Select agent to attach: (Use arrow keys)
❯ implementer  - running 5m 23s  - claude     (kagent-5-2-impl)
  reviewer-0   - running 2m 10s  - claude-r1  (kagent-5-2-rev-0)
  reviewer-1   - pending         - claude-r2
```

#### `kagent cancel`

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

**Notes:**

- Cancellation is run-scoped; it must never kill tmux sessions from other runs
- The run ordinal is encoded in the tmux session name, enabling safe filtering

### 5.6 Log Commands

#### `kagent logs`

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

**View Command Implementation:**

```bash
# Internal implementation:
# Read .current-loop to get active loop ordinal, then:
cat "{state-dir}/run-{N}/loop-{L}/logs/{agent}.jsonl" | kagent format
```

### 5.7 History Commands

#### `kagent history`

Manage run and task history.

```bash
kagent history list [options]
kagent history show <ordinal> [options]

Options:
  --loops        Show loop details
  --verdicts     Show verdict summaries
  --loop <n>     Show specific loop
```

**Output for `history list`:**

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

### 5.8 Utility Commands

#### `kagent format`

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

### 5.9 CLI Command Checklist

#### Task Mode

- [ ] `kagent task [--ticket ID] [--source TYPE] [--state-dir PATH]`
- [ ] `kagent task --resume`
- [ ] `kagent task status [--json] [--watch]`
- [ ] `kagent task abandon [--force] [--keep-branch]`
- [ ] `kagent task check [--continue]`

#### Standalone Mode

- [ ] `kagent init [--implementers LIST] [--reviewers LIST] [--max-iterations N] [--state-dir PATH]`
- [ ] `kagent run [--ordinal N] [--continue]`

#### Common

- [ ] `kagent status [ordinal] [--json] [--loop]`
- [ ] `kagent attach [agent]`
- [ ] `kagent cancel [--force]`

#### Logs

- [ ] `kagent logs list [run-ordinal]`
- [ ] `kagent logs view [--loop N] [--run N] [--raw] [agent]`
- [ ] `kagent logs tail [--loop N] [--run N] [--raw] [--follow] [agent]`

#### History

- [ ] `kagent history list [--loops] [--verdicts]`
- [ ] `kagent history show <ordinal> [--loop N]`

#### Utility

- [ ] `kagent format [--color] [--no-color]`

---

## Part 6: Lifecycles & Workflows

### 6.1 Task Lifecycle

#### Phase 1: Initialization

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
   - browser: Open ticket in browser, prompt user to confirm they've read it
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

#### Phase 2: Implementation (Run Loop)

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
4. On run failure (max iterations/cancelled): do not push; stop and prompt user.
```

#### Phase 3: CI Monitoring

```
1. Poll CI status via gh CLI:
   gh pr checks {pr-number} --json name,state,conclusion
2. Display progress to user
3. On CI completion:
   - If failed → AI analyzes failure, updates spec, → Phase 2
   - If passed → Phase 4
```

#### Phase 4: Review Monitoring

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

#### Phase 5: Completion

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

### 6.2 Run Lifecycle

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

### 6.3 Loop Lifecycle

A **Loop** is a single iteration within a run:

1. Implementer phase - AI implements/fixes based on spec + learnings
2. Reviewer phase - Multiple AI reviewers evaluate the implementation
3. Decision - Continue to next loop or complete

**Learnings Scope:**

Learnings are **loop-scoped only**, not accumulated at task or run level.

- Each loop has its own `learnings/learnings.md`
- Next loop can read previous loops' learnings from `loop-{N}/learnings/`
- No automatic accumulation or aggregation

#### Phase 1: Implementer

```
1. Create run/loop-{N}/ directory structure for this loop
2. Select implementer binary using weighted random selection:
   - Load implementers array from config.json
   - Calculate total weight
   - Generate random number, select based on cumulative weights
   - Record selected binary in agent state
3. Initialize run/loop-{N}/agents/implementer.json (status: pending, binary: selected)
4. Build implementer prompt:
   - Include spec
   - Include learnings from all previous loops (run/loop-{1..N-1}/learnings/)
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

#### Phase 2: Reviewers (Parallel)

```
For each reviewer (parallel):
1. Initialize run/loop-{N}/agents/reviewer-{i}.json (status: pending)
2. Build reviewer prompt:
   - Include spec
   - Reference evidence files in run/loop-{N}/evidence/
   - Strict review criteria
   - Instructions to write review and verdict
3. Update agent state (status: running)
4. Execute in tmux
5. On completion:
   - Parse verdict from run/loop-{N}/verdicts/reviewer-{i}.json
   - Update agent state (verdict: approved/rejected)
```

#### Phase 3: Decision

```
1. Collect all verdicts from run/loop-{N}/verdicts/
2. Check consensus:
   - All approved → Run complete
   - Any rejected → Continue to next loop
   - Max iterations → Run failed
3. If continuing: update .current-loop pointer to N+1, proceed to Phase 1
4. If complete or failed: update run.json status
```

#### Loop Transition

```
1. Current loop data stays in run/loop-{N}/
2. Update .current-loop pointer to N+1
3. Create fresh run/loop-{N+1}/ structure
4. Learnings from run/loop-{N}/learnings/ are available to next implementer
5. Review feedback from run/loop-{N}/reviews/ is passed to next implementer
6. Keep working tree changes between loops (no git reset)
```

### 6.4 Spec Update (AI-Assisted, Task Mode Only)

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

### 6.5 Test/Build Command Discovery (Deterministic)

Auto-detect in order:

1. Makefile targets: `make test`, `make build`
2. Taskfile.yaml tasks: `task test`, `task build` or `pls test`, `pls build`
3. justfile recipes: `just test`, `just build`
4. package.json scripts: `npm test`, `npm run build` or `bun test`, `bun run build`
5. CI configuration commands (use the exact test/build commands from CI)

**Taskfile Detection:**

- Check for `Taskfile.yaml` or `Taskfile.yml`
- Prefer `pls` if available (atomi projects), otherwise use `task`
- `pls` is an alias for `task` commonly used in atomi projects

If none are detected, prompt the user for the commands before running tests/builds.

### 6.6 Workflow Checklist

#### Task Lifecycle

- [ ] Ticket detection from branch name
- [ ] Ticket fetching (CLI method)
- [ ] Initial spec generation from ticket
- [ ] Run execution loop
- [ ] Commit, pull, push on success
- [ ] PR creation on first push
- [ ] CI status polling
- [ ] Review status polling
- [ ] Spec update from feedback
- [ ] Ticket status transitions

#### Run Lifecycle

- [ ] Run directory creation
- [ ] Loop execution until consensus or max iterations
- [ ] Git commit on success
- [ ] Cancellation detection at phase boundaries

#### Loop Lifecycle

- [ ] Implementer phase (weighted selection, prompt building, execution)
- [ ] Reviewer phase (parallel execution)
- [ ] Verdict collection and consensus check
- [ ] Create loop-N/ for new loop
- [ ] Update .current-loop pointer

#### Git Safety

- [ ] NEVER force push
- [ ] NEVER push to main/master
- [ ] NEVER delete remote branches
- [ ] Pull before push
- [ ] Stop on merge conflict (prompt user)

---

## Part 7: Pointer Resolution Algorithms

### 7.1 Finding the Active Run

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

### 7.2 Starting a New Run

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

### 7.3 Starting a New Loop

```typescript
function startNewLoop(runOrdinal: number): number {
  const runDir = `run-${runOrdinal}`;

  // 1. Read current loop pointer (or 0 if none)
  const currentLoop = exists(`${runDir}/.current-loop`) ? parseInt(read(`${runDir}/.current-loop`)) : 0;

  // 2. Calculate next loop ordinal
  const nextLoop = currentLoop + 1;

  // 3. Create new loop directory
  const loopDir = `${runDir}/loop-${nextLoop}`;
  createDirectory(loopDir);
  createDirectory(`${loopDir}/agents`);
  createDirectory(`${loopDir}/evidence`);
  createDirectory(`${loopDir}/learnings`);
  createDirectory(`${loopDir}/reviews`);
  createDirectory(`${loopDir}/verdicts`);
  createDirectory(`${loopDir}/logs`);

  // 4. Update loop pointer
  write(`${runDir}/.current-loop`, String(nextLoop));

  return nextLoop;
}

function getCurrentLoopDir(runOrdinal: number): string {
  const runDir = `run-${runOrdinal}`;
  const currentLoop = read(`${runDir}/.current-loop`);
  return `${runDir}/loop-${currentLoop}`;
}
```

### 7.4 Crash Recovery

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
      const loopDir = `${runDir}/loop-${state.activeLoop}`;
      state.agents = loadAgentStates(`${loopDir}/agents`);

      // 5. Kill orphaned tmux sessions (use dirHash prefix)
      const dirHash = getDirHash(process.cwd());
      killOrphanedSessions(dirHash, state.agents);
    }
  }

  return state;
}
```

---

## Part 8: Logging & Streaming

### 8.1 Architecture

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

### 8.2 Key Principle: Unified Formatter

The **same formatter** is used for:

1. **Live streaming** - Inside tmux sessions during execution
2. **Log viewing** - When running `kagent logs view`

This is achieved by making `kagent format` a standalone streaming subcommand:

- Reads JSON lines from stdin
- Pretty prints to stdout
- Can be piped from any source (live agent, stored log file)

### 8.3 Execution Command Template

```bash
cat "{promptFile}" | {binary} --dangerously-skip-permissions \
  --verbose --print --output-format stream-json 2>&1 | \
  tee "{logsDir}/{agent}.jsonl" | \
  kagent format
```

### 8.4 Log Storage Format

Logs are stored as JSON Lines (`.jsonl`):

- One JSON event per line
- Preserves complete Claude output
- Can be replayed through formatter later

### 8.5 Log Formatter Output

The formatter produces **pretty-printed, human-readable output** (not raw JSON).

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

### 8.6 Formatting Rules

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

### 8.7 Formatter Reference Implementation

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

## Part 9: Agent Prompts

### 9.1 Implementer Prompt Template

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
6. Write evidence to {state-dir}/run-{N}/loop-{L}/evidence/:
   - build-output.log: Complete build command output
   - test-output.log: Complete test command output
   - evidence.md: Summary of what you verified and how
7. Write learnings to {state-dir}/run-{N}/loop-{L}/learnings/learnings.md:
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

### 9.2 Reviewer Prompt Template

````markdown
# Code Review Task

## Specification

{contents of spec.md}

## Your Task

1. Review the current implementation against the specification
2. Check the evidence in {state-dir}/run-{N}/loop-{L}/evidence/
3. Run `git diff` to see the changes
4. Run the tests yourself to verify they pass (see Test/Build Command Discovery)
5. Run the build yourself to verify it succeeds (see Test/Build Command Discovery)
6. Write your review to {state-dir}/run-{N}/loop-{L}/reviews/reviewer-{i}.md
7. Write your verdict to {state-dir}/run-{N}/loop-{L}/verdicts/reviewer-{i}.json:
   ```json
   {
     "verdict": "approved" or "rejected",
     "reasoning": "Your detailed reasoning here"
   }
   ```

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
````

---

## Part 10: Error Handling

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

## Part 11: Tmux Session Naming

Format: `kagent-{dirHash}-{runOrdinal}-{loop}-{role}[-{index}]`

The `dirHash` is a short hash (first 6 chars of SHA256) of the project directory path. This prevents collisions when running kagent in multiple projects simultaneously.

Examples (assuming project at `/home/user/myproject` with hash `a1b2c3`):

- `kagent-a1b2c3-5-2-impl` - Implementer, run 5, loop 2
- `kagent-a1b2c3-5-2-rev-0` - Reviewer 0, run 5, loop 2
- `kagent-a1b2c3-5-2-rev-1` - Reviewer 1, run 5, loop 2

**Hash Generation:**

```typescript
function getDirHash(dir: string): string {
  const hash = crypto.createHash('sha256').update(dir).digest('hex');
  return hash.slice(0, 6);
}
```

---

## Part 12: Fake Agent Binaries (Testing)

For integration tests, fake agent binaries simulate Claude CLI behavior.

### 12.1 Fake Implementer (`test/fixtures/bin/fake-impl`)

**Environment Variables:**

| Variable               | Default   | Description                             |
| ---------------------- | --------- | --------------------------------------- |
| `FAKE_IMPL_EXIT_CODE`  | `0`       | Exit code                               |
| `FAKE_IMPL_DELAY_MS`   | `0`       | Delay in milliseconds before completing |
| `FAKE_IMPL_FAIL_BUILD` | `false`   | If "true", simulate build failure       |
| `FAKE_IMPL_FAIL_TESTS` | `false`   | If "true", simulate test failure        |
| `FAKE_STATE_DIR`       | `.kagent` | State directory to write evidence to    |
| `FAKE_RUN_ORDINAL`     | `1`       | Current run ordinal                     |

**Features:**

- [ ] Accepts `--dangerously-skip-permissions` flag
- [ ] Accepts `--verbose` flag
- [ ] Accepts `--print` flag
- [ ] Accepts `--output-format stream-json` flag
- [ ] Reads prompt from stdin
- [ ] Outputs valid stream-json events to stdout
- [ ] Creates `evidence/build-output.log`
- [ ] Creates `evidence/test-output.log`
- [ ] Creates `evidence/evidence.md`
- [ ] Creates `learnings/learnings.md`

### 12.2 Fake Reviewer (`test/fixtures/bin/fake-reviewer`)

**Environment Variables:**

| Variable                  | Default    | Description                             |
| ------------------------- | ---------- | --------------------------------------- |
| `FAKE_REVIEWER_EXIT_CODE` | `0`        | Exit code                               |
| `FAKE_REVIEWER_DELAY_MS`  | `0`        | Delay in milliseconds before completing |
| `FAKE_REVIEWER_VERDICT`   | `approved` | `approved` or `rejected`                |
| `FAKE_REVIEWER_INDEX`     | `0`        | Reviewer index (for file naming)        |
| `FAKE_STATE_DIR`          | `.kagent`  | State directory to write verdict to     |
| `FAKE_RUN_ORDINAL`        | `1`        | Current run ordinal                     |

**Features:**

- [ ] Same flags as fake-impl
- [ ] Creates `reviews/reviewer-{i}.md`
- [ ] Creates `verdicts/reviewer-{i}.json`

### 12.3 Additional Fake Agents

- [ ] `fake-impl-timeout` - Sleeps forever (for timeout tests)
- [ ] `fake-reviewer-timeout` - Sleeps forever (for timeout tests)

### 12.4 Usage Example

```bash
# Run fake implementer
env FAKE_STATE_DIR=.kagent FAKE_RUN_ORDINAL=1 \
  ./test/fixtures/bin/fake-impl --output-format stream-json < prompt.txt

# Run fake reviewer with rejection
env FAKE_STATE_DIR=.kagent FAKE_RUN_ORDINAL=1 \
    FAKE_REVIEWER_VERDICT=rejected FAKE_REVIEWER_INDEX=0 \
  ./test/fixtures/bin/fake-reviewer --output-format stream-json < prompt.txt
```

---

## Part 13: Testing Requirements

### 13.1 Unit Tests (`test/unit/`)

**Target: 100% coverage of `src/lib/`**

Tests mirror the domain structure:

```
test/unit/
├── config/service.test.ts
├── run/service.test.ts
├── loop/service.test.ts
├── task/service.test.ts
├── agent/service.test.ts
├── logging/service.test.ts
├── pointer/service.test.ts
├── prompt/service.test.ts
├── verdict/service.test.ts
├── ticket/service.test.ts
├── spec/service.test.ts
└── shared/utils.test.ts
```

- [ ] `config/` - ConfigService: load, save, merge defaults
- [ ] `pointer/` - PointerService: read, write, resolve active run/task/loop
- [ ] `task/` - TaskService: create, update status, validate transitions
- [ ] `run/` - RunService: create, update, complete, cancel
- [ ] `loop/` - LoopService: create loop-N/, get previous learnings
- [ ] `spec/` - SpecService: create from ticket, update from feedback
- [ ] `agent/` - ImplementerSelectionService: weighted random selection (seeded)
- [ ] `verdict/` - VerdictService: parse verdicts, check consensus
- [ ] `prompt/` - PromptService: build implementer/reviewer prompts
- [ ] `logging/` - LogFormatterService: format all event types
- [ ] `ticket/` - TicketsConfigService: parse TICKETS.md, extract ticket ID
- [ ] `shared/` - Utility functions and shared types

### 13.2 Integration Tests (`test/int/`)

**Target: 80%+ overall coverage**

Using fake agent binaries:

- [ ] `kagent init` creates correct directory structure
- [ ] `kagent run` executes loop lifecycle with fake agents
- [ ] `kagent run` handles implementer failure
- [ ] `kagent run` handles reviewer rejection (loops again)
- [ ] `kagent run` handles all reviewers approve (completes)
- [ ] `kagent run` handles max iterations
- [ ] `kagent cancel` marks run cancelled and kills tmux
- [ ] `kagent status` shows correct state
- [ ] `kagent attach` attaches to tmux session
- [ ] `kagent logs view` shows formatted output
- [ ] `kagent logs tail --follow` streams output
- [ ] `kagent format` formats stdin to stdout
- [ ] `kagent history list` shows all runs
- [ ] Pointer resolution works correctly
- [ ] Crash recovery detects orphaned state

### 13.3 Test Fixtures

- [ ] Memory filesystem adapter
- [ ] Memory environment adapter
- [ ] Mock process adapter
- [ ] Mock tmux adapter
- [ ] Mock git adapter
- [ ] Mock clock adapter
- [ ] Fake agent binaries (shell scripts)

---

## Part 14: Quality Gates

### 14.1 Code Quality

- [ ] `pls lint` passes (pre-commit hooks)
- [ ] TypeScript strict mode enabled
- [ ] No `any` types (except in adapter boundaries)
- [ ] All public APIs documented with JSDoc

### 14.2 Test Coverage

- [ ] Unit tests: 100% coverage of `src/lib/`
- [ ] Integration tests: 80%+ overall coverage
- [ ] All tests pass: `pls test`

### 14.3 Build

- [ ] `pls build` produces working binary
- [ ] Binary runs without errors: `./dist/kagent --help`

### 14.4 Documentation

- [ ] All CLI commands documented in --help
- [ ] Error messages are clear and actionable
- [ ] CLAUDE.md updated if architecture changes

---

## Part 15: Acceptance Criteria Summary

The implementation is complete when:

1. **Architecture**: All code follows stateless OOP with DI pattern
2. **Structures**: All data structures from spec implemented
3. **Services**: All services implemented with pure methods
4. **Adapters**: All adapters implemented with interfaces
5. **CLI**: All commands from spec implemented and working
6. **Workflows**: Task, Run, Loop lifecycles working correctly
7. **Git Safety**: All safety rules enforced
8. **Fake Agents**: Shell script fake agents for testing
9. **Unit Tests**: 100% coverage of `src/lib/`
10. **Int Tests**: 80%+ overall coverage
11. **Quality**: `pls lint` passes
12. **Build**: Binary builds and runs

---

## Part 16: Phased Implementation Order

### Phase 1: Foundation

1. Shared types (`src/lib/shared/types.ts`)
2. Adapter interfaces and implementations (`src/adapters/`)
3. `config/` domain - structures, interfaces, service
4. Unit tests for config domain

### Phase 2: Core Domains

1. `pointer/` domain - service
2. `run/` domain - structures, interfaces, service
3. `loop/` domain - structures, service
4. Unit tests for each domain

### Phase 3: Agent Execution

1. Fake agent binaries (`test/fixtures/bin/`)
2. `agent/` domain - structures, interfaces, service (ImplementerSelectionService)
3. `prompt/` domain - service
4. Tmux adapter
5. Integration tests for agent execution

### Phase 4: CLI Commands

1. `kagent init`, `kagent run`
2. `kagent status`, `kagent cancel`
3. `kagent attach`
4. Integration tests for CLI

### Phase 5: Logging

1. `logging/` domain - structures, service (LogFormatterService)
2. `kagent format`
3. `kagent logs view/tail`

### Phase 6: Task Mode

1. `ticket/` domain - structures, service (TicketsConfigService)
2. `task/` domain - structures, interfaces, service
3. `spec/` domain - service
4. `verdict/` domain - structures, service
5. Git adapter
6. `kagent task` commands

### Phase 7: Polish

1. History commands
2. Interactive selectors
3. Error handling refinement
4. Documentation
5. Coverage gaps
