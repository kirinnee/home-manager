# dev-loop (Bun)

Spec-driven development loop with multi-reviewer consensus.

## Runtime: dynamic (`bun run` from source)

This app is **not built into Nix**. Home Manager installs only a thin wrapper
that runs `bun run …/kloop-ts/src/index.ts`, so:

- **Edits to `src/` apply immediately** — no `hms`/rebuild needed.
- There is **no `node_modules` in the repo**. Bun auto-installs dependencies into
  its global cache (`~/.bun/install/cache`) on first run.
- ⚠️ **Do not commit or leave a `node_modules/` here.** A local `node_modules`
  gets copied into the Nix store on every `hms` and makes rebuilds slow. If you
  run `bun install`, delete `node_modules` afterward — the global cache stays
  warm, so the app keeps working.

> Note: `default.nix` here is the **old** built-derivation packaging and is no
> longer used — `kloop` is now a `bun run` wrapper defined in `modules/default.nix`.

## Structure

```
src/
├── cli.ts                501 lines  # Commander.js CLI commands
├── state.ts              601 lines  # State management with file locking
├── agents.ts             442 lines  # Run agents in tmux sessions
├── types.ts              382 lines  # TypeScript types and validation
├── constants.ts          328 lines  # Configuration, paths, helpers
├── tmux.ts               319 lines  # tmux session management
├── history.ts            273 lines  # Run history archival
├── history-interactive.ts 247 lines # Interactive history browser
├── lock.ts               246 lines  # Atomic file locking
├── logs.ts               183 lines  # Session log viewing
├── logs-interactive.ts   146 lines  # Interactive log browser
└── loop.ts               140 lines  # Main iteration loop
──────────────────────────────────────
Total:                   3808 lines
```

## Usage

```bash
# Initialize
dev-loop init --claude claude-personal --reviewers "reviewer-a,reviewer-b"

# Edit spec
$EDITOR .kagent/spec.md

# Run (each agent spawns in its own tmux session)
dev-loop run

# Check progress and see active agent sessions
dev-loop status

# Inspect live agents
tmux attach -t dev-loop-impl-claude-1    # implementer
tmux attach -t dev-loop-review-reviewer-a-1  # reviewer
# Ctrl+B, D to detach

# View session logs (if available)
dev-loop logs list          # List all sessions
dev-loop logs view 1 implementer  # View specific session
dev-loop logs history       # Show history with verdicts

# Cancel all agents and remove state
dev-loop cancel
```

## Configuration

Options work as flags or env vars:

```bash
--claude      DEV_LOOP_CLAUDE        # default: claude
--reviewers   DEV_LOOP_REVIEWERS     # default: claude-reviewer-zai
--max-loops   DEV_LOOP_MAX_LOOPS     # default: 20
--timeout     DEV_LOOP_TIMEOUT_MINS  # default: 20 (per agent)
```

## Architecture

Each agent runs in its own tmux session for visibility:

- **Implementer**: `dev-loop-impl-{name}-{iteration}`
- **Reviewers**: `dev-loop-review-{name}-{iteration}`

dev-loop itself runs in the foreground. Wrap it in tmux if you want background execution:

```bash
tmux new-session -d -s my-loop "dev-loop run"
```

## Status Output

```
📊 Dev Loop Status

Status: running | Phase: reviewing | Iteration: 2/20
Claude: claude-personal | Reviewers: reviewer-a, reviewer-b

🟢 Active agent sessions:
   tmux attach -t dev-loop-review-reviewer-a-2
   tmux attach -t dev-loop-review-reviewer-b-2

Verdicts:
  ✅ reviewer-a: APPROVED
  ⏳ reviewer-b: pending

📜 Sessions (Iteration 2):
   🔨 claude-personal: dev-loop-impl-claude-personal-2 ⚫
   🔍 reviewer-a: dev-loop-review-reviewer-a-2 🟢
   🔍 reviewer-b: dev-loop-review-reviewer-b-2 🟢
```

## Logs

The `dev-loop logs` command reads Claude's session files to show conversation history.

**Note**: Session files are only created when Claude runs in interactive mode. In `--print` mode (used for automation), session persistence may be disabled. Live inspection via `tmux attach` is the recommended way to observe agent behavior.

## Metrics

`kloop serve` exposes Prometheus metrics at `/metrics` (computed from the run
index — no LLM calls):

- `kloop_runs_running` — runs currently running.
- `kloop_runs{status}` — runs by status (completed/crashed/cancelled/…).
- `kloop_agent_failures{binary,reason}` — failed agent attempts across recent
  runs, by binary and reason (`exit_code_N`, `timeout`, `no_verdict`,
  `interrupted`). Reads the implementer + every review/verify-phase reviewer +
  synthesis + checkpoint of each loop; cached ~60s (bounded scan of recent runs).

## Why Bun?

This project uses Bun-native APIs for performance and security:

```typescript
// Binary validation without shell
const resolvedPath = Bun.which(binary);

// Atomic file locking with exclusive create
await fs.writeFile(lockFile, content, { flag: 'wx', mode: 0o600 });

// Secure temp files with proper permissions
await fs.writeFile(promptFile, prompt, { mode: 0o600 });

// Direct process spawning (no shell injection)
const proc = Bun.spawn(['tmux', 'new-session', '-d', '-s', sessionName], {
  cwd: workDir,
  env: process.env,
});

// Fast file I/O
const data = await Bun.file(path).json();
await Bun.write(path, JSON.stringify(data, null, 2));

// Cryptographic hashing
const hasher = new Bun.CryptoHasher('sha256');
hasher.update(cwd);
const hash = hasher.digest('hex');
```
