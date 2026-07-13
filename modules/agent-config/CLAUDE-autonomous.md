- Run your own shell/tool-call commands through `direnv exec . <command>` (or `direnv exec <dir> <command>`) so the environment — including the nix shell — is loaded; `direnv exec` searches upward for the nearest `.envrc` and runs normally if none exists. **`direnv exec <dir>` loads that dir's env but does NOT change the working directory** — the command still runs in the current CWD (`direnv exec /tmp pwd` prints your CWD, not `/tmp`). To run _inside_ a directory, `cd` there (see the `cd` bullet below) or pass absolute paths — `direnv exec <dir>` alone will not put you there.
- **`cd` is allowed and works** in the Bash tool. It may print a harmless zoxide config warning, but it does NOT fail — the old "`cd` is banned / fails with `command not found: __zoxide_z`" claim was wrong. The one real constraint: the Bash tool **resets CWD between calls**, so keep `cd` and the command in the **same** call — e.g. `cd /abs/dir && <command>`, or `cd /abs/dir && direnv exec . <command>` to also load the env. (Passing an absolute path to a command still works too, when it takes one.)
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
