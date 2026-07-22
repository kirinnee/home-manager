---
name: kteam
description: Coordinate full-strength Claude and Codex teammates in detached tmux sessions with external stall monitoring, durable file channels, completion markers, and resumable conversations. Use when work can be divided into independent tasks, when the user asks for teammates or subagents, or when delegating research, implementation, frontend, review, or long-running work across model accounts.
---

# KTeam

Use `kteam` instead of harness-native subagents. Keep the current conversation as team lead; delegate bounded tasks to full-strength Claude or Codex harnesses. Teammates always run as interactive TUIs inside tmux; never replace that base with Claude `--print` or Codex `exec`.

`kteam` is a client of the long-running `kteamd` daemon. Check `kteam daemon status`; start or install it when unavailable. The daemon owns tmux, transcript watching, state, health, attachments, and event streaming.

## Choose the team first

1. Run `kteam recommend "<task>"` and inspect the installed auto-mode wrappers.
2. Present a small proposed team with one task per teammate.
3. Wait for approval before consuming account quota, unless the user already named the exact wrappers or established a standing preference.
4. Start only independent, clearly bounded tasks. Avoid two teammates editing the same files.

### Always show the assignment table

Whenever you use kteam (one member or many) — both when proposing the team AND after launching it — list the assignments to the user as a 3-column table: which CLI wrapper, which model it will actually run, and the task it was given.

| CLI                 | Model           | Task                              |
| ------------------- | --------------- | --------------------------------- |
| `codex-auto-loge`   | gpt-5.6-sol     | implement the migration checklist |
| `claude-auto-atomi` | claude-opus-4-8 | fix the flaky session tests       |

Fill the Model column with the resolved model (the wrapper's `KTEAM_MODEL` default, or the `--model` override you passed) — never leave it implied.

### Pick the MODEL first, then the account

Model choice is driven by the task: how much thinking it needs, how confident you must be in correctness, and how fast/cheap it should run. Wrappers default to their kfleet `KTEAM_MODEL`; `--model <alias|id>` selects any other model the account serves (Claude aliases `opus`/`sonnet`/`haiku`/`fable` resolve per account).

| Model                             | Role — use when                                                                                                                                                                                                       | Speed   | How to get it                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| Fable 5                           | smartest — plan hard problems, understand complex relations and concepts, map blindspots; pin the design down BEFORE implementation starts                                                                            | slow    | `claude-auto-{kirin,liftoff,atomi}` + `--model fable`; `claude-auto-loge` (default)         |
| GPT-5.6-sol @ ultra effort        | best/smartest IMPLEMENTER — less raw smarts than Fable but more diligent and thorough. VERY EXPENSIVE: reserve for the hardest, most critical implementations, only after the big ideas and blindspots are mapped out | slow    | `codex-auto-loge` (default; pinned to ultra reasoning effort)                               |
| Opus 4.8                          | next-best model — good implementer                                                                                                                                                                                    | medium  | `claude-auto-{kirin,liftoff,atomi}` (default)                                               |
| GPT-5.6-terra / GPT-5.5           | alright implementers but VERY STRONG reviewers — default choice for reviewing anyone's work                                                                                                                           | medium  | `codex-auto-{loai,loio,ernest,kirin,atomi,personal}` (terra default; gpt-5.5 via `--model`) |
| GLM-5.2                           | Opus 4.8 substitute for implementation; downside: SLOW                                                                                                                                                                | slow    | `claude-auto-glm52{a,b}` (default)                                                          |
| MiniMax M3 / Sonnet 5             | super well-guarded tasks — mechanical plus a bit of smarts; M3 is also strong at frontend/UI/screenshot-to-code/SVG                                                                                                   | fast    | `claude-auto-mm3`; Anthropic accounts + `--model sonnet`                                    |
| DeepSeek V4 Flash                 | very well-scoped tasks only — no blindspots, everything written out; pure mechanical                                                                                                                                  | fast    | `claude-auto-dsv4f` (default)                                                               |
| Haiku 4.5 / GLM-4.7 / GLM-5-Turbo | trivial mechanical work only                                                                                                                                                                                          | fastest | Anthropic accounts + `--model haiku`; `glm52{a,b}` + `--model sonnet`/`--model haiku`       |

### Handoff chain (main thread → planner → implementer → reviewer)

The standard chain: **main thread (Fable) → planner session → implementer session(s) → reviewer**.

- The main thread stays team lead and judges complexity, but OFFLOADS the planning itself: send it to a kteam **Fable** session. For simpler, low-ambiguity plans the planner can be **GPT-5.6-sol or Opus 4.8** instead.
- A planner session may spawn its own implementer teammates — ideally **Opus 4.8, GPT-5.6-terra, or GLM-5.2** — for generic to mid-high difficulty tasks.
- Implementer selection:
  - **GPT-5.6-sol** — long, big workloads with many checkpoints/checklists, and the hardest critical implementations. VERY expensive; don't spend it on small tasks.
  - **Opus 4.8 / GPT-5.6-terra** — generic to mid-high difficulty.
  - **GLM-5.2** — mechanical or frontend work; use sparingly.
- **GPT-5.6-terra / GPT-5.5 may implement ONLY when a smarter model (Fable, sol, or Opus) wrote the plan.** Never let terra plan-and-implement nontrivial work on its own.
- **Product-facing work: NEVER MiniMax M3 or DeepSeek V4** — too weak; GLM-5.2 sparingly.
- **GLM-5.2 and MiniMax M3 are the mass-chore tier**: divide-and-conquer jobs, 1 file = 1 agent style. That is their only broad-use niche.
- **Big-context tasks need at least Opus 4.8 or GPT-5.6-terra — and if a big-context task is being IMPLEMENTED, the implementer must be GPT-5.6-sol or Fable** (Fable implementing is fine there).

Other rules of thumb:

- The less scoped and more ambiguous a task, the higher up the table; fully written-out mechanical work goes to the bottom.
- Do NOT use `claude-auto-dsv4p` (DeepSeek V4 Pro): too expensive for what it gives.
- For Fable on the OAuth accounts use the base wrapper + `--model fable` (the old `f5-*` wrappers were removed).
- Quota: `glm52a`/`glm52b` are separate keys (parallel-safe).

### Then pick the account

- NEVER route kteam work to `claude-auto-kirin` or `codex-auto-personal` — those are the user's personal daily-driver accounts.
- Loosely bias ~70% of TOKEN SPEND (not session count) to the loge wrappers (`claude-auto-loge`, `codex-auto-loge`) and ~30% to the remaining OpenAI/Anthropic accounts (`claude-auto-{liftoff,atomi}`, `codex-auto-{loai,loio,ernest,kirin,atomi}`). Grade tasks by difficulty — difficulty ≈ expected token burn — and send the heavy ones to loge; one monster task on loge can satisfy the split on its own.
- `claude-auto-loge` serves the whole Anthropic lineup through the kloge proxy — pass real model ids (`claude-fable-5` default, `claude-opus-4-8`, `claude-sonnet-5`), not aliases.
- GLM / MiniMax / DeepSeek accounts sit outside the 70/30 split — use them whenever the model table points there.

## Launch and supervise

Start one approved teammate per task. ALWAYS pass `--name` (a succinct summary of what the session is supposed to do) and `--label` (an ownership slug for YOUR batch — e.g. your session/repo/ticket identifier) so you can later list just your own teammates with `kteam ps --label <label>`:

```bash
kteam start --agent claude-auto-mm3 --mode auto --cwd "$PWD" --name build-claims-frontend --label tesla-infographic --image reference.png "Build the requested frontend and verify it"
kteam start --agent codex-auto-atomi --mode interactive --cwd "$PWD" --name review-current-diff --label tesla-infographic "Review the current diff with me"
```

For LONG prompts (more than a few sentences), write the brief to a file and pass `--prompt-file <file>` instead of inlining it on the command line (`kteam send` takes `--message-file` for the same reason); command-line and file content are combined when both are given. The daemon already delivers every prompt to the TUI via a turn file, so file-based briefs lose nothing.

Each wrapper already carries its own default model (kfleet's `KTEAM_MODEL`: `opus` for standard Claude accounts, `fable-5` for F5/frontier, `terra` for Codex), so you normally omit the model. Override only when a task needs a specific one with `--model <alias|id>`, e.g. `kteam start --agent claude-auto-kirin --model sonnet --cwd "$PWD" "…"`. Leave it off to keep the account default.

Every session gets an auto-assigned teammate NAME (e.g. mordecai) plus its model, both shown by `kteam ps` and `kteam status`. Always refer to teammates by NAME when reporting to the user — never by raw session ID — and present the team as a three-column table: Name | Model | Task. Names resolve anywhere an id is accepted (`kteam send mordecai "…"`), matched against sessions from the last 5 days, most recent wins.

Record each teammate name (ids also work). A live web UI (sessions table, streaming detail, send/answer/interrupt from the browser) is served by kteamd at http://127.0.0.1:7337/ — tell the user about it when they supervise a team from this machine. Use `kteam ps` (header row: TEAMMATE, ID, STATUS, MODEL, AGENT, MODE, LABEL, TASK; `--label <label>` filters to your batch, `-a` includes finished sessions), `kteam status <id>`, `kteam stream <id>`, and `kteam wait <id>` to supervise. `kteamd` is the external watcher; do not create another watcher.

Each session stores its complete protocol under `~/.kteam/<id>/`, including configuration, prompts, JSONL channels, snapshots, heartbeat/diff checks, logs, summary, markers, and kill diagnostics.

## Handle teammate messages

When a session enters `waiting`, `awaiting_user`, or `awaiting_question`:

1. Read `~/.kteam/<id>/channel/outbox.jsonl` and the latest snapshot.
2. Resolve the question in the main thread. Ask the user only when their decision is required.
3. Send the answer through the same interactive harness:

```bash
kteam send <id> "The decision or missing context"
```

Use `kteam send <id> "…"` for an interactive user turn — sending to a BUSY session queues the message and the daemon delivers it at the next turn boundary (add `--now` to fail instead of queueing); sending to a finished/stopped session automatically revives it with the message as the next turn. Use `kteam answer <id> <labels...>` for structured questions, and `kteam answer <id> --other "free-form answer"` for Other; for multiple questions, repeat `--response` once per question in order. `kteam interrupt <id>` is safe and idempotent (Escape, never C-c; a no-op on idle or already-interrupted panes) — but prefer queued `kteam send` for steering; interrupt only to abandon the current approach. Use `kteam resume` only after a stopped/dead TUI; it preserves the Claude/Codex conversation. Gate on deliverables with `kteam wait <id> --until-marker <file>` — a bare `completed` status is not proof the output files exist.

Attach initial images with `kteam start ... --image <file> "…"`; send follow-up images with `kteam send <id> --image <file> "…"`. The client uploads the bytes to the daemon, which validates and stores them under the session, then injects daemon-local absolute paths through tmux.

## Finish safely

Treat `completed` as a teammate claim, not proof. Read `summary.md`, inspect the repository diff, and run appropriate verification. For `failed`, `stalled`, or `stopped`, inspect `last-snapshot.txt`, `kill.json`, and the current turn log before deciding whether to reply, restart, or finish locally.

Useful commands:

```bash
kteam logs <id>
kteam snapshot <id>
kteam attach <id>
kteam stop <id> --reason "why it was stopped"
```

## Fleet warden

Session supervision has two layers. **Reflex (per-session monitor, 30 s tick):** every session carries a **liveness ledger** — seconds since conversation growth, thinking-counter advance, token-count advance, subprocess activity, and pane change — persisted to `~/.kteam/<id>/liveness.yaml` every tick (with the current nudge/kill/sus triggers) and shown by `kteam status` and the web UI. If ALL life-signs are silent for 180 s the monitor nudges once (interrupt + "continue" message, `session.nudged` event); still silent at 300 s it kills the pane (`stalled`, `session.killed`). Tune per session with `kteam start --nudge-after/--kill-after`; the per-turn `timeoutSeconds` ceiling is unchanged. **Sus list (daemon sweep, every 5 min):** alive-but-weird sessions — thinking with tokens flat and no transcript growth for 15 min (`susThinkingSeconds`; a CLIMBING token count is certain progress and never sus), a background subprocess running continuously for 15 min (`susSubprocessSeconds`), or a question unanswered past `unattendedMinutes` — each get ONE assigned warden session (`warden.wrapper`, default an Opus-class account; capped by `maxAssignedWardens`, deduped while one is live and for `assignedCooldownMinutes` after a verdict). The assigned warden reads the target's `liveness.yaml`, conversation, events, and processes, then delivers one verdict: LEAVE, NUDGE (`kteam send`), RESUME (`kteam resume`), or KILL — its token may `stop` ONLY its assigned session (checked server-side against the daemon's spawn record). Other anomalies (dead monitors, fresh wreckage, quota resets) still go to a shared fleet-triage warden. Inspect with `kteam warden status` / `kteam warden run` (`--spawn` forces escalation past the `warden.enabled` gate and `minSpawnGapMinutes` cooldown). Warden sessions run under a capability-scoped daemon token: they can read, `send`/`answer`/`resume`/`migrate`, `stop` only an assigned target, and `signal` only themselves done — never start or remove anything; their descendants are force-labelled by ancestry so a warden can never escalate against its own tree.

Parents are auto-captured: a teammate that starts another teammate is recorded as its `parent` (from `KTEAM_SESSION_ID`), so whole teammate trees group in `ps`/UI and inherit the lead's label.

## Move a session to another account

`kteam migrate <id> -a <wrapper> [--model m]` continues a session on a different same-kind account (any claude wrapper can resume a claude session; codex↔codex likewise — cross-kind is not supported). It keeps the conversation, teammate, label, and parent, then relaunches under the new wrapper. Migration is atomic: the intent is journaled before the old pane is stopped, and if the relaunch fails the config is rolled back to the original account and the session is marked `failed` — it is never left pointing at a wrapper that never launched. Auto-failover is decided **per session** and only when opted in (`retry.allowAccountFailover: true`): it fires only when the usage feed positively confirms the current account is at its limit AND a same-kind account has confirmed headroom — an unknown/absent usage reading never triggers it, so the session just keeps waiting for its own quota to reset.
