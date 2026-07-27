- Run your own shell/tool-call commands through `direnv exec . <command>` (or `direnv exec <dir> <command>`) so the environment — including the nix shell — is loaded; `direnv exec` searches upward for the nearest `.envrc` and runs normally if none exists. **`direnv exec <dir>` loads that dir's env but does NOT change the working directory** — the command still runs in the current CWD (`direnv exec /tmp pwd` prints your CWD, not `/tmp`). To run _inside_ a directory, `cd` there (see the `cd` bullet below) or pass absolute paths — `direnv exec <dir>` alone will not put you there.
- **`cd` is allowed and works** in the Bash tool (it may print a harmless zoxide warning, but does NOT fail — the old "`cd` is banned / `__zoxide_z`" claim was wrong). To run a command **inside a directory with its env loaded, use BOTH together**: `cd /abs/dir && direnv exec . <command>` — `cd` moves you there, `direnv exec .` loads that dir's `.envrc`. Because the Bash tool **resets CWD between calls**, always keep the `cd` in the **same** call as the command (or pass absolute paths when the command accepts one).
- Never use Python for ad hoc scripting, file edits, or JSON/text munging. Use `bun` for scripts that need a real language; otherwise use shell tools (`rg`, `sed`, `awk`, `jq`), repo-native commands, or `apply_patch`.
- When working on PE or Liftoff tasks that are ops-related (infrastructure, Kubernetes, metrics, logs, production debugging), use the `/liftoff-ops` skill. This ensures `loctl` is used instead of direct kubectl/helm/aws/etc.
- For autonomous ticket-to-PR workflows, use the `/kagent-autopilot` skill.
- Agent fleet config is managed by **`kfleet`** from repo assets under `kfleet/`, linked into `~/.kfleet/` by Home Manager. Edit `kfleet/config.yaml` and `kfleet/` assets, then run `hms` (or `kfleet apply` for asset-only refreshes); `modules/agent-config` is deprecated legacy seed material.
- **kteam model routing** (full table + handoff chain in the `/kteam` skill): chain = Fable main thread → planner (kteam Fable; sol/Opus OK for low-ambiguity plans; planners may spawn implementers) → implementer. Implementers: GPT-5.6-sol for long many-checkpoint workloads; Opus 4.8 / GPT-5.6-terra for generic→mid-high; GLM-5.2 sparingly (mechanical/frontend). terra/5.5 implement only from a plan by Fable/sol/Opus. Product-facing: NEVER MiniMax M3 or DeepSeek V4. mm3 + GLM-5.2 = mass-chore tier only (divide-and-conquer, 1 file = 1 agent). Big context needs ≥ Opus/terra — and sol or Fable only when implementing against it.
- **Task records are PER SESSION.** After the human confirms a task, record it for this session with `kteam task create`; keep its status current as work progresses, and link any PR or branch with `kteam task link`. It is how the human sees what you are doing without asking.

## Pull request workflow

- Always work in a fresh git worktree for a PR — create a new one; do not work in place on an existing checkout.
- Keep the branch current with the base: pull the latest `master`/`main` before starting and again before pushing/finishing (rebase or merge) so the PR is never behind the most up-to-date upstream.
- Babysit the PR until it is genuinely green before marking the work done — resolve merge conflicts and fix CI failures yourself, push the fixes, and re-verify that conflicts are cleared and CI is passing.
- Never merge a PR yourself; leave the actual merge to the user.

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
