# Dev-Loop TypeScript Rewrite

Rewrite the dev-loop-ts module with clean architecture.

## Commands

CLI commands (each in `src/cli/{name}.ts`):

1. **init** - Create `.claude/dev-loop/` directory, generate spec template
2. **run** - Start the dev loop
3. **status** - Show current run state (phase, iteration, reviewers)
4. **attach** - Attach to a running tmux session
5. **cancel** - Stop current run, kill tmux sessions
6. **history** - Browse past runs
7. **logs** - View claude JSONL session logs
8. **remove** - Remove all dev-loop state from project

## Core Features

### Spec

- Markdown file (`spec.md`) defining what to implement
- Drives the entire loop

### Loop

- 1 implementer + N concurrent reviewers per iteration
- Repeat until consensus or max iterations

### Consensus

- All reviewers must approve to pass
- Any rejection triggers next iteration

### Learnings

- Short notes persisted across iterations
- Helps implementer avoid repeating mistakes
- Stored in state, passed to next implementer

### Reviews

- Reviewer feedback (approve/reject + reasoning)
- Shown to next iteration's implementer

### Evidence

- Build logs, test output, coverage
- Implementer produces via designated file
- Reviewers consume to validate implementation

### Sessions

- Map our iterations/agents to claude code's JSONL session files
- Located in `~/.claude/projects/*/sessions/`

### History

- Archive completed runs with iteration summaries
- Stored in `.claude/dev-loop/history/`

## Directory Structure

```
src/
├── index.ts                 # Entry point
├── types.ts                 # Zod schemas + inferred types
├── deps.ts                  # Dependency interfaces + factory
│
├── cli/
│   ├── index.ts             # Commander setup
│   ├── init.ts
│   ├── run.ts
│   ├── status.ts
│   ├── attach.ts
│   ├── cancel.ts
│   ├── history.ts
│   ├── logs.ts
│   └── remove.ts
│
├── loop/
│   ├── runner.ts            # Orchestrates loop (IO edge)
│   ├── consensus.ts         # Pure: check reviewer agreement
│   └── iteration.ts         # Pure: build iteration data
│
├── agents/
│   ├── runner.ts            # Executes agents (IO edge)
│   ├── prompts.ts           # Pure: build prompt strings
│   └── verdicts.ts          # Pure: parse verdict from text
│
├── state/
│   ├── service.ts           # StateService class (IO edge)
│   ├── config.ts            # Pure: config schema/defaults
│   └── paths.ts             # Pure: path builders
│
├── tmux/
│   ├── service.ts           # TmuxService class (IO edge)
│   └── commands.ts          # Pure: build tmux command strings
│
├── history/
│   ├── service.ts           # HistoryService class (IO edge)
│   ├── archive.ts           # Pure: transform run → history entry
│   └── format.ts            # Pure: format for display
│
└── logs/
    ├── service.ts           # LogsService class (IO edge)
    ├── parse.ts             # Pure: parse JSONL
    └── format.ts            # Pure: format for display
```

## Code Requirements

### Architecture

- **DI via classes**: Pass dependencies as objects, not global imports
- **Stateless core**: Pure functions for business logic
- **IO at edges**: All file/process operations in service classes
- **Small files**: Split by function, one responsibility per file

### Libraries (replace custom utils)

- `zod` - Validation and type inference
- `date-fns` - Date formatting
- `picocolors` - Terminal colors
- `@clack/prompts` - Interactive prompts
- `commander` - CLI parsing

### Simplifications

- No complex file locking (1 devloop per directory assumption)
- No excessive defensive checks (trust Bun exists, files are files)
- Use unique filenames per run to avoid race conditions

## Data Structures

### Config (`.claude/dev-loop/config.json`)

```typescript
{
  reviewers: number,        // default: 2
  maxIterations: number,    // default: 10
  implementerTimeout: number, // minutes, default: 30
  reviewerTimeout: number,    // minutes, default: 15
}
```

### Run State (`.claude/dev-loop/current/run.json`)

```typescript
{
  id: string,               // unique run id
  spec: string,             // spec file path
  status: 'running' | 'completed' | 'cancelled' | 'failed',
  iteration: number,
  phase: 'implementing' | 'reviewing' | 'done',
  startedAt: string,        // ISO date
  learnings: string[],
}
```

### Session (`.claude/dev-loop/current/sessions/{id}.json`)

```typescript
{
  id: string,
  iteration: number,
  role: 'implementer' | 'reviewer',
  reviewerIndex?: number,
  tmuxSession: string,
  claudeSessionPath?: string,
  status: 'running' | 'completed' | 'error',
  verdict?: 'approved' | 'rejected',
  startedAt: string,
  completedAt?: string,
}
```

### History Entry (`.claude/dev-loop/history/{id}.json`)

```typescript
{
  id: string,
  spec: string,
  config: Config,
  status: 'completed' | 'cancelled' | 'failed',
  iterations: number,
  startedAt: string,
  completedAt: string,
  summary: {
    iteration: number,
    implementerDuration: number,
    reviewerVerdicts: Array<{ index: number, verdict: string }>,
    learnings: string[],
  }[],
}
```

## Implementation Notes

### Tmux Session Naming

Format: `devloop-{runId}-{iteration}-{role}[-{index}]`
Example: `devloop-abc123-1-implementer`, `devloop-abc123-1-reviewer-0`

### Evidence File

Path: `.claude/dev-loop/current/evidence.md`
Implementer writes build output, test results here. Reviewers read it.

### Verdict Extraction

Look for `VERDICT: APPROVED` or `VERDICT: REJECTED` in reviewer output.
Extract reasoning from surrounding text.

### Claude Session Mapping

Match by timing: our session start time ≈ claude session file mtime.
Claude sessions at: `~/.claude/projects/{hash}/sessions/*.jsonl`
