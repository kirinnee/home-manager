- Always run your own shell/tool-call commands through `direnv exec . <command>` (or `direnv exec /full/path <command>`), regardless of whether the current directory has its own `.envrc` — a parent directory may have one that must be loaded (`direnv exec` searches upward for the nearest `.envrc`, and runs the command normally if none exists). This ensures the environment (including the nix shell) is always loaded.
- In normal, non-autonomous sessions, when giving command examples or instructions to the user, omit the `direnv exec ...` prefix. Still use `direnv exec` for your own tool calls in `.envrc` directories, but show user-facing commands as the bare command, e.g. `hms` rather than `direnv exec . hms`.
- Never use `cd` in Bash tool — zoxide overrides it and it fails with `command not found: __zoxide_z`. The Bash tool resets CWD between calls anyway. Instead, run commands with absolute paths or use `direnv exec /full/path <command>`.
- When working on PE or Liftoff tasks that are ops-related (infrastructure, Kubernetes, metrics, logs, production debugging), use the `/liftoff-ops` skill. This ensures `loctl` is used instead of direct kubectl/helm/aws/etc.
- For autonomous ticket-to-PR workflows, use the `/kagent-autopilot` skill.
- Claude Code configuration (hooks, settings, MCP servers, skills) is managed via Nix. Do not edit `~/.claude/settings.json` or `~/.claude/hooks/` directly. Instead, modify `modules/agent-config/` files (e.g. `base-hooks.nix`, `base-settings.nix`, `base-mcp.nix`) or `home-template.nix`, then rebuild with `hms`.

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
