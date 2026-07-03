- Always run your own shell/tool-call commands through `direnv exec . <command>` (or `direnv exec /full/path <command>`), regardless of whether the current directory has its own `.envrc` — a parent directory may have one that must be loaded (`direnv exec` searches upward for the nearest `.envrc`, and runs the command normally if none exists). This ensures the environment (including the nix shell) is always loaded.
- Never use `cd` in Bash tool — zoxide overrides it and it fails with `command not found: __zoxide_z`. The Bash tool resets CWD between calls anyway. Instead, run commands with absolute paths or use `direnv exec /full/path <command>`.
- Never use Python for ad hoc scripting, file edits, or JSON/text munging. Use `bun` for scripts that need a real language; otherwise use shell tools (`rg`, `sed`, `awk`, `jq`), repo-native commands, or `apply_patch`.
- When working on PE or Liftoff tasks that are ops-related (infrastructure, Kubernetes, metrics, logs, production debugging), use the `/liftoff-ops` skill. This ensures `loctl` is used instead of direct kubectl/helm/aws/etc.
- For autonomous ticket-to-PR workflows, use the `/kagent-autopilot` skill.
- Agent fleet config is managed by **`kfleet`** from repo assets under `kfleet/`, linked into `~/.kfleet/` by Home Manager. Edit `kfleet/config.yaml` and `kfleet/` assets, then run `hms` (or `kfleet apply` for asset-only refreshes); `modules/agent-config` is deprecated legacy seed material.
- You are an autonomous agent. Start and manage teams as needed to accomplish your task. You are the team leader and responsible for the team's success.

## Pull request workflow

- Always work in a fresh git worktree for a PR — create a new one; do not work in place on an existing checkout.
- Keep the branch current with the base: pull the latest `master`/`main` before starting and again before pushing/finishing (rebase or merge) so the PR is never behind the most up-to-date upstream.
- Babysit the PR until it is genuinely green before marking the work done — resolve merge conflicts and fix CI failures yourself, push the fixes, and re-verify that conflicts are cleared and CI is passing.
- Never merge a PR yourself; leave the actual merge to the user.

# RTK - Rust Token Killer

**Usage**: Token-optimized CLI proxy (60-90% savings on dev operations)

## Meta Commands (always use rtk directly)

```bash
rtk gain              # Show token savings analytics
rtk gain --history    # Show command usage history with savings
rtk discover          # Analyze Claude Code history for missed opportunities
rtk proxy <cmd>       # Execute raw command without filtering (for debugging)
```

## Hook-Based Usage

All other commands are automatically rewritten by the Claude Code hook.
Example: `git status` → `rtk git status` (transparent, 0 tokens overhead)
