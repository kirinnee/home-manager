---
name: kteam
description: Coordinate full-strength Claude and Codex teammates in detached tmux sessions with external stall monitoring, durable file channels, completion markers, and resumable conversations. Use when work can be divided into independent tasks, when the user asks for teammates or subagents, or when delegating research, implementation, frontend, review, or long-running work across model accounts.
---

# KTeam

Use `kteam` instead of harness-native subagents. Keep the current conversation as team lead; delegate bounded tasks to full-strength Claude or Codex harnesses. Teammates always run as interactive TUIs inside tmux; never replace that base with Claude `--print` or Codex `exec`.

`kteam` is a client of the long-running `kteamd` daemon. Check `kteam daemon status`; start or install it when unavailable. The daemon owns tmux, transcript watching, state, health, attachments, and event streaming.

## Tasks — keep the board true

The task board is the human's window into the fleet. It only works if it is TRUE — every rule here exists because the board was wrong in a real, repeated way. Writes are scoped to your own session (`KTEAM_SESSION_ID`; an agent may only write its own tasks). `kteam task list --all` is the fleet-wide read.

### Create one task per human ask

Record the task BEFORE you start the work:

```bash
kteam task create --kind <bug|feature|infra|chore> --title "<Title Case, 5 words max>" \
  --ask "<the human's words, verbatim>" --ask-source "<message link>" \
  [--workflow quick|design-first|research-first|investigate] [--depends-on '#F12']
```

- `--ask` and `--ask-source` are REQUIRED. Preserve the human's exact words and where they said them.
- The title cap is **five words**, enforced — but the error is generic usage text, not the real reason. If create "mysteriously" fails, count your title words first.
- Scope and detail go in `--description` / `--description-file`, never the title.

### Related ask? Update the existing task — never duplicate

Same task iff the new ask changes what that task's existing deliverable must do, or says that deliverable is wrong. New deliverable — even in the same area — is a NEW task with `--depends-on`.

```bash
kteam task clarify '#F12' "<the new ask, verbatim>" --source "<message link>"      # log it inside
kteam task reopen  '#F12' --reason "<why it is back>" --ask "<verbatim>" --source "<link>"
```

- `reopen` moves shipped work (`built`/`live`) back to in progress and records the new ask atomically. Reopening human-verified `done` is human-only — raise attention instead.
- For a related ask on a task still in `todo`/`blocked`, `clarify` it and move it with `kteam task status '#F12' in_progress --reason "<why>"`.
- Genuinely ambiguous whether it's the same task? Ask the human "fold into #F12 or new task?" — never guess silently.

### Keep status current AS EVENTS HAPPEN — not at wrap-up

Each status is tied to an event. When the event happens, move the task in the same breath:

```bash
kteam task status '#F12' in_progress --reason "picked up, starting the parser fix"
kteam task status '#F12' built       --reason "PR #123 merged"            # the change LANDED
kteam task status '#F12' live        --reason "deployed in release abc"   # the change is DEPLOYED
kteam task status '#F12' blocked     --reason "needs the human's API key"
```

- **`built` ≠ `live` — the single biggest source of board drift.** `built` = the change landed (merged, verified). `live` = it is actually deployed where users touch it. Two different moments; record each when it happens.
- Every status/phase/reopen move REQUIRES `--reason`; `blocked` and `dropped` require one even at create.
- `kteam signal done` auto-moves your task `build → built` only. It never deploys and never skips phases — everything else you move yourself.
- Human gates: advancing out of `research`/`design`, and `live → done`, need the human. Leave the task at the gate; don't fight the state machine.
- On the board, research/design/build all show as one `in_progress` lane; the exact phase stays in the record for audit.

### Assignment is optional — unassigned is normal, not neglected

- A `todo` task with no assignee is a healthy queue entry, not a problem to fix.
- NEVER assign yourself to look busy — a real drift source the human hand-corrected.
- Assign when work genuinely starts: `kteam task assign '#F12' <teammate|--none>`. If you stop working it, unassign or hand off explicitly — a dead assignee shows as `⚠ assignee-dead` and someone has to chase it.

### Priority

- Priority is the lead's rank: `kteam task order '#F12' <n>` (lower sorts first; `--none` unranks).
- Agents don't set it uninvited. PROPOSE one, with the reason, when you learn something that changes urgency:
  `kteam task note '#F12' "propose rank 1: this blocks #F13 and #F14"`.

### Dependencies: need-to vs wait-for — INCOMING (#F126/#F127), not live yet

Today there is ONE edge kind: `kteam task depend '#F12' '#F10'`, treated as a hard blocker. Use it only for genuine blockers; put advisory ordering in a note.

The split below is DESIGNED but NOT SHIPPED. Do not use these verbs until `kteam task` help lists them:

- `kteam task need '#F12' '#F10'` — HARD blocker: the task genuinely cannot start until the dependency is done (`depend` becomes an alias of this).
- `kteam task wait '#F12' '#F10'` — SOFT advisory ordering, usually "these touch the same files, keep them serial". A suggestion; the scheduler may override it with a reason.
- The board then derives four states: **ready** (pick up now) · **queued** (only wait-for unmet — startable by choice) · **blocked** (unmet need-to) · **in progress**. Most unassigned todo tasks are simply queued or ready — not neglected.
- Also incoming: `--wait-for '#F10'` on create, `kteam task priority '#F12' <urgent|high|normal|low|--none>`, and `kteam task list --ready`.

### Link your work the moment evidence exists

```bash
kteam task link '#F12' --pr https://github.com/org/repo/pull/123
kteam task link '#F12' --branch fix/parser-crash
kteam task link '#F12' --commit 0e17dc9
kteam task link '#F12' --doc ~/.kteam/<id>/brief-parser.md
```

### Be honest — `completed` is a claim

- Never move a task forward on an agent's say-so (including your own teammates'): read their `summary.md`, inspect the diff, run the checks — then move it, citing the evidence in `--reason`.
- `done` means THE HUMAN verified the shipped thing. Only the human moves `live → done`. Never claim it.
- Never render an unknown as a confident status. Don't know whether it deployed? It stays `built`, and you say so.

### Common mistakes (all real, all hand-corrected by the human)

| Mistake                                             | The rule it broke                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Work merged, task still `in_progress`               | move to `built` the moment it lands                                                                 |
| Agent died, its task showed `in_progress` for hours | unassign or hand off when you stop; leads sweep `⚠ assignee-dead`                                   |
| Code deployed, task stayed `built`                  | `live` is its own event — record the deploy                                                         |
| Tasks finished but sitting in `todo`                | status moves with the event, not at wrap-up                                                         |
| Human parked a task, board showed it as active work | a parked task stays where the human left it — never reactivate or self-assign it without their word |

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
| Opus 5                            | TOP IMPLEMENTER TIER — same tier as GPT-5.6-sol: use for the hardest, most critical implementations (and strong planning). Only accounts with Opus 5 access serve it                                                  | medium  | `claude-auto-{kirin,atomi}` (default via `opus`; liftoff/loge lack access → they serve 4.8) |
| Opus 4.8                          | next-best after the top tier — good implementer                                                                                                                                                                       | medium  | `claude-auto-{kirin,liftoff,atomi}` (default)                                               |
| GPT-5.6-terra / GPT-5.5           | alright implementers but VERY STRONG reviewers — default choice for reviewing anyone's work                                                                                                                           | medium  | `codex-auto-{loai,loio,ernest,kirin,atomi,personal}` (terra default; gpt-5.5 via `--model`) |
| GLM-5.2                           | Opus 4.8 substitute for implementation; downside: SLOW                                                                                                                                                                | slow    | `claude-auto-glm52{a,b}` (default)                                                          |
| MiniMax M3 / Sonnet 5             | super well-guarded tasks — mechanical plus a bit of smarts; M3 is also strong at frontend/UI/screenshot-to-code/SVG                                                                                                   | fast    | `claude-auto-mm3`; Anthropic accounts + `--model sonnet`                                    |
| DeepSeek V4 Flash                 | very well-scoped tasks only — no blindspots, everything written out; pure mechanical                                                                                                                                  | fast    | `claude-auto-dsv4f` (default)                                                               |
| Haiku 4.5 / GLM-4.7 / GLM-5-Turbo | trivial mechanical work only                                                                                                                                                                                          | fastest | Anthropic accounts + `--model haiku`; `glm52{a,b}` + `--model sonnet`/`--model haiku`       |

### Handoff chain (main thread → planner → implementer → reviewer)

The standard chain: **main thread (Fable) → planner session → implementer session(s) → reviewer**.

- The main thread stays team lead and judges complexity, but OFFLOADS the planning itself: send it to a kteam **Fable** session. For simpler, low-ambiguity plans the planner can be **GPT-5.6-sol, Opus 5, or Opus 4.8** instead.
- A planner session may spawn its own implementer teammates — ideally **Opus 4.8, GPT-5.6-terra, or GLM-5.2** — for generic to mid-high difficulty tasks.
- Implementer selection:
  - **GPT-5.6-sol / Opus 5** — the top implementer tier: long, big workloads with many checkpoints/checklists, and the hardest critical implementations. Expensive; don’t spend them on small tasks. (Opus 5 only on accounts that have it: kirin/atomi.)
  - **Opus 4.8 / GPT-5.6-terra** — generic to mid-high difficulty.
  - **GLM-5.2** — mechanical or frontend work; use sparingly.
- **GPT-5.6-terra / GPT-5.5 may implement ONLY when a smarter model (Fable, sol, Opus 5, or Opus 4.8) wrote the plan.** Never let terra plan-and-implement nontrivial work on its own.
- **Product-facing work: NEVER MiniMax M3 or DeepSeek V4** — too weak; GLM-5.2 sparingly.
- **GLM-5.2 and MiniMax M3 are the mass-chore tier**: divide-and-conquer jobs, 1 file = 1 agent style. That is their only broad-use niche.
- **Big-context tasks need at least Opus 4.8 or GPT-5.6-terra — and if a big-context task is being IMPLEMENTED, the implementer must be GPT-5.6-sol, Opus 5, or Fable** (Fable implementing is fine there).

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

## Teammates talking to each other (peer messaging)

Not everything has to route through the lead. **Any session may `kteam send <teammate> "…"` to any other session** — names resolve fleet-wide, so a teammate addresses a peer exactly the way you do. A send issued from inside a pane is automatically stamped with the sending SESSION, and the receiver sees a banner naming the sender and saying explicitly that it is not the human lead (the web UI shows it as a sender chip instead).

**When to use a peer, when to report to the lead:**

- **Peer** — you need a fact, artifact, or decision that another teammate owns: an interface it just defined, whether it already migrated a file you are about to touch, the shape of the fixture it wrote. Anything where the answer is _in another session's head_ and the lead would only be relaying.
- **Lead** — scope changes, conflicts you cannot resolve between yourselves, anything needing the user, and your final result. The lead is the one holding the whole picture; do not route a decision through a peer to avoid asking.

**Two shapes. Pick deliberately.**

1. **Fire-and-forget** — say it and carry on:

   ```bash
   kteam send jessie "FYI: I renamed Session.quota to Session.usage in types.ts; rebase before you touch it."
   ```

   The receiver is told no reply is expected. Use this for anything the peer needs to _know_ but you do not need an answer to.

2. **Request/response** — ask, then WAIT for the answer:

   ```bash
   kteam send jessie --ask --until 30m "What exact field name did you settle on for the reset timestamp?"
   ```

   `--ask` does two things: it tells the receiver you are blocked and spells out the reply command (`kteam send <you> "…"`), and it **parks your own session** on that peer. Waiting this way is a first-class healthy state — the 180 s nudge, the 300 s stall kill, and the turn ceiling are all suspended, exactly as for `kteam signal waiting`, so a legitimate wait is never read as a stall. The daemon wakes you **the instant that peer sends anything back**; you do not poll. `--until` is optional (open-ended parks are fine; everything is force-woken after 4 h).

   Equivalent long form if you already sent the question: `kteam signal waiting --peer jessie --until 30m`.

**Answering a peer is just a normal send.** There is no special reply command — `kteam send <asker> "…"` un-parks them automatically.

**Cautions:**

- **A peer may be mid-turn.** Your message lands in its harness's native queue and is consumed at the next turn boundary, not immediately. Do not expect a fast answer from a busy teammate, and never `--ask` a peer that is about to finish.
- **`--ask` is a real block.** Only use it when you genuinely cannot proceed. If you can do useful work without the answer, fire-and-forget and keep going.
- **A peer that can never answer is flagged.** If you park on a teammate that is already completed/failed/stopped (or does not exist), the warden raises `peer_wait_unanswerable` and assigns a warden to unstick you, rather than letting you sit until the 4 h backstop.
- `kteam ps` shows a peer park as `waiting PARKED←<name>`, so the lead can see agent-to-agent conversations in flight.

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
