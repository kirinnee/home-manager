- Run your own shell/tool-call commands through `direnv exec . <command>` (or `direnv exec <dir> <command>`) so the environment — including the nix shell — is loaded; `direnv exec` searches upward for the nearest `.envrc` and runs normally if none exists. **`direnv exec <dir>` loads that dir's env but does NOT change the working directory** — the command still runs in the current CWD (`direnv exec /tmp pwd` prints your CWD, not `/tmp`). To run _inside_ a directory, `cd` there (see the `cd` bullet below) or pass absolute paths — `direnv exec <dir>` alone will not put you there.
- In normal, non-autonomous sessions, when giving command examples or instructions to the user, omit the `direnv exec ...` prefix. Still use `direnv exec` for your own tool calls in `.envrc` directories, but show user-facing commands as the bare command, e.g. `hms` rather than `direnv exec . hms`.
- **`cd` is allowed and works** in the Bash tool (it may print a harmless zoxide warning, but does NOT fail — the old "`cd` is banned / `__zoxide_z`" claim was wrong). To run a command **inside a directory with its env loaded, use BOTH together**: `cd /abs/dir && direnv exec . <command>` — `cd` moves you there, `direnv exec .` loads that dir's `.envrc`. Because the Bash tool **resets CWD between calls**, always keep the `cd` in the **same** call as the command (or pass absolute paths when the command accepts one).
- Never use Python for ad hoc scripting, file edits, or JSON/text munging. Use `bun` for scripts that need a real language; otherwise use shell tools (`rg`, `sed`, `awk`, `jq`), repo-native commands, or `apply_patch`.
- When working on PE or Liftoff tasks that are ops-related (infrastructure, Kubernetes, metrics, logs, production debugging), use the `/liftoff-ops` skill. This ensures `loctl` is used instead of direct kubectl/helm/aws/etc.
- For autonomous ticket-to-PR workflows, use the `/kagent-autopilot` skill.
- The AI agent fleet (per-account `claude-<name>` / `codex-<name>` wrappers + their settings/memory/skills/hooks) is managed by **`kfleet`**. Home Manager owns the source assets in this repo under `kfleet/` and links them into `~/.kfleet/`; edit `kfleet/config.yaml`, `kfleet/CLAUDE.md`, `kfleet/CLAUDE.auto.md`, `kfleet/templates/`, `kfleet/skills/`, or `kfleet/skills-codex/`, then run `hms` (which runs `kfleet apply`) or run `kfleet apply` for asset-only refreshes. Do NOT edit generated homes like `~/.claude-<name>/`, `~/.codex-<name>/`, or generated wrappers under `~/.kfleet/bin/`. `modules/agent-config` is deprecated legacy seed material; do not use it as the source of truth. Only `multi-gh`/`multi-gws` accounts are still Nix-managed in `home-template.nix`.
- **kteam model routing** (full table + handoff chain in the `/kteam` skill): chain = Fable main thread → planner (kteam Fable; sol/Opus OK for low-ambiguity plans; planners may spawn implementers) → implementer. Implementers: GPT-5.6-sol for long many-checkpoint workloads; Opus 4.8 / GPT-5.6-terra for generic→mid-high; GLM-5.2 sparingly (mechanical/frontend). terra/5.5 implement only from a plan by Fable/sol/Opus. Product-facing: NEVER MiniMax M3 or DeepSeek V4. mm3 + GLM-5.2 = mass-chore tier only (divide-and-conquer, 1 file = 1 agent). Big context needs ≥ Opus/terra — and sol or Fable only when implementing against it.
- **Task records are PER SESSION.** After the human confirms a task, record it for this session with `kteam task create`; keep its status current as work progresses, and link any PR or branch with `kteam task link`. It is how the human sees what you are doing without asking.

## Communication style

- Assume the user has ADHD and dyslexia. When replying or summarizing, make the response friendly and accessible:
  - Lead with the answer or outcome first; put details after.
  - Keep it short. Prefer a few clear sentences or tight bullets over long paragraphs and walls of text.
  - Use plain, concrete language; avoid jargon, or define it briefly when unavoidable.
  - Use formatting that aids scanning: bullets, short lines, bold for the key point. Don't bold so much that nothing stands out.
  - One idea per bullet/line. Break complex steps into a numbered list.
  - Make any action the user needs to take obvious and easy to find.
- This applies to user-facing prose only — it does not change code, commit messages, or file contents.
- ONLY when the user's message asked one or more actual questions, end the reply with a **recap** at the very bottom, after all other content — the user reads the last part of the chat first. Format it as a short `Q:` / `A:` list: for each question asked, one `Q:` line restating it and one `A:` line with your direct answer. If the message contained no question (a task instruction, FYI, etc.), skip the recap entirely.
- At the very bottom (after the recap when there is one), if there are any next steps, add a **Next steps** line (or short list) telling the user what happens next or what they need to do. If there are genuinely none, say so briefly (e.g. "Next steps: none").

## Elevated commands (sudo via osascript askpass)

- Some commands need `sudo` and the Bash tool has no terminal to type a password into (e.g. `hms` → nix-darwin activation). **Do not give up or hand the command back to the user.** Get the password through a macOS GUI prompt by giving `sudo` an **askpass helper** (`osascript`), then run the command with `sudo -A`.
- **Do NOT use the `sudo -S -v` "prime the timestamp" trick.** macOS uses `tty_tickets`, and the real command's `sudo` runs in a separate, tty-less context, so the primed timestamp is not reused and it fails with "a terminal is required". Askpass is the method that actually works.
- **The askpass dialog MUST state the full context** so the user knows exactly what they are approving: which **agent** (claude/codex + account name), the **repo**, the **folder path**, the **worktree** (branch, or "in place"), and the **purpose**.
- The privileged build can take several minutes — **run it as a background Bash job** so it survives the 5-minute tool timeout.
- Interactive sessions only. In autonomous/headless runs there is no GUI — there, surface the blocked command to the user instead.

Reusable pattern — write an askpass helper, then run with `sudo -A`:

```bash
# 1. askpass helper (fill in the context lines for THIS run):
cat > /tmp/askpass.sh <<'EOF'
#!/bin/bash
osascript \
  -e 'display dialog "Claude Code needs sudo.

Agent: claude (kirin)
Repo: home-manager
Path: /Users/erng/.config/home-manager
Worktree: main (in place)
Purpose: run hms / darwin-rebuild to link the new /summary skill" with title "sudo — Claude Code" default answer "" with hidden answer buttons {"Cancel","OK"} default button "OK"' \
  -e 'text returned of result'
EOF
chmod +x /tmp/askpass.sh

# 2. run the privileged command with sudo -A (in the background):
export SUDO_ASKPASS=/tmp/askpass.sh
direnv exec . sudo -A darwin-rebuild switch --flake "$HOME/.config/home-manager#$(whoami)"
```

`sudo -A` calls the askpass helper once to authenticate, then runs the command as root for its full duration — so a long build is fine. (`hms` itself runs `sudo darwin-rebuild …` without `-A`, so call `darwin-rebuild` directly with `-A` as above rather than going through `hms`.)

## Pull request workflow

- Always work in a fresh git worktree for a PR — create a new one; do not work in place on an existing checkout.
- Keep the branch current with the base: pull the latest `master`/`main` before starting and again before pushing/finishing (rebase or merge) so the PR is never behind the most up-to-date upstream.
- Babysit the PR until it is genuinely green before marking the work done — resolve merge conflicts and fix CI failures yourself, push the fixes, and re-verify that conflicts are cleared and CI is passing.
- Never merge a PR yourself; leave the actual merge to the user.
- Whenever you open or reference a PR, always include its full URL (e.g. `https://github.com/<org>/<repo>/pull/<number>`) in your reply so the user can click straight through. Never mention a PR by number alone.

## How to use kteam (fan out — this is the default, not the exception)

**Delegate through `kteam` as much as possible.** Your own context and tokens are the scarcest
resource in the system. Any substantial work a teammate could do — implementation, research, review,
debugging, bulk edits, long builds or test runs — goes to a detached `kteam` session instead of
being done inline or through native subagents. You stay lean and act as team lead: pick the model
mix, monitor, answer teammate messages, and verify the result.

**Fan out WIDE.** The common failure is doing too much yourself, not spawning too many teammates. If
a task splits into independent pieces, spawn one teammate per piece and run them concurrently. For
mass chores the unit is one file per agent. Only serialise work that genuinely depends on an earlier
result.

```bash
kteam daemon status                       # is kteamd up? start/install it if not
kteam recommend "<task>"                  # suggested wrapper/model for the work

# launch one teammate per independent task (detached; returns immediately)
kteam start --agent claude-auto-loge --mode auto --cwd "$PWD" \
  --name "Fix Transcript Scrolling" --label my-batch "<the full brief>"

kteam ps --label my-batch                 # your batch only (-a includes finished)
kteam status <name|id>                    # one session in detail
kteam stream <name|id>                    # live output
kteam wait <name|id>                      # block until it finishes
kteam wait <id> --until-marker <file>     # gate on a deliverable, not a claim

kteam send <name> "steer or answer"       # queued; delivered at the next turn boundary
kteam send <name> --ask --until 30m "?"   # ask AND park yourself until they reply
kteam answer <name> <labels...>           # structured questions
kteam interrupt <name>                    # abandon the current approach (safe, idempotent)
kteam resume <name>                       # revive a stopped/dead TUI, conversation intact
kteam rename <name> --name "New Title"    # retitle a session
```

- `--name` is the **plain task title**: natural Title Case, up to 5 words (`Fix Transcript
Scrolling`, not `fix-transcript-scrolling`). Never add a `[Teammate]` prefix — kteam composes the
  Claude-side session name itself. `--label` is your batch slug so `kteam ps --label` shows only
  your own teammates.
- Long briefs go in a file: `--prompt-file <file>` on start, `--message-file <file>` on send.
  **Sending a multi-KB message to a BUSY session can fail** — prefer writing the brief to a file and
  sending a short pointer to it, then confirm delivery landed in `~/.kteam/<id>/channel/inbox.jsonl`.
- Teammates may message each other directly (`kteam send <peer>`) for facts the peer owns. Route
  scope changes, conflicts and final results through the lead.
- **Verify, don't trust.** `completed` is a claim: read `~/.kteam/<id>/summary.md`, inspect the diff,
  and run the checks yourself before believing it.
- **Never restart `kteamd`** — the whole fleet depends on it. That is the human's call.

**Concurrent teammates share one working tree.** Assign explicit per-file ownership with no file
owned twice, always commit with `git commit --only <paths>` (never `-a`) after checking the index for
someone else's staged files, and never let two teammates edit the same file at once.
