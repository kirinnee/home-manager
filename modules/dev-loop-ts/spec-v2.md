# Dev-Loop v2 Specification

## Overview

Dev-loop is a CLI tool that orchestrates AI agents (implementers and reviewers) in iterative development cycles. The system operates at two hierarchical levels: **Runs** and **Loops**.

## Core Concepts

### Hierarchy

```
Project
└── .claude/dev-loop/
    ├── config.json          # Current configuration
    ├── spec.md              # Current specification
    ├── current/             # Active run state
    │   ├── run.json         # Run metadata
    │   ├── current/         # Active loop (always "current")
    │   └── loop-{n}/        # Archived loops within this run
    └── archive/             # Historical data
        └── run-{id}/        # Archived runs
            └── loop-{n}/    # All loops from that run
```

### Run

A **Run** is a complete execution cycle for a specific spec+config combination. When `dev-loop run` is invoked:

- If a previous run exists with history, archive it first
- Create a new run with fresh state
- Execute loops until completion or cancellation

### Loop

A **Loop** is a single iteration within a run:

1. Implementer phase - AI implements/fixes based on spec + learnings
2. Reviewer phase - Multiple AI reviewers evaluate the implementation
3. Decision - Continue to next loop or complete

When a loop ends, its data is archived within the current run before the next loop begins.

---

## Configuration

### config.json

```json
{
  "implementer": "claude",
  "reviewers": ["claude-reviewer-1", "claude-reviewer-2"],
  "maxIterations": 10,
  "implementerTimeout": 30,
  "reviewerTimeout": 15
}
```

| Field                | Type     | Default      | Description                       |
| -------------------- | -------- | ------------ | --------------------------------- |
| `implementer`        | string   | `claude`     | Binary name for implementer agent |
| `reviewers`          | string[] | `["claude"]` | Binary names for reviewer agents  |
| `maxIterations`      | number   | 10           | Maximum loops per run             |
| `implementerTimeout` | number   | 30           | Implementer timeout in minutes    |
| `reviewerTimeout`    | number   | 15           | Reviewer timeout in minutes       |

### spec.md

Markdown file describing the implementation task. Created/edited during `dev-loop init`.

---

## Directory Structure

### Active State: `.claude/dev-loop/current/`

```
current/
├── run.json                     # Run metadata and state
├── current/                     # Active loop (always named "current")
│   ├── agents/                  # Agent state files
│   │   ├── implementer.json     # Implementer agent state
│   │   └── reviewer-{i}.json    # Reviewer agent states
│   ├── evidence/                # Implementer outputs
│   │   ├── build-output.log
│   │   ├── test-output.log
│   │   └── evidence.md
│   ├── learnings/               # Knowledge for next loop
│   │   └── learnings.md
│   ├── reviews/                 # Reviewer outputs
│   │   └── reviewer-{i}.md
│   ├── verdicts/                # Reviewer decisions
│   │   └── reviewer-{i}.json
│   └── logs/                    # Raw agent logs
│       ├── implementer.jsonl
│       └── reviewer-{i}.jsonl
└── loop-{n}/                    # Archived loops within this run
    └── ...                      # Same structure as current/current/
```

### Archive: `.claude/dev-loop/archive/`

```
archive/
└── run-{id}/                    # Archived run
    ├── run.json                 # Final run metadata
    ├── config.json              # Config snapshot
    ├── spec.md                  # Spec snapshot
    └── loop-{n}/                # All loops from this run (1-indexed)
        └── ...                  # Same structure as current/current/
```

**Note:** The active loop is always at `current/current/`. When archived, it becomes `current/loop-{n}/` or `archive/run-{id}/loop-{n}/`.

---

## Data Schemas

### run.json

```json
{
  "id": "abc12345",
  "status": "running",
  "currentLoop": 2,
  "startedAt": "2025-01-27T10:00:00Z",
  "completedAt": null,
  "result": null
}
```

| Field         | Type         | Description                                                             |
| ------------- | ------------ | ----------------------------------------------------------------------- |
| `id`          | string       | Unique run identifier (8 chars)                                         |
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
  "tmuxSession": "devloop-abc12345-2-impl",
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
│    │ logs/{agent}.jsonl │       │ dev-loop format │              │
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
2. **Log viewing** - When running `dev-loop logs view`

This is achieved by making `dev-loop format` a standalone streaming subcommand:

- Reads JSON lines from stdin
- Pretty prints to stdout
- Can be piped from any source (live agent, stored log file)

### Execution Command Template

```bash
cat "{promptFile}" | {binary} --dangerously-skip-permissions \
  --verbose --print --output-format stream-json 2>&1 | \
  tee "{logsDir}/{agent}.jsonl" | \
  dev-loop format
```

### Log Storage Format

Logs are stored as JSON Lines (`.jsonl`):

- One JSON event per line
- Preserves complete Claude output
- Can be replayed through formatter later

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
$ dev-loop logs view
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
$ dev-loop logs view --run abc12345 --loop 2 implementer
```

---

### `dev-loop init`

Initialize project configuration and specification.

```bash
dev-loop init [options]

Options:
  --implementer <binary>        Implementer binary (default: claude)
  --reviewers <binaries>        Comma-separated reviewer binaries
  --max-iterations <n>          Max loops per run (default: 10)
  --implementer-timeout <mins>  Implementer timeout (default: 30)
  --reviewer-timeout <mins>     Reviewer timeout (default: 15)
```

**Behavior:**

1. Creates `.claude/dev-loop/` directory structure
2. Creates or updates `config.json`
3. Opens `spec.md` in editor (or creates template)

### `dev-loop run`

Start or resume a development loop run.

```bash
dev-loop run [options]

Options:
  --continue    Continue from last loop (don't archive)
```

**Behavior:**

1. Validate config and spec exist
2. If previous run exists with completed loops:
   - Archive entire run to `archive/run-{id}/`
3. Create new run in `current/`
4. Execute loops until:
   - All reviewers approve (completed)
   - Max iterations reached (failed)
   - User cancellation (cancelled)

### `dev-loop status`

Show current run and agent status.

```bash
dev-loop status [run-id] [options]

Arguments:
  run-id    Run to show status for (interactive if omitted)

Options:
  --json    Output as JSON
  --loop    Show specific loop details (interactive selector)
```

**Interactive mode:** If no run-id provided and no current run, shows selector for archived runs.

**Output:**

```
Run: abc12345 (running)
Loop: 2 of 10

Agents:
  ● implementer     running   claude       devloop-abc12345-2-impl
  ● reviewer-0      pending   claude-r1    -
  ● reviewer-1      pending   claude-r2    -

Evidence: ✓ build-output.log, ✓ test-output.log
Learnings: 3 entries from previous loops
```

### `dev-loop attach`

Attach to a running agent's tmux session.

```bash
dev-loop attach [agent]

Arguments:
  agent    Agent to attach to (implementer, reviewer-0, etc.)
```

**Interactive mode (default):** When called without arguments, shows selector of currently running agents with their status and duration:

```
? Select agent to attach: (Use arrow keys)
❯ implementer  - running 5m 23s  - claude
  reviewer-0   - running 2m 10s  - claude-r1
  reviewer-1   - pending         - claude-r2
```

### `dev-loop cancel`

Cancel the current run.

```bash
dev-loop cancel [options]

Options:
  --force    Skip confirmation
```

**Behavior:**

1. Kill all running tmux sessions
2. Mark run as cancelled
3. Archive run to history

### `dev-loop logs`

View and manage agent logs.

```bash
dev-loop logs list [run-id]
dev-loop logs view [agent] [options]
dev-loop logs tail [agent] [options]
dev-loop logs clear [run-id]

Options:
  --loop <n>     Loop number (interactive if omitted)
  --run <id>     Run ID (interactive if omitted)
  --raw          Output raw JSON instead of formatted
  --follow, -f   Follow log output (for tail)
```

**Interactive mode:** When `view` or `tail` is called without arguments:

1. Select run (current or from archive)
2. Select loop (current or archived within run)
3. Select agent (implementer or reviewer-{i})

**View Command:**
The `view` command pipes the log file through the same formatter:

```bash
# Internal implementation:
cat ".claude/dev-loop/current/current/logs/{agent}.jsonl" | dev-loop format
```

### `dev-loop history`

Manage run history.

```bash
dev-loop history list [options]
dev-loop history show [run-id] [options]
dev-loop history clear [run-id]

Options:
  --loops        Show loop details
  --verdicts     Show verdict summaries
  --loop <n>     Show specific loop (interactive if omitted with show)
```

**Interactive mode:** When `show` is called without run-id:

1. Select run from archived runs list
2. Optionally select specific loop to drill down

**Output for `history show`:**

```
Run: abc12345
Status: completed
Started: Jan 27, 2025 10:00 AM
Completed: Jan 27, 2025 10:25 AM
Duration: 25m 12s

Loops: 3 total
  Loop 1: rejected (2 of 2 reviewers)
  Loop 2: rejected (1 of 2 reviewers)
  Loop 3: approved (2 of 2 reviewers)

? View loop details? (Use arrow keys)
❯ Loop 3 - approved
  Loop 2 - rejected
  Loop 1 - rejected
  Exit
```

### `dev-loop format`

Format Claude stream-json output (used internally and for log viewing).

```bash
dev-loop format [options]

Options:
  --color     Force color output
  --no-color  Disable color output
```

**Usage:**

```bash
# Live formatting in tmux
cat prompt | claude --output-format stream-json | dev-loop format

# View stored log
cat .claude/dev-loop/current/loop-1/logs/implementer.jsonl | dev-loop format
```

---

## Loop Lifecycle

### Phase 1: Implementer

```
1. Create current/current/ directory structure (if first loop) or clear it
2. Initialize current/current/agents/implementer.json (status: pending)
3. Build implementer prompt:
   - Include spec
   - Include learnings from all previous loops (current/loop-*/learnings/)
   - Include review feedback from last loop if rejected
   - Instructions to write evidence and learnings
4. Update agent state (status: running, phase: starting)
5. Execute in tmux:
   - Prompt piped to binary
   - Output tee'd to logs and formatter
6. On completion:
   - Update agent state (status: completed, exitCode)
   - Verify evidence files created
   - Read learnings.md if exists
```

### Phase 2: Reviewers (Parallel)

```
For each reviewer (parallel):
1. Initialize current/current/agents/reviewer-{i}.json (status: pending)
2. Build reviewer prompt:
   - Include spec
   - Reference evidence files in current/current/evidence/
   - Strict review criteria
   - Instructions to write review and verdict
3. Update agent state (status: running)
4. Execute in tmux
5. On completion:
   - Parse verdict from current/current/verdicts/reviewer-{i}.json
   - Update agent state (verdict: approved/rejected)
```

### Phase 3: Decision

```
1. Collect all verdicts from current/current/verdicts/
2. Check consensus:
   - All approved → Run complete
   - Any rejected → Continue to next loop
   - Max iterations → Run failed
3. Archive current loop: move current/current/ to current/loop-{n}/
4. Proceed to Phase 1 of next loop (or end run)
```

### Loop Archival (Before Next Loop)

```
1. Move current/current/ contents to current/loop-{n}/
2. Create fresh current/current/ structure
3. Learnings from all current/loop-*/learnings/ are available to next implementer
4. Review feedback from current/loop-{n}/reviews/ is passed to next implementer
```

---

## Run Archival (Before New Run)

When `dev-loop run` is executed with existing run data:

```
1. Create archive/run-{id}/ directory
2. Move to archive:
   - run.json (final state)
   - config.json (snapshot)
   - spec.md (snapshot)
   - current/current/ → archive/run-{id}/loop-{final}/ (if incomplete loop)
   - current/loop-*/ → archive/run-{id}/loop-*/ (all archived loops)
3. Clear current/ directory
4. Create fresh run state with new run.json
```

This preserves complete history of all runs and their loops.

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
4. Run ALL tests and verify they pass
5. Run the build and verify it succeeds
6. Write evidence to .claude/dev-loop/current/current/evidence/:
   - build-output.log: Complete build command output
   - test-output.log: Complete test command output
   - evidence.md: Summary of what you verified and how
7. Write learnings to .claude/dev-loop/current/current/learnings/learnings.md:
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
```

### Reviewer Prompt Template

````markdown
# Code Review Task

## Specification

{contents of spec.md}

## Your Task

1. Review the current implementation against the specification
2. Check the evidence in .claude/dev-loop/current/current/evidence/
3. Run `git diff` to see the changes
4. Run the tests yourself to verify they pass
5. Run the build yourself to verify it succeeds
6. Write your review to .claude/dev-loop/current/current/reviews/reviewer-{i}.md
7. Write your verdict to .claude/dev-loop/current/current/verdicts/reviewer-{i}.json:
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

```

---

## Error Handling

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
| `DEV_LOOP_IMPLEMENTER` | Default implementer binary | `claude` |
| `DEV_LOOP_REVIEWERS` | Default reviewer binaries (comma-sep) | `claude` |
| `DEV_LOOP_MAX_ITERATIONS` | Default max iterations | `10` |
| `DEV_LOOP_IMPLEMENTER_TIMEOUT` | Default implementer timeout (mins) | `30` |
| `DEV_LOOP_REVIEWER_TIMEOUT` | Default reviewer timeout (mins) | `15` |
| `DEV_LOOP_DIR` | State directory | `.claude/dev-loop` |

---

## Tmux Session Naming

Format: `devloop-{runId}-{loop}-{role}[-{index}]`

Examples:
- `devloop-abc12345-2-impl` - Implementer, run abc12345, loop 2
- `devloop-abc12345-2-rev-0` - Reviewer 0, run abc12345, loop 2
- `devloop-abc12345-2-rev-1` - Reviewer 1, run abc12345, loop 2

---

## Summary

This redesign separates concerns clearly:
- **Runs** = complete execution cycles, archived when new run starts
- **Loops** = iterations within a run, archived when next loop starts
- **Agents** = individual state tracking per implementer/reviewer
- **Formatter** = unified streaming formatter for live and log viewing
- **Storage** = hierarchical archive preserving complete history
```
