<!-- rtk-instructions v2 -->

## Agent rules

- Never use Python for ad hoc scripting, file edits, or JSON/text munging. Use `bun` for scripts that need a real language; otherwise use shell tools (`rg`, `sed`, `awk`, `jq`), repo-native commands, or `apply_patch`.
- The AI agent fleet (per-account `claude-<name>` / `codex-<name>` wrappers + their settings/memory/skills/hooks) is managed by **`kfleet`**. Home Manager owns the source assets in this repo under `kfleet/` and links them into `~/.kfleet/`; edit `kfleet/config.yaml`, `kfleet/CLAUDE.md`, `kfleet/CLAUDE.auto.md`, `kfleet/templates/`, `kfleet/skills/`, `kfleet/skills-codex/`, or `kfleet/hooks/`, then run `hms` (which runs `kfleet apply`) or run `kfleet apply` for asset-only refreshes. Do NOT edit generated homes like `~/.claude-<name>/`, `~/.codex-<name>/`, or generated wrappers under `~/.kfleet/bin/`. `modules/agent-config` is deprecated legacy seed material; do not use it as the source of truth. Only `multi-gh`/`multi-gws` accounts are still Nix-managed in `home-template.nix`.
- **Secrets (SOPS + age).** `secrets.enc.yaml` (committed, encrypted) pairs with `secrets.yaml` (gitignored, decrypted working copy). ALWAYS work on the decrypted `secrets.yaml` — never `sops edit` the enc file (that desyncs the pair). Rules:
  - Decrypt ONLY if `secrets.yaml` doesn't exist: `./scripts/secrets/decrypt.sh` (it refuses to overwrite an existing working copy).
  - Re-encrypt ONLY before committing: `./scripts/secrets/encrypt.sh` (skips when already in step, so no ciphertext churn). Then `git add secrets.enc.yaml`.
  - The `a-secrets-sync` pre-commit hook runs on EVERY commit and blocks it when `secrets.yaml` has edits not yet in `secrets.enc.yaml` — if a commit fails there, run encrypt and retry. Never delete or `--no-verify` around it.
  - Never commit `secrets.yaml` itself.
- **Box provisioning.** `pls box:up -- <aws|digitalocean|oci> [--replicate]` provisions the box via OpenTofu (`infra/<cloud>/`, all three clouds are identical: x86_64 Ubuntu 24.04 + shared `infra/cloud-init.yaml.tftpl`); `pls box:down -- <cloud>` destroys it. Cloud creds live in sops at `.box.clouds.<cloud>` in `secrets.yaml`; tofu state is local + gitignored, so down must run on the machine that ran up.
- **Box replication.** `./scripts/box/replicate.sh <user@host> [profile]` (or `pls box:replicate -- ...`) clones this whole home-manager onto a fresh Linux box: it seeds the local age key, runs `scripts/setup.sh` remotely (Nix + home-manager switch; the `load-secrets` activation materializes SSH keys from sops), then `scripts/box/clone-stuff.sh` clones every repo in the sops-encrypted manifest (`.box.repos` in `secrets.yaml`) into `~/Workspace`. Regenerate that manifest with `./scripts/box/gen-repos.sh` (it stays inside sops on purpose — this repo is public and the list names private/work repos), then re-encrypt.
- **When a command needs `sudo`** (e.g. `hms`, which runs `sudo darwin-rebuild`), the Bash tool has no tty to type a password into. Don't hand it back — give `sudo` an **askpass helper** that pops a macOS `osascript` dialog, and run with `sudo -A` (run the build as a background job since it takes minutes). The dialog must state the **agent** (claude/codex + name), **repo**, **folder path**, **worktree**, and **purpose**. Do NOT use the `sudo -S -v` timestamp-prime trick — `tty_tickets` defeats it. Full pattern in `kfleet/CLAUDE.md` → "Elevated commands (sudo via osascript askpass)".

# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:

```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)

```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (90-99% savings)

```bash
rtk cargo test          # Cargo test failures only (90%)
rtk vitest run          # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)

```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)

```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)

```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)

```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)

```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)

```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)

```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands

```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category         | Commands                       | Typical Savings |
| ---------------- | ------------------------------ | --------------- |
| Tests            | vitest, playwright, cargo test | 90-99%          |
| Build            | next, tsc, lint, prettier      | 70-87%          |
| Git              | status, log, diff, add, commit | 59-80%          |
| GitHub           | gh pr, gh run, gh issue        | 26-87%          |
| Package Managers | pnpm, npm, npx                 | 70-90%          |
| Files            | ls, read, grep, find           | 60-75%          |
| Infrastructure   | docker, kubectl                | 85%             |
| Network          | curl, wget                     | 65-70%          |

Overall average: **60-90% token reduction** on common development operations.

<!-- /rtk-instructions -->
