- Run your own shell/tool-call commands through `direnv exec . <command>` (or `direnv exec <dir> <command>`) so the environment — including the nix shell — is loaded; `direnv exec` searches upward for the nearest `.envrc` and runs normally if none exists. **`direnv exec <dir>` loads that dir's env but does NOT change the working directory** — the command still runs in the current CWD (`direnv exec /tmp pwd` prints your CWD, not `/tmp`). To run _inside_ a directory, `cd` there (see the `cd` bullet below) or pass absolute paths — `direnv exec <dir>` alone will not put you there.
- In normal, non-autonomous sessions, when giving command examples or instructions to the user, omit the `direnv exec ...` prefix. Still use `direnv exec` for your own tool calls in `.envrc` directories, but show user-facing commands as the bare command, e.g. `hms` rather than `direnv exec . hms`.
- **`cd` is allowed and works** in the Bash tool. It may print a harmless zoxide config warning, but it does NOT fail — the old "`cd` is banned / fails with `command not found: __zoxide_z`" claim was wrong. The one real constraint: the Bash tool **resets CWD between calls**, so keep `cd` and the command in the **same** call — e.g. `cd /abs/dir && <command>`, or `cd /abs/dir && direnv exec . <command>` to also load the env. (Passing an absolute path to a command still works too, when it takes one.)
- Never use Python for ad hoc scripting, file edits, or JSON/text munging. Use `bun` for scripts that need a real language; otherwise use shell tools (`rg`, `sed`, `awk`, `jq`), repo-native commands, or `apply_patch`.
- When working on PE or Liftoff tasks that are ops-related (infrastructure, Kubernetes, metrics, logs, production debugging), use the `/liftoff-ops` skill. This ensures `loctl` is used instead of direct kubectl/helm/aws/etc.
- For autonomous ticket-to-PR workflows, use the `/kagent-autopilot` skill.
- The AI agent fleet (per-account `claude-<name>` / `codex-<name>` wrappers + their settings/memory/skills/hooks) is managed by **`kfleet`**. Home Manager owns the source assets in this repo under `kfleet/` and links them into `~/.kfleet/`; edit `kfleet/config.yaml`, `kfleet/CLAUDE.md`, `kfleet/CLAUDE.auto.md`, `kfleet/templates/`, `kfleet/skills/`, `kfleet/skills-codex/`, or `kfleet/hooks/`, then run `hms` (which runs `kfleet apply`) or run `kfleet apply` for asset-only refreshes. Do NOT edit generated homes like `~/.claude-<name>/`, `~/.codex-<name>/`, or generated wrappers under `~/.kfleet/bin/`. `modules/agent-config` is deprecated legacy seed material; do not use it as the source of truth. Only `multi-gh`/`multi-gws` accounts are still Nix-managed in `home-template.nix`.

## Communication style

- Assume the user has ADHD and dyslexia. When replying or summarizing, make the response friendly and accessible:
  - Lead with the answer or outcome first; put details after.
  - Keep it short. Prefer a few clear sentences or tight bullets over long paragraphs and walls of text.
  - Use plain, concrete language; avoid jargon, or define it briefly when unavoidable.
  - Use formatting that aids scanning: bullets, short lines, bold for the key point. Don't bold so much that nothing stands out.
  - One idea per bullet/line. Break complex steps into a numbered list.
  - Make any action the user needs to take obvious and easy to find.
- This applies to user-facing prose only — it does not change code, commit messages, or file contents.

## Pull request workflow

- Always work in a fresh git worktree for a PR — create a new one; do not work in place on an existing checkout.
- Keep the branch current with the base: pull the latest `master`/`main` before starting and again before pushing/finishing (rebase or merge) so the PR is never behind the most up-to-date upstream.
- Babysit the PR until it is genuinely green before marking the work done — resolve merge conflicts and fix CI failures yourself, push the fixes, and re-verify that conflicts are cleared and CI is passing.
- Never merge a PR yourself; leave the actual merge to the user.
