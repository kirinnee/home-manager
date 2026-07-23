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

## 2026-07-22 18:19Z — first live warden run (mrwepljs-1097553d / paige / claude-auto-glm52a)

### Observation: mindy NOT a false positive — confirmed mid-work, correctly resumed

**Problem observed:** The pre-run note for this warden watch predicted mindy
(mrwcnn1u-c8b1979e, label `kteam-warden-build`) was "completed before daemon restart"
and might be a false-positive reclassification. Evidence contradicts this.

**Evidence:** mindy's `state.json` showed `turn: 3, turnCompleted: false`. The
`summary.md` (turn-2 completion artifact) was present from turn 2 (written ~17:46Z),
but a turn 3 was explicitly started at 17:52Z with a separate `turn-003.md` containing
a FIX-FIRST review pass (P1 security items: scoped auth token enforcement, ancestry
recursion guard, auto-failover gate, migration atomicity with rollback). The session
was actively executing tool calls at 18:16Z (transcriptOffset grew from start-of-turn
to 3,301,452 bytes) when the daemon restart killed it at 18:17Z. Last snapshot showed
the agent mid-implementation of test helpers. No `REVIEW-warden.md` deliverable on
disk (which turn-3 was supposed to read). No done marker for turn 3.

**Conclusion:** The abandoned_wreckage classification was CORRECT for mindy — the session
was genuinely mid-work-in-turn-3. The completed-session-reclassified-as-failed pattern
does exist but did NOT fire here. The detector correctly omitted a done-marker or
turn-3 completion as the "finished" evidence, relying instead on `turnCompleted: false`.

**Suspected code path (if pattern does fire):** `modules/kteam-ts/src/warden-detect.ts`
— the `abandoned_wreckage` detector checks `turnCompleted` (which is set on signal
done). If a session signals done but the tmux pane then dies before the status
transitions to `completed`, the daemon restart marks the session `failed` but
`markers/done.json` still exists. Future detector versions should check for a done
marker before classifying `abandoned_wreckage`, to avoid resuming a session whose work
was already complete (would cause it to re-do turn N or start turn N+1 prematurely).

**Workaround for warden:** before resuming any `kteam-warden-build` or similar labeled
session, read `markers/` directory for `done.json` AND cross-check `turnCompleted` in
state.json. The warden paige did this correctly (read summary.md, turn-003.md, state).

### Observation: daemon restart flap (EADDRINUSE) — root cause of 4 anomalies

**Problem:** All 4 anomalies this sweep were caused by a single infra event: kteamd
entered a restart loop where multiple daemon processes tried to bind port 7337.

**Evidence:** `daemon.log` shows `error: Failed to start server. Is port 7337 in use?
… EADDRINUSE` and `kteamd is already running (pid …)` with distinct pids (309645,
315185, 320208, 3877570, 3896181). The restart killed the live tmux panes for jenny and
mindy (Claude sessions). The Codex sessions (pauline, callie) had a separate but
coincident failure: 90 s startup timeout at TUI banner (`promptReady=false, cursor=2:18`)
which may be caused by the overloaded event loop during the daemon flap.

**Suspected code path:** `modules/kteam-ts/src/daemon-entry.ts` launch guard /
`bin/kteamd` invocation. The pid file check or SIGTERM/SIGKILL on restart may race
when multiple processes fire concurrently (e.g., systemd restart policy + manual
trigger + warden watchdog). The EADDRINUSE is the symptom; the root cause is multiple
kteamd processes starting before the previous one fully exits.

**Workaround:** stabilize the daemon (single `pkill kteamd && sleep 2 && kteamd &`)
before launching more sessions. The warden correctly flagged this for human attention
and did NOT attempt to touch the daemon.

**Suggested fix:** daemon entry should acquire a file lock (or check and SIGKILL the
stale pid) rather than just read the pid file before starting.

### Observation: scoped warden token — enforcement confirmed wired, NOT stress-tested

**Evidence:** `launch.sh` for the warden session (mrwepljs-1097553d) sets
`KTEAM_TOKEN` to the value in `~/.kteam/daemon/warden.token`, which is distinct from
the admin token in `~/.kteam/daemon/token`. The `api-server.ts` `wardenScopeDenial`
function gates stop/remove/start/warden-route writes to 403. The warden made no
attempt to use any forbidden action, so the 403 path was NOT exercised in this run.

**Remaining gap:** The scoped token is correctly injected at launch time. However,
the warden agent can still read `~/.kteam/daemon/token` (the admin token file) from
disk if it chooses to, since file-system isolation is noted as out of scope in the
code comments (`api-server.ts`). A sufficiently adversarial or prompt-injected warden
could bypass the scope by reading the admin token directly. This is a known design
limitation documented in the source; the scoped token is an audit boundary, not a
hard OS-level sandbox.

**No action needed now** — the bounds held in practice. Log this as a known gap for
future hardening if warden prompts ever handle untrusted payloads from teammate output.

## 2026-07-22 — RESOLUTIONS: foundation hardening G1–G6 shipped

All open problem-log items closed in one hardening round (implemented by dana
mrwfjk1b-589deaf3/Fable 5, adversarially reviewed by weston mrwgiyl8-1cd021e6/terra
verdict FIX-FIRST, review fixes applied by the lead):

- **EADDRINUSE restart flap** → `daemon-boot.ts`: port is the single-instance lock
  (health-probe first, bind-with-retry ~30 s, pid file written only after bind).
  "Already running" exits 78 and the systemd unit sets RestartPreventExitStatus=78
  so Restart=always cannot flood against a healthy standalone daemon.
- **Transient socket-close / revive-send client timeouts** → root cause was
  Bun.serve's DEFAULT 10 s idleTimeout killing 30 s+ requests; now set explicitly.
- **Client retry double-delivery risk** → x-kteam-request-id idempotency:
  per-session LRU (with promotion) + shared in-flight promise so concurrent
  duplicate retries never re-apply (weston P1 fixed).
- **Done-marker blind spot** → markers now carry the turn they certify; boot
  reconciliation and the warden feed only honor a CURRENT-turn marker (stale or
  pre-upgrade markers fall through to failed — weston P1 fixed).
- **Codex 90 s startup banner timeout** → one pane relaunch (control.launch_retry)
  before the session fails.
- **Root package.json guardrail** → teammate contract rule 8: package-manager
  installs only inside the target package dir.

130 tests green, tsc clean. Warden false-positive class ("completed reclassified
failed after restart") is now structurally closed by the turn-scoped markers.

## 2026-07-22 19:27 — papercut: daemon cold-init outruns the CLI readiness window

**Problem:** `kteam daemon install`/`start` reported "kteamd did not become ready"
and `daemon status` showed "process exists, but API unavailable" — yet the daemon
came up healthy ~85 s after spawn. With 990 stored sessions, SessionManager.create
(recovery/reconciliation) runs BEFORE the bind, so the port stays closed for the
whole init while the CLI's wait window expires.

**Evidence:** pid 47453 spawned 19:27:30; /v1/health first answered 19:28:57
(sessions:990). No error in daemon.log — pure startup latency.

**Suspected code path:** `src/index.ts` waitForDaemon timeout vs
`src/daemon-entry.ts` init ordering (manager created before bind — intentional
since G1, the bind is the single-instance lock and must come after the probe).

**Workaround:** just re-check `kteam daemon status` after a minute.

**Suggested fix:** scale the CLI wait window (or poll until the pid dies), and/or
archive terminal sessions out of the hot store so init doesn't scan ~1000 dirs.

## 2026-07-22 ~19:56 — diene retest findings validated (post G1–G6 gaps)

External retest (`~/Workspace/atomi/diene/design/supervision/kteam-retest-2026-07-22.md`)
verified against journal/code/live state — its "still broken" list is REAL and was
never in G1–G6 scope:

- **Daemon restart still kills every pane** (top catastrophic mode). journalctl:
  restart 19:53:55; warden session jasmine (spawned 19:53:50) died mid-launch and
  failed — independent confirmation. tmux server lives in kteamd's systemd cgroup;
  stop kills the cgroup. Fix: KillMode=process or launch tmux outside the unit
  (systemd-run scope) — `tmux-controller.ts` + `daemon-service.ts`.
- **Boot ~80 s** confirmed twice (19:27 → 85 s, 19:53 → 79 s). Likely dominant
  cause: `~/.kteam/daemon/kteam.sqlite` is 1.5 GB + 317 MB WAL, full reimport at
  boot (`storage.ts` — retest names "event-store.ts", file does not exist; concept
  correct). Needs retention/pruning + incremental boot. Supersedes the earlier
  "scan of ~1000 session dirs" guess in the cold-init papercut entry.
- **codex-auto-loge unlaunchable**: same signature as pauline/callie
  (`promptReady=false, cursor=2:18` with a visibly ready composer). So the earlier
  "daemon flap" attribution was WRONG for loge — it is a deterministic readiness
  misclassification (loge flavor prints an extra service-tier warning line), and
  the G5 relaunch retry cannot help a deterministic misread. `tmux-controller.ts`
  promptReady/frame classification must learn this frame.
- Minor valid notes: no WatchdogSec on the unit; `kteam start --timeout` is a
  session KILL timer (killed a healthy 300 s forensics session), not a readiness
  wait — naming footgun.

Collateral: jasmine (kteam-warden, mrwi358q) failed due to the retest restart;
anomalies it was spawned for were purged canaries — no revive needed.

## 2026-07-22 ~20:36 — stall detector KILLS a healthy long-thinking Fable session (P1, new class)

Session mrwirdnf-9f80826f (melanie, claude-auto-loge, Fable 5 [1m], hardening round 2,
turn 1). Timeline from `~/.kteam/mrwirdnf-9f80826f/{events.jsonl,state.json,last-snapshot.txt}`:

- 20:20:18 last tool start (fixture capture for A5); harness then entered a LONG
  thinking stretch — pane spinner alive and animating the whole time ("Fixing A5 loge
  readiness… 23m 38s · almost done thinking"), terminal.frame events every ~5 s with
  CHANGING hashes and health=healthy up to 20:36:23.678.
- 20:36:23.816 `session.stalled` ("no durable transcript progress for 900s") — and the
  daemon then killed the pane: `session-manager.ts` ~1708–1726 marks stalled AND calls
  `stopTmuxWithEvidence(config, 'stalled')`. With default `retry.stalledAttempts: 0`
  there is no retry, and 'stalled' is in `terminalStatuses` (line 85) → session dead.
- The pane was the ONLY session on the default tmux server, so the server exited too.

Problem: "durable transcript progress" = chat.jsonl/transcript records only. Extended
thinking streams write NOTHING durable, so a model thinking >stallSeconds is
indistinguishable from a hang — and the daemon's response to "maybe stalled" is to
EXECUTE the pane it just captured as healthy, discarding an in-flight API turn (~24k
tokens down, 23 min of thinking). Frame-hash activity (spinner) was available as a
liveness signal and ignored.

Suspected code path: `session-manager.ts` stall branch (~1708: `Date.now() -
effectiveActivity >= stallSeconds*1000` → snapshot, stopTmux, terminal 'stalled').
`effectiveActivity` should incorporate pane/frame-hash activity or spinner detection,
or stall-on-thinking should nudge/wait instead of kill; at minimum stalledAttempts
default > 0 for auto sessions.

Secondary papercuts observed while diagnosing:

- `kteam snapshot` on a session whose pane/tmux server is gone prints EMPTY (or stale
  cached) output with rc=0 instead of an error — masks pane death.
- `kteam status` kept showing plain "stalled" with no hint the daemon itself killed
  the pane; only code reading revealed stopTmuxWithEvidence ran (no `session.*` kill
  event after seq 368 either — the stop is not journaled as its own event).

Workaround applied: `kteam resume mrwirdnf-9f80826f` with reorientation (worked; turn 2
running, prior work preserved via harness session resume). Advised the teammate to
interleave tool calls during long reasoning so durable progress exists.

Attribution note: NOT an OOM (cgroup oom_kill=0) and NOT the lead — daemon self-kill
per code path above.

## 2026-07-22 20:36 — P1: stall detector kills healthy long-thinking sessions

**Problem:** melanie (mrwirdnf-9f80826f, fable-5[1m]) was stall-stopped mid-turn while
VISIBLY working: final snapshot shows an active "Fixing A5 loge readiness… (23m 38s ·
almost done thinking)" spinner. The monitor's stall rule ("no durable transcript
progress for 900s") counts transcript bytes only; a long extended-thinking block emits
none, so a healthy session was executed at exactly 900 s. Deep irony: she was killed
while fixing the sibling readiness-misclassification bug (A5).

**Evidence:** state.json stalled/finishedAt 20:36:23; snapshots/…-final.txt shows the
live spinner + 11% context; last tool 20:20:18 (16 min gap = one thinking block).

**Suspected code path:** monitor loop stall branch in `session-manager.ts` — it does
not consult `paneShowsActiveWork()`/activity line before declaring a stall.

**Workaround:** revive-send (worked); teammate told to emit a cheap tool call every
~10 min during long reasoning until fixed.

**Fix (assigned to melanie as A6):** stall only when transcript is silent AND the pane
shows no active work across consecutive polls; spinner-frame fixture tests.

## 2026-07-23 — send() delivery holes: stranded queues, pane-based revive, silent dispositions

External investigation (donovan/lacey message losses) verified against source — all three
REAL:

1. **Stranded queue:** `deliverPendingSends` is called ONLY from the monitor's
   prompt-ready boundary (session-manager.ts:1632). Completion paths never drain or fail
   the queue; messages queued in a turn that ends by completing are lost silently in
   channel/pending-sends.jsonl.
2. **Pane-based revive:** send() revives only when the tmux pane is dead (:509-517).
   A COMPLETED session with a live idle pane (restart re-adoption, reconciled
   completion) skips revive AND the queue (idle prompt => promptReady=true) and
   direct-injects into an unmonitored pane: no queue record, no tracked turn.
3. **Silent success:** queued and injected-into-finished both return the normal view,
   CLI exit 0 — no delivered|queued|revived disposition for callers.

**Fix (dispatched to melanie):** flush-or-fail the pending queue on every terminal
transition (revive with it or emit a loud control.send_stranded + nonzero surface);
revive on STATUS (completed/stopped/failed) not pane liveness; send() returns an
explicit disposition surfaced by the CLI and API.
