# kteam problem log

Append every kteam malfunction here (problem, evidence, suspected code path,
workaround) — see the kteam-experimental rule in CLAUDE.md. Commit and push so
entries merge across machines.

All entries logged through 2026-07-19 were root-caused, fixed, and verified in
real use; the full history lives in git (`git log -- kteam-prob.md`, fixes
landed through commit ff567bb). Highlights of what got fixed along the way:
env propagation to panes, launch.sh env sourcing, injection turn-start proof,
serialized bootstrap, pane-derived state (false completed/failed), atomic
revive-send, `wait --until-marker`, quota/auth fail-fast, and the loge
custom-api-key dialog.

<!-- New problems go below this line. -->

## Addendum 2026-07-19 (post-fix canary sweep)

- Rapid-start race: FIXED — 6 Claude lanes launched in one batch, all received prompts.
- glm52b: canary succeeded on-screen but daemon marked `failed: turn never started (no transcript activity within 360s)`. GLM slow-start vs transcript watcher — false-failed detection, lane is fine.
- codex-auto-loai / codex-auto-atomi (ChatGPT plans): `terra` → 400 "The 'terra' model is not supported when using Codex with a ChatGPT account". BUT `gpt-5.5` and `gpt-5.6-sol` both work on both accounts (canary-proven). So: terra-only entitlement gap; sol available on 3 lanes now (loge, loai, atomi).
- Both codex canaries showed a transient `PreToolUse hook (failed) — error: hook exited with code 1` line; turn proceeded anyway. Worth checking which hook exits 1 under CODEX_HOME wrappers.
- CORRECTION + FIX (same day): the terra 400 was NOT an entitlement gap — ChatGPT-backed codex simply has no model aliases; bare `terra` isn't a model ID. Real catalog: gpt-5.6-{terra,sol,luna}, gpt-5.5, gpt-5.4. Fixed in kfleet/config.yaml (KTEAM_MODEL: gpt-5.6-terra) + SKILL.md note. Also: server now pushes default_service_tier=priority ("Fast", 1.5x usage) on some accounts, so the auto variant now pins service_tier="standard" (interactive keeps "fast"). Verified by canary: terra-by-default works, auto footer shows no "fast" chip, luna works. RESOLVED.
- 2026-07-19 06:52: `kteam interrupt` on a codex session mid `tool_running` (doris, sol orchestrator) KILLED the TUI ("Conversation interrupted" then pane dead, exit 0). First interrupt attempt timed out ("harness did not become ready within 30s"), second killed it. `kteam resume` recovered the conversation (context preserved, continued as turn 2). Net: interrupt on busy codex = destructive; prefer file-based relays (STATUS.md sections) + wait for turn end. Also `kteam send` refuses while running, so there is NO safe live-steer channel for a busy codex session.
- 2026-07-19 diagnosis of the interrupt-kill (root cause, verified in source):
  (1) tmux-controller.ts interrupt() = blind `send-keys C-c`; codex quits on
  C-c at idle prompt → second interrupt attempt killed the TUI. Esc is the safe
  turn-stop for both harnesses. (2) BUSY_BLOCKERS includes 'background terminal
  running' — codex shows that footer WHILE IDLE whenever a background terminal
  exists → paneShowsActiveWork() false-positive forever → waitReady timeouts,
  poisoned inject turn-start evidence. FIX IN FLIGHT (session gemma,
  claude-auto-liftoff/opus): F1 Esc per-harness interrupt, F2 idempotent
  state-aware interrupt, F3 busy-heuristic fix + interrupted-banner ready
  signature, F4 auto-revive after any control keystroke that leaves a dead
  pane, F5 queued send (deliver at next turn boundary) with --now escape
  hatch. Requires kteamd restart to activate once merged.

## FIX SPEC — destructive interrupt + false-busy detection (2026-07-19, ready for implementation)

> Supersedes the "FIX IN FLIGHT (session gemma)" note above: that session was
> stopped before making ANY edit (git-verified clean); this spec is the
> authoritative brief for whichever agent implements it.
> Source: ~/.config/home-manager/modules/kteam-ts (bun TypeScript; the CLI and
> kteamd both run from this source — daemon picks up changes ONLY on restart).
> Tests: `bun test` in that directory (existing \*.test.ts style; fixtures/ dir).

### Reproduction (observed live 2026-07-19, session mrrejr6a, codex/sol)

1. Session busy (`tool_running`), footer shows "1 background terminal running"
   (it had a background `kteam wait` terminal — footer line persists while idle).
2. `kteam interrupt <id>` → sends C-c; codex shows "■ Conversation interrupted -
   tell the model what to do differently" (turn stopped, prompt editable).
3. kteam `waitReady` times out after 30s ("promptReady=false") because the
   busy-heuristic never clears (see RC2) → CLI throws.
4. Operator retries `kteam interrupt` → second C-c lands on the idle
   interrupted prompt → codex QUITS ("To continue this session, run codex
   resume <uuid>"; pane dead, exit 0).
5. `kteam resume <id>` recovered the conversation (worked as designed).

### Root causes

- RC1 — src/tmux-controller.ts:385-389: `interrupt()` is a blind
  `tmux send-keys C-c` + waitReady. In BOTH harness TUIs, Esc is the safe
  "stop current turn" key; C-c is the quit path (codex: C-c at idle prompt
  quits/primes quit). No pane-state check before the keystroke, no aliveness
  check after, no revive on death.
- RC2 — src/tmux-controller.ts:53: `BUSY_BLOCKERS` includes
  `'background terminal running'`. Codex prints that footer line PERMANENTLY
  WHILE IDLE whenever any background terminal exists, so
  `paneShowsActiveWork()` is a standing false positive for such sessions.
  Poisons: `waitReady` stabilization (line ~315), `inject()`'s `turnStarted`
  evidence (line ~335), and any busy-gating that calls it.

### Fixes (all five; keep each small and tested)

- **F1 — safe interrupt key.** `interrupt()` sends `Escape` (works for both
  claude and codex TUIs), never `C-c`. C-c may remain only in explicit
  kill/stop paths.
- **F2 — state-aware, idempotent interrupt.** Before the keystroke, capture
  pane state: if there is NO active-work evidence (already idle, or already
  showing the codex interrupted banner), send nothing and return success.
  Exactly one interrupt keystroke per call (no internal retries). After the
  keystroke, poll `alive()`; if the pane died, run F4 auto-revive; throw only
  if revive also fails.
- **F3 — busy-heuristic fix + interrupted-ready signature.** Remove
  `'background terminal running'` from `BUSY_BLOCKERS` (keep
  'esc to interrupt', 'ctrl+c to interrupt', and the spinner/token-counter
  regexes — those are genuine active-turn evidence). Add a codex ready
  signature: the "Conversation interrupted - tell the model what to do
  differently" banner with an editable prompt counts as promptReady. Grep all
  other uses of BUSY_BLOCKERS / 'background terminal' for consistency.
- **F4 — auto-revive guard.** Shared helper used after ANY control-action
  keystroke (send/inject/interrupt/answerQuestion): if the session's pane is
  dead afterwards, automatically perform the same recovery `kteam resume`
  does (reuse the resume code path in src/session-manager.ts — do not
  reimplement), single attempt, emit a `control.autorevive` event so the
  transcript shows it happened.
- **F5 — queued send.** `send` to a busy session currently throws
  "session is <status>; interrupt it before sending"
  (src/session-manager.ts:~425) — this refusal is what pushes operators to
  the destructive interrupt. Change default: persist the message under the
  session dir (e.g. channel/pending-sends.jsonl) and have the daemon's
  existing watcher loop deliver queued messages at the next genuine
  prompt-ready turn boundary (after turn end, before status transitions that
  would end the session). Add `--now` CLI flag for the old
  immediate-or-fail behavior. Delivery must go through the normal inject
  path (probe-verified), and each queued message must be delivered at most
  once (persist a delivered marker).

### Required tests

- interrupt on an idle pane sends no keystroke (F2).
- interrupt sends Escape not C-c (F1).
- pane showing only "background terminal running" + idle prompt =>
  promptReady true / paneShowsActiveWork false (F3).
- codex interrupted-banner screen => promptReady true (F3).
- control action that leaves a dead pane triggers exactly one auto-revive and
  emits control.autorevive (F4; fixture-level, mock the tmux runner).
- send on busy session queues; queued message delivered exactly once at next
  ready; `--now` preserves the old error (F5).
- Fix code to satisfy intent — do not weaken existing tests; update fixtures
  honestly if the heuristic change shifts expectations.

### Activation + verification after merge

1. Restart kteamd (sessions live in tmux and survive; daemon re-scans
   ~/.kteam state on start). Pick a moment with no strict proof mid-window.
2. Live check: on a scratch codex session with a background terminal open,
   verify (a) status can reach idle/promptReady, (b) `kteam interrupt` stops
   the turn WITHOUT killing the TUI, (c) a second interrupt is a no-op,
   (d) `kteam send` while busy queues and delivers at turn end.

## 2026-07-19 — RESOLUTIONS round 2 (claude-kirin main session; FIX SPEC F1–F5 + extras)

1. ✅ F1+F2 SAFE IDEMPOTENT INTERRUPT: interrupt() now sends Escape (never C-c — the
   codex quit path), only after checking pane state: no active-work evidence (idle, or
   the codex interrupted banner) ⇒ no keystroke, return success. Exactly one keystroke
   per call. (src/tmux-controller.ts)
2. ✅ F3 FALSE-BUSY FIX: 'background terminal running' removed from BUSY_BLOCKERS (codex
   shows it permanently while idle — it poisoned waitReady, inject turn-start proof, and
   interrupt gating). The codex "Conversation interrupted - tell the model what to do
   differently" banner now counts as promptReady. (src/tmux-controller.ts)
3. ✅ F4 AUTO-REVIVE: withAutoRevive() wraps interrupt/answer — a control action that
   leaves a dead pane emits `control.autorevive` and runs the normal resume path once
   (send already revives via its dead-pane delegation). (src/session-manager.ts)
4. ✅ F5 QUEUED SEND: send to a busy session appends to channel/pending-sends.jsonl and
   emits `control.send_queued`; the monitor delivers queued messages at the next genuine
   prompt-ready boundary through the normal probe-verified inject path (marked delivered
   BEFORE injection — at-most-once; combined into one turn; re-queued automatically if
   the session went busy again). `kteam send --now` restores immediate-or-fail. There is
   now a safe live-steer channel for busy sessions. (src/session-manager.ts, src/index.ts)
5. ✅ glm52b FALSE-FAILED (turn never started while canary succeeded on-screen): monitor
   tracks per-turn pane active-work evidence; a turn that visibly RAN but produced no
   correlated transcript skips the 120s reinject and 360s turn_never_started fail —
   that's a transcript-correlation gap, not a lost prompt. (src/session-manager.ts)
6. ✅ CODEX PreToolUse HOOK exit 1: root cause — `loctl` on Linux boxes is a wrapper
   pointing at a Mac-only source path ("Module not found ... /Users/erng/..."), so every
   hook invocation errored. Both kfleet hook templates now skip cleanly when loctl is
   absent/broken and preserve only exit 2 (real denial) as blocking.
   (kfleet/templates/codex/hooks.json, kfleet/templates/claude/settings.json)

Tests: 66 kteam-ts tests pass (spec-required F1–F5 tests added: idle-interrupt no-op,
Escape-not-C-c, background-terminal ready, interrupted-banner ready, single autorevive +
event, at-most-once queued delivery), tsc clean. Deployed: hms + kfleet apply + kteamd
restart. NOT yet done: the spec's live scratch-codex verification (interrupt mid-turn,
queued-send delivery on a real TUI) — run during the next real kteam session and log here.

## 2026-07-21 — babysitter note (NOT a kteam bug): background-sleep timing misread; corrected

**Session watched:** mru8rq2b-d4dd3081 (kristin, codex-auto-loio, kteam-ui review)

**What happened:** The babysitter initially logged "background `sleep` completes early" —
that diagnosis was WRONG and is corrected here. The background `sleep 120/180/240` jobs ran
their FULL duration; their outputs (read after the fact) show correct post-sleep state
(e.g. the 2-min job saw kristin already `completed` at 06:00+). Two things caused the
misread:

1. `run_in_background: true` does not block the babysitter's turn, so the babysitter kept
   polling inline in near-real-time while thinking it was "waiting between cycles" — the
   compressed `date -u` timestamps were the babysitter's own back-to-back inline checks,
   not broken sleeps.
2. Background-task completion notifications are only delivered at turn boundaries, so they
   all arrived AFTER the babysitting work finished; reading the output files mid-sleep
   returned empty files, which was mistaken for premature completion.

**Impact:** None on the watched session (kristin completed cleanly). Lesson for future
babysitters: for spaced monitoring cycles, use a FOREGROUND polling loop (`for i in ...;
do sleep 30; check; done` or `until <cond>; do sleep 10; done`) — a backgrounded sleep
does not pace your turn, and its notification may arrive much later. No kteam-ts code path
involved; nothing to fix in modules/kteam-ts.

## 2026-07-21 — kteam UX: `kteam daemon status` misleads reachability checks in non-systemd contexts

**Session:** mrv0xcjs-17341a08 (ashley, claude-auto-loge, kloop→kteam migration)

**Problem:** Inside a running kteamd session (or any context where kteamd was started by the
TUI harness rather than systemd), `kteam daemon status` reports "kteamd is stopped" (exit 1)
even though the HTTP API at 127.0.0.1:7337 is fully up and serving requests. This is because
`daemon status` interrogates the systemd service manager, not the actual API socket.

**Evidence:** Ashley's initial `daemonReachable()` used `kteam daemon status` exit code.
During smoke-test preflight, `kteam daemon status` returned "kteamd is stopped" / exit 1
while ashley was actively running as a kteam session (proving the API is up).

**Suspected code path:** `modules/kteam-ts/src/index.ts` — `daemonCommand.command('status')`
calls `daemon.status()` which checks the systemd unit, not an HTTP probe.

**Workaround (applied by ashley):** Changed `daemonReachable()` to use `kteam ps --json`
(exit 0 = API reachable, non-zero = daemon down) instead of `kteam daemon status`. Fixed in
`modules/kloop-ts/src/kteam.ts`.

**Suggested kteam fix:** `kteam daemon status` should probe the HTTP API (GET /status or
similar) and report "running" if it responds, regardless of whether systemd is involved.
The systemd unit-file check should be a separate flag or a secondary display.

---

## 2026-07-21 — lesson (NOT a kteam bug): commit backend work before launching teammates

During session mruyefig-29a6f557 (hailey, kteam-chat-ui) the babysitter found 6 modified
daemon src files in the working tree and briefly misattributed them to the teammate as a
guardrail violation. They were the lead's own uncommitted backend work (committed after
the fact as 5d95328). Lesson: the lead should commit (or stash) their own work BEFORE
launching teammates, so `git status` attribution of working-tree changes to the teammate
is unambiguous and guardrail checks stay trivial. No kteam-ts code path involved.

## 2026-07-21 — `kteam wait --json` emits multi-line JSON (integration gotcha, consumer-side)

**Problem:** kloop's new kteam-backed agent runner polled `kteam wait <id> --json`
and parsed the status with `waited.stdout.trim().split('\n').at(-1)`. `kteam wait
--json` prints `state` as **pretty-printed** (multi-line) JSON, so `.at(-1)` is the
lone `}` → `JSON.parse` throws → status never updates → kloop's poll loop never
sees `completed` and spins until the deadline (smoke run f7tmpiu4 hung ~19:44).

**Evidence:** babysitter caught the smoke run stuck re-polling; implementer kteam
session was `completed` while kloop still showed `running — impl`.

**Suspected code path:** consumer bug in `modules/kloop-ts/src/agents/runner.ts`
`launch()`, NOT kteamd. But worth recording: `kteam wait --json` (kteam-ts
`src/index.ts` prints `JSON.stringify(view.state, null, 2)`) is multi-line — any
consumer must parse the whole stdout, not the last line.

**Fix (kloop side):** parse the full stdout (`JSON.parse(waited.stdout.trim())`);
added a test whose fake `kteam` returns pretty-printed JSON so the regression can't
return. Verified: fresh smoke run 8ayooxsb → completed/consensus, out.txt=DONE.

## 2026-07-21 — teammate creates root-level package.json (guardrail violation + kteam CLI breakage)

**Session:** mruyefig-29a6f557 (hailey, claude-auto-mm3, kteam-chat-ui, fix-round turn 4)

**Problem:** Hailey needed to add `react-virtuoso` to `modules/kteam-ts/ui/`. Instead of
running `bun add react-virtuoso` from inside `ui/`, the session ran `bun add` at the
repo root. Bun created `/home/kirin/.config/home-manager/package.json` and
`/home/kirin/.config/home-manager/bun.lock`, and installed `react/react-dom/react-virtuoso`
into `/home/kirin/.config/home-manager/node_modules/`. These paths are OUTSIDE hailey's
allowed scope (`modules/kteam-ts/ui/`, `ui-dist/`, `.gitignore`).

**Collateral breakage:** The kteam binary (`/home/kirin/.nix-profile/bin/kteam`) runs
`bun run ~/.config/home-manager/modules/kteam-ts/src/index.ts`. Bun's package resolution
walks up from the source file; since `modules/kteam-ts/` has no `node_modules`, it found
the root `node_modules/` which only contained react/react-dom/react-virtuoso. `commander`
(required by kteam-ts) was absent → `kteam status` / `kteam snapshot` / all kteam CLI
commands threw "Cannot find package 'commander'" and were fully broken during the session.

**Evidence:** `kteam status mruyefig-29a6f557` → `error: Cannot find package 'commander'
from '.../modules/kteam-ts/src/index.ts'`. `ls /home/kirin/.config/home-manager/package.json`
confirmed the new file. `ls node_modules/` showed only react/react-dom/react-virtuoso/scheduler.

**Suspected code path:** Agent ran `bun add react-virtuoso` from the repo root CWD (not from
`ui/`). Bun initialized a package.json at the CWD when none existed. The kteam-ts binary
reads packages relative to the source path, not a bundled binary, so any ancestor package.json
that captures the resolution first can shadow the correct deps.

**Workaround (babysitter):** `rm -f package.json bun.lock && rm -rf node_modules/` at the
repo root. kteam CLI restored immediately. Hailey's `ui/` already listed `react-virtuoso`
in `ui/package.json` (the correct location), and `ui/node_modules/` had it installed, so
no functionality was lost.

**Suggested kteam fix / guardrail:** Document in the teammate prompt that `bun add` must
always be run from the package dir (pass an absolute path or `cd` first), never from the
repo root. Optionally add a babysitter check: if `package.json` appears at the repo root
mid-session, treat it as a guardrail violation and immediately clean it up.

## 2026-07-21 — transient "daemon unavailable" on kteam snapshot while daemon stayed up

**Session:** mrv5kamb-1888cad7 (geoffrey, claude-auto-loge, kauto-migration, turn 3)

**Problem:** A babysitter `kteam snapshot geoffrey` at ~22:19Z failed with
`kteam: kteam daemon is unavailable at http://127.0.0.1:7337 (The socket connection
was closed unexpectedly...); run "kteam daemon start"` — but the daemon process
(pid 2933989, `bun run modules/kteam-ts/src/daemon-entry.ts`) had been up since
20:49:46 and never restarted (verified via `ps -o lstart`). A `kteam status` retry
~60s later succeeded; the next `kteam snapshot` also succeeded. The geoffrey session
itself was unaffected (kept editing files throughout).

**Evidence:** snapshot error output captured at ~22:19Z; `ps -o pid,lstart,etime -p
2933989` → `STARTED Tue Jul 21 20:49:46 2026, ELAPSED 01:24:02` (spans the incident).
Possibly related: events.jsonl shows a mid-turn `session.resuming` (22:11:23Z) →
`session.resumed` (22:11:52Z) pair right after turn-003 was queued, while the previous
turn's tool stream was still emitting — the TUI/daemon connection appears to have been
re-established rather than the daemon restarting.

**Suspected code path:** the daemon's HTTP handler for `snapshot` (modules/kteam-ts,
daemon side) dropped/closed the socket mid-request — likely a long-running snapshot
capture (tmux capture-pane) racing a busy event loop, or a connection-reuse/keep-alive
close in the bun fetch client. The client (`src/` CLI fetch wrapper) reports any socket
close as "daemon unavailable", which is misleading when the daemon is alive.

**Workaround:** retry after ~60s — recovered on its own. No restart needed.

**Suggested kteam fix:** CLI should retry once on socket-close before declaring the
daemon unavailable, and distinguish "connection dropped mid-request" from "nothing
listening on the port" in the error message.

## 2026-07-21 22:20 — stale done marker across gated injection (false `completed` while new turn runs)

**Problem:** After `kteam send` to a busy auto session, the daemon clears markers and
bumps the turn at QUEUE time, but gated injection delivers the prompt only when the
pane goes idle. If the agent runs `kteam signal done` (for its previous work) inside
that gap, the done marker is written under the NEW turn number and never re-cleared at
delivery. `kteam status`/`kteam wait` then report `completed` + "done marker written"
for a turn the agent is actively working on.

**Evidence (session mrv5kamb-1888cad7, geoffrey/claude-auto-loge):**

- ~22:16Z: lead `kteam send` (turn-003) while agent was still finishing turn-2 checks;
  status flipped to `turn 3` immediately, injection gated (pane busy).
- 22:18:17Z: agent `kteam signal done` (meant for turn 2) → markers/done.json written.
- 22:18:19Z: `kteam wait`/`status` → `completed, turn 3, done marker written`.
- 22:18:36Z+: turn-003.md actually read by the agent; tool events (Read scratch.ts,
  Edits) continue at 22:18:49–22:19:02+ while status still says `completed`.

**Suspected code path (modules/kteam-ts/src/session-manager.ts):** `send()` clears
`['done','needs-help','process-exit']` markers and bumps `turn` before the gated
injection actually delivers (marker rm at ~line 655). `signal()` (~line 780-794)
writes `markers/done.json` unconditionally — no check that the queued turn's prompt
has been delivered. The monitor loop (~line 1123) treats marker presence as
completion of the CURRENT turn. The existing `doneDeferred` set (line 88) defers
done-markers while the pane is working, but doesn't cover the queued-undelivered-turn
window.

**Workaround (babysitter):** Don't trust `completed` right after a send. Cross-check
`markers/done.json` mtime against the turn's injection time (agent's Read of
`turns/turn-NNN.md` in events.jsonl) and confirm tool events have quiesced.

**Suggested kteam fix:** Re-clear (or turn-stamp) markers at injection-DELIVERY time,
or make `signal done` refuse/warn when a queued turn prompt exists that has not yet
been injected (marker would then attribute to the correct turn).

## 2026-07-22 — process note: babysitter misattribution (NOT a kteam bug, no teammate fault)

A babysitter watching the warden-build session (mindy, mrwcnn1u-c8b1979e) attributed
the LEAD's own post-review actions to the teammate: the ship commits (8dc1104,
e5a0aff) and the activation `kteam daemon restart` were performed by the lead after
mindy completed; mindy honored all constraints. Two erroneous entries logged here on
that basis were removed. Lesson for babysitters: when the lead operates on the same
repo/daemon during a watch, correlate actions by ACTOR evidence (session event logs,
commit authorship timing vs teammate transcript) before attributing; when unsure,
report "actor unknown". Secondary observation kept for the record: sessions whose
work is finished can be reclassified failed ("daemon restarted but the interactive
tmux session no longer exists") after a daemon restart — the maiden warden run is
observing how this class gets handled; refine the detector if it proves noisy.
