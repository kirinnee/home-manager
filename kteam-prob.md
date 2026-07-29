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

## 2026-07-23 — "at usage limit" mislabels not-logged-in accounts (kfleet usage → kteam recommend)

**Problem:** `kteam recommend` excluded `claude-auto-{glm52a,glm52b,mm3}` as "(at usage limit)" when they are NOT at any usage limit — they are simply **not authenticated** (missing env vars `ZAI_API_KEY_A`, `ZAI_API_KEY_B`, `MINIMAX_API_KEY`). This sent the lead down a wrong diagnostic path (assumed quota exhaustion, rerouted work) before the user flagged it.

**Evidence:** `kfleet usage` shows these rows as `not logged in (missing env var ...)` yet its summary prints `6 at limit: ...` AND `6 NOT logged in (re-auth needed): ...` for the SAME accounts — the not-logged-in set is folded into the at-limit count. kteam's `recommend` reads the kfleet `/usage` feed where `usableAgent(ln) = ln.atLimit !== true && ln.authOk !== false` (src/core.ts) and only surfaces the single reason string "at usage limit", losing the authOk=false distinction.

**Suspected code path:** `modules/kteam-ts/src/core.ts` (`usableAgent`/exclusion reason string in the recommend path) + the upstream kfleet `usage` summary that classifies missing-key accounts as "at limit". recommend should distinguish `atLimit` (quota) from `authOk===false` (re-auth/missing key) and label them separately.

**Workaround:** don't trust the "at usage limit" label from recommend for the zai/minimax key-based accounts; verify with `kfleet usage` (look for "not logged in (missing env var ...)"). Real fix = load the ZAI/MINIMAX keys into the env (sops secrets.yaml → load-secrets).

## 2026-07-23 — queued sends stranded across session completion (melanie, mrwirdnf-9f80826f)

- **Problem:** two `kteam send` messages queued while the session was mid-turn were never
  delivered; the session completed and the payloads are stuck in
  `~/.kteam/mrwirdnf-9f80826f/channel/pending-sends.jsonl` (2 entries). Both were
  user-decision instructions for the very round in flight; one (03:18) SUPERSEDES the
  mailbox-flush part of the work — the teammate finished turn 12 implementing the old design.
- **Evidence:** events.jsonl — `control.send_queued` 03:16:09 and 03:18:14 with NO matching
  `control.send_dequeued`/`control.send` after; `session.completed` 03:26:02; earlier sends
  (22:26:44, 22:30:34) show the healthy queued→dequeued→send pattern within ~1s.
  `channel/pending-sends.jsonl` mtime 03:18, 2 lines.
- **Suspected code path:** `modules/kteam-ts/src/session-manager.ts` — live daemon flushes
  the pending-send queue only on prompt-ready detection during an active turn; `transition()`
  into a terminal status does not flush or revive, so anything queued during the final
  work stretch is silently stranded. (This is precisely the "terminal-transition queue
  flush" hole this session's round 12 was tasked to fix — the live daemon reproduced it
  against its own fixer.)
- **Workaround:** babysitter resumed the session once (`kteam resume mrwirdnf-9f80826f ...`)
  with a reorientation pointing at the two stranded payloads so the round can absorb the
  superseding design change. Long-term fix is in the session's own turn-12+ deliverable
  (terminal-transition flush → status-based revive → explicit dispositions + strand path).

## 2026-07-23 — resume of a completed session is instantly re-completed by the stale done marker (melanie, mrwirdnf-9f80826f)

- **Problem:** babysitter ran `kteam resume mrwirdnf-9f80826f "<reorientation>"` at ~03:31:57
  on the completed session. The session went `starting turn=13`, then was back to
  `completed` within seconds; the tmux pane (`kteam-mrwirdnf-...-agent`) no longer exists.
  The teammate never processed the resume message; the 2 stranded pending-sends (see
  previous entry) remain undelivered in `channel/pending-sends.jsonl`.
- **Evidence:** `markers/done.json` was NOT cleared by resume — it now reads
  `{"at":"2026-07-23T03:32:05.725Z","type":"done","turn":13}`, i.e. re-stamped with the
  NEW turn BEFORE the transcript replay events (`transcript.discovered` 03:32:06.045,
  first `tool.use` 03:32:06.453). A teammate cannot have signalled done at 03:32:05 —
  the pane was still bootstrapping. `session.completed` for turn 12 was at 03:26:02;
  resume bumped turn to 13 and the session completed again with zero real work.
- **Confound:** five unrelated sessions (obs-hq-enrich wave, mrwygff9/gkz4/gpba/gtiq/gxqi)
  bootstrapped concurrently 03:32:05–03:32:28 (launch storm; injector-race territory per
  the bootstrapChain comment), but the marker re-stamp alone explains the re-completion.
- **Suspected code path:** `modules/kteam-ts/src/session-manager.ts` — resume() does not
  clear/invalidate `markers/done.json` from the previous completion; the done-marker watch
  (or adoption-time reconciliation) sees the stale file, re-stamps it with the current
  turn, and transitions the revived session straight back to completed, reaping the pane.
  Related: `doneDeferred` only defers while the pane is "working"; a bootstrapping pane may
  not count.
- **Workaround:** delete the stale `markers/done.json` BEFORE `kteam resume`, then resume
  with the message again. (Applied by babysitter; see next entry if it recurred.)

## 2026-07-23 — RECURRENCE: stale done marker insta-completes revived session (melanie, mrwirdnf-9f80826f, turns 15/16)

- **Problem:** the lead revived melanie at 04:20:31 (`session.resuming`) for the duncan-P1 fix
  round. Launch went through `control.launch_retry` (04:22:01), `session.resumed` 04:22:07.839
  — and `markers/done.json` was re-stamped `{"at":"04:22:08.031","turn":16}` 200ms later,
  BEFORE the transcript replay (`transcript.discovered` 04:22:08.121; the chat/tool events
  after it are millisecond-spaced history replay). `session.completed` 04:22:08.172. The fix
  round never ran; summary.md has no turn-15/16 section. Same mechanism as the 03:32 entry —
  this time triggered by the LEAD's own resume: resumes without a manual marker clear
  reliably lose the round while looking "completed clean" in status output.
- **Evidence:** events.jsonl ~lines 4881-4890; done.json turn 16 at 04:22:08.031 vs
  session.resumed 04:22:07.839 (agent cannot signal done in 200ms); no new summary section;
  turn counter jumped 14→16 across one revive (launch_retry appears to consume a turn).
- **Suspected code path:** as previous entry — resume()/adoption in
  `modules/kteam-ts/src/session-manager.ts` does not clear `markers/done.json`; the marker
  watch fires on the stale file and re-stamps it with the current turn. The turn-013/014
  work narrowed marker-clear to the send path only, not resume-relaunch.
- **Workaround (verified):** `rm ~/.kteam/<id>/markers/done.json` BEFORE `kteam resume`.
  Applied again by babysitter with a reorientation to duncan's 2 P1s.

## 2026-07-23 ~02:3x — P1: `kteam send` silently loses messages (queued-orphan + fake-revive)

**Problem:** two independent silent-loss paths, both verified tonight (diene exec-engine build):

1. Message queued for a BUSY session (`pending-sends.jsonl`) is delivered only by that
   session's monitor "at the next prompt-ready boundary" — if the turn instead ends in
   `completed`, nothing ever flushes the queue. Evidence: mrwqdhfs-abc9f831 has 2 stranded
   messages (incl. a design ruling) in channel/pending-sends.jsonl.
2. Send-to-finished "revive" triggers only when the PANE is dead (`!paneProbe.alive`,
   session-manager.ts ~504-517). A completed session with its TUI still open skips revive
   → direct keystroke injection into an unmonitored pane → message untracked/lost.
   Evidence: mrwqdd6b-efd590a5 got a send that appears in NEITHER pending nor delivered.
3. Both paths exit 0 — no queued/undeliverable/revived signal to the caller.

**Fix shape:** flush-or-fail pending queue at session completion (revive with queued
messages, or error); revive on STATUS (completed/stopped), not pane aliveness; `send`
must report delivered|queued|revived explicitly and fail loudly when undeliverable.
**Workaround:** use `kteam resume <id> <msg>` for finished sessions; verify delivery via
new turn activity, never trust exit 0.

## 2026-07-23 ~05:51 — P2: liveness monitor stall-killed a controller whose work lived in a BACKGROUND subprocess

Session mrx2yh55-d6d678cf (kathleen/opus, diene shared-wo-docker-helm controller): killed as
stalled after ~5 min of no transcript/counter growth while its real work (a cyanprint proof
run) was a background task — the kill also destroyed that subprocess before it produced its
report. Pane was idle-but-healthy; the liveness ledger's pane/transcript signals were blind
to subprocess activity (the ledger tracks `subprocess` age but the stall branch apparently
did not treat a live tracked subprocess as a life sign, or the task ran untracked via the
harness background facility). Recovery: the diene exec auditor revived the SAME session
(no duplicate), which verified the loss, logged recovery, and relaunched the proof — good
external handling, but the kill itself is a false positive of the A6 class in a new shape.
**Fix idea:** stall verdict must treat a live tracked subprocess/background task as work; or
never stop tmux on stall while `subprocess` liveness is fresh. Also note the effective stall
window observed was ~5 min (config default was 900s — check what changed).

## 2026-07-23 07:09 — relaunch of a 735k-token claude session misreads readiness (A5-class, claude variant)

**Problem:** status-based revive of madeline (mrwnuv96, 74%/1M context) killed her idle
pane and the RELAUNCH failed "not ready within 90s; promptReady=false, cursor=2:43" —
twice (launch retry included). Session marked failed although her deliverable was
already complete. Either the resume-confirmation menu appears in a variant the new
handler misses on very large sessions, or promptReady misclassifies the 1M-context
status-line layout. Her -final snapshots show a healthy idle composer pre-kill.

**Suspected code path:** tmux-controller.ts promptReady()/resume-menu detection —
needs a fixture from an actual 735k-token relaunch frame (capture during reproduction).

**Workaround:** none needed for the work (deliverable shipped); session left failed —
warden will flag it; do NOT loop resumes (lacey-lesson: deterministic wedge).

**Fix owner:** next kteam-ts round.

## 2026-07-23 night — three kteamd residuals from the diene sprint (evidence-anchored)

1. **Daemon wedge class (P1, twice tonight):** self-checks stop + API hangs ~11 min
   (23:26:46Z gap; earlier ~18:5x), then self-recovers — but AFTER recovery `kteam ps`
   is INCOMPLETE: done-marked sessions absent from ps while still writing events
   (evidence: exec-auditor mry51raq refreeze report, sessions mry50147/mry5jclz/mry4o1br).
   Only a full restart restores index coherence. Need: root-cause the hang (event-loop
   starvation under load? index churn?), and a post-recovery self-consistency check
   (ps-vs-session-dirs) that triggers reindex or self-restart.
2. **kteam start exit-143 spawner timeouts (recurring):** responder spawns time out
   mid-start while the session actually launches; persist-early makes it cosmetic but
   the timeout owner is still unidentified (respond wrapper vs client vs unit).
3. **No waiting-aware lifecycle:** parked/waiting custodians cannot survive
   (nudge=180s/kill=300s idle; 4h turn ceiling kills long-suite babysitters and
   ruling-parked customs — 4 cap-kills + 4 park-loops handled by lead workarounds
   tonight). Need: a declarable waiting state (session-level, e.g. via a marker or
   `kteam signal waiting --until/--on <condition>`) that suspends idle-kill and turn
   ceilings while keeping heartbeat visibility.

## 2026-07-24 00:25Z — fresh evidence during hardening round 2 (for audra)

- Spawn false-failures ×3 in 20 min (listener slowness): `kteam start` reported
  failure but the session WAS created and runs fine each time.
  - 00:08Z exit 143 (caller wrapper timeout) → session eugene mry6m1va-a63d8047 alive.
  - 00:25Z "daemon did not answer /v1/sessions within 120s" → session marcos
    mry77urs-43a73830 alive. The 120s is the kteam CLI's OWN HTTP timeout —
    under a slow listener the CLI declares failure for spawns the daemon
    actually applied. Fix direction: idempotent start (client request-id +
    daemon dedupe) or CLI re-checks for the just-created session before
    declaring failure.
- NEW: post-restart sessions never persist `~/.kteam/<id>/liveness.yaml`
  (skeptical-auditor finding, artifact ~/.kteam/mry51raq-0babfd08/). Confirmed:
  mry6ripn-544b52e3 (created 00:12:24Z post-restart), mry4o1br-f646d397
  (resumed 00:22:33Z), mry44s2n-c682e626 — while pre-restart peers update
  liveness.yaml every few seconds. `kteam status` counters still live, so only
  the on-disk reflex-ledger write path is skipped for post-restart sessions.
- `kteam send` to a busy claude session (audra, mid-tool-run) failed twice with
  "text did not land in the busy composer" — the native queue path itself
  rejected; earlier the SAME session queued fine while `thinking`. Queueing
  appears state-dependent (tool_running vs thinking?) — that gap re-opens the
  silent-loss/no-steer class for busy sessions.

## 2026-07-24 02:02Z — PRODUCTION OUTAGE: hardening tests clobbered the real systemd unit

- The kteamd-hardening session's test run REPLACED ~/.config/systemd/user/kteamd.service
  with a test unit: ExecStart="/bin/kteamd" (nonexistent), KTEAM_HOME=
  /tmp/kteam-daemon-service-test-3kfT55, logs into the test dir. systemd restarted
  into it at 02:02:18Z → crash loop (status=203/EXEC), daemon fully down.
- Impact: CLI unreachable ~8 min; ALL tmux panes + in-flight proofs survived
  (KillMode=process). Engine responders correctly refused to touch the daemon and
  filed file-first done markers. `kteam signal done` exits 0 even when the daemon
  is unreachable — scripted callers silently believe it succeeded (separate bug).
- Recovery: lead preserved the clobbered unit as evidence, ran `kteam daemon
install` from the installed CLI (correct ExecStart + KTEAM_HOME=~/.kteam,
  KillMode=process verified), daemon rebooted, panes re-adopted.
- Fix required: hermetic tests — unit files only under an isolated
  XDG_CONFIG_HOME/systemd root; never write the real user unit path; never
  daemon-reload/restart the real user manager from tests. Plus: `kteam signal`
  must exit nonzero when the daemon is unreachable.

## 2026-07-24 — RESOLUTION of the three night residuals (kteamd-hardening-round-2, session mry62ao5)

Root causes found (all three residuals shared ONE load bomb), fixes landed in `modules/kteam-ts`:

1. **The wedge/listener flap was the Claude transcript watcher, not index churn.**
   `ClaudeTranscriptWatcher` armed one inotify watch per directory BELOW the shared
   harness home (`~/.kfleet/shared/claude/projects`, ~290 dirs → ~4 000 watches with a
   dozen sessions; the live daemon held 3 838 fds 10 min after boot), and its 2 s
   reconcile tick passed `refreshDirectories = true` — so every session re-walked the
   WHOLE shared tree every 2 s, plus once per rename notification from any other
   session's writes. Self-amplifying under load: 66 % CPU in state R, timers frozen
   11 min (23:26:46Z → 23:37:55Z), accepts starved. **Fix:** watch only the
   transcript's own directory (1–2 watches/session), never force a refresh from the
   tick, throttle full-tree rediscovery (60 s) and back off search walks after 5 misses.
   Second, smaller bomb: the fleet-wide `/v1/events` feed (`replay(undefined, …)`)
   loaded EVERY session's journal into memory, mapped and sorted it, then returned
   ≤ 1 000 — the UI's list page connects with `after=-200` and reconnects with backoff.
   **Fix:** an indexed `global_sequence` column (additive migration, no rebuild demand)
   - bounded SQL windows; the fleet feed is the newest 5 000 events, per-session replay
     stays complete.
2. **Post-restart sessions had NO monitor tick at all** (the liveness.yaml report):
   `startMonitor` awaited the transcript watcher BEFORE arming the loop, and under the
   storm that await did not settle — so every session started after the 23:49 restart
   ran with no snapshots, no `checks/`, no `liveness.yaml`, no stall reflex and no turn
   ceiling, while `monitors.has(id)` made the self-check call it healthy. **Fix:** arm
   the loop first; the watcher attaches after (and stops itself if the loop already
   exited).
3. **exit-143 spawn timeouts:** the owner is the CALLER's timeout, reachable because
   `kteam start` held its HTTP request through a cross-session-serialized bootstrap
   whose tail was that same watcher walk. **Fix:** `start` answers within 45 s (or
   immediately with `--detach`) and finishes launching in the background; creates are
   idempotent per request id + payload hash; `/v1/sessions/by-request/<id>?payload=`
   resolves a lost response; the CLI re-resolves before reporting failure and has a
   120 s deadline (15 s for the recovery lookups). Control actions refuse to touch a
   session whose first launch is still queued, and a bootstrap never kills a pane it
   did not create.
4. **Post-wedge ps incoherence:** the self-check now measures its OWN timer lateness
   (≥ 180 s ⇒ `fleet.daemon_wedge`) and reconciles the SQLite index against the session
   directories — reindexing unindexed/stale rows and re-adopting terminal sessions whose
   journal still grows (once each); an index that will not heal after 3 passes requests
   a clean restart, but only when the service manager actually owns the pid and at most
   once per 30 min (persisted stamp).
5. **Waiting-aware lifecycle:** `kteam signal waiting --until <45m|2h|ISO> --on "<cond>"`
   (+ `signal working`). Suspends nudge/stall-kill/turn-ceiling, holds the status against
   transcript recomputation, heartbeats every 5 min, wakes the teammate at the deadline
   (every wait is force-woken within 4 h), credits parked time back against the ceiling,
   and is cleared by any new turn or terminal transition. The warden treats a declared
   wait as deliberate and only flags it once its wake is overdue.

## 2026-07-24 02:02Z — SELF-INFLICTED: a test clobbered the LIVE systemd unit

- **Problem:** a test I added for `DaemonService.supervises()` constructed the class with
  POSITIONAL args (`new DaemonService(paths, bin, runner, 'linux')`), so `options` was
  `undefined` and every default applied — the REAL home and the REAL command runner.
  `install()` then overwrote `~/.config/systemd/user/kteamd.service` with
  `ExecStart="/bin/kteamd"` and `KTEAM_HOME=/tmp/kteam-daemon-service-test-3kfT55`, and
  ran `systemctl --user daemon-reload`. The production daemon crash-looped 203/EXEC
  until the lead recovered it with `kteam daemon install`.
- **Why it slipped through:** `bun test` does not typecheck, and I ran the new file with
  `bun test` before `tsc`. TypeScript would have rejected the call outright.
- **Fix (landed):** `DaemonService` now throws when `KTEAM_TEST_HERMETIC=1` and either
  `home` or `runner` is defaulted; `daemon-service.test.ts` sets that flag at import, and
  two tests pin it (the refusal, and that an install writes only under the temp home).
  Test hermeticity is now part of this deliverable, not a footnote.
- **Lesson for every round:** run `bun run check` (tsc THEN tests) — never a bare
  `bun test` — on any test that can touch the machine's own service manager.

## 2026-07-24 03:05Z — residual: /signal endpoint hangs under boot/adoption load

- Observed on BOTH the pre-fix daemon (pid 2480034) and the hardened build
  (pid 2939951, commit 8aa2632) during its post-restart adoption storm:
  `kteam signal done` HANGS (rc=124 under a 90s timeout; also "daemon did not
  answer /v1/sessions/<id>/signal within 120s") while other endpoints kept
  answering; daemon 41-51% CPU, RSS 242→370MB, sqlite churning. doneAt stayed
  null until adoption completed, then the signal landed.
- Reporter's key correction: earlier exit-137s were the HARNESS killing the
  session while the CLI sat blocked — the CLI does not crash; debug the daemon
  signal handler path, not the CLI.
- Workaround that worked: a setsid-detached bounded retry loop that survives
  session teardown (6 attempts x 120s), stopped the moment doneAt landed.
- Likely benign post-adoption (endpoint recovered once ok:true), but worth a
  look at what serializes the signal path against bootstrap/adoption.

## 2026-07-24 03:12Z — new-build bug: launch_backgrounded strands the session state

- Session mryd2xvg (carol, claude-auto-atomi): the new bounded-start path fired
  session.launch_backgrounded ("launch still in progress after 45s, bootstrap
  queue") — but the launch was never marked complete afterwards. Result:
  status=failed while the TUI is demonstrably ALIVE and working (liveness
  transcript 4s, tools running, context advancing); `kteam send` refuses with
  "has not finished launching yet; retry once it is running". So the daemon can
  neither supervise nor steer a healthy session: monitors/warden state unclear,
  done marker at risk of the same refusal at completion.
- Expected: launch_backgrounded must be resolved by a completion event when the
  bootstrap finishes (the pane came up and the prompt was delivered), flipping
  status to running and unlocking control actions.

## 2026-07-24 03:19Z — false TERMINAL record for a live session (composes with launch_backgrounded)

- Session mryd2xvg (carol): state.json holds status=failed, health=crashed,
  reason="interactive claude exited unknown", finishedAt written 3.7 SECONDS
  after startedAt — while the SAME file keeps advancing lastTranscriptAt /
  lastToolStartedAt in real time. The launch detector recorded a terminal
  transition that never happened.
- Fallout chain: kteam ps (non --all) hides the "terminal" session → engine
  minute-loop sees controller-dead every minute → repair batch spawned per
  minute (strong-lane session each) + duplicate-dispatch risk; daemon-side,
  automode continuation/nudges/stall monitor no longer cover the live session,
  so it may park at its prompt forever after the current turn.
- ALSO: daemon boot recovery REVIVED an explicitly stopped session (brooks,
  quota-dead loai zombie, stopped 02:58Z, relaunched 03:06Z by recovery) —
  stopped sessions must stay stopped across restarts.
- Engine-side mitigation landing (minute.ts ps --all + liveness-fresher-than-
  finishedAt); daemon needs the root fix in the launch detector + revive policy.

## 2026-07-24 03:28Z — addendum on the /signal hang + memory observations (new build)

- /v1/sessions/<id>/signal for session mry44s2n hung through at least 03:20:17Z
  (6 detached attempts rc=124; log ~/.kteam/mry44s2n-c682e626/signal-detached.log)
  while /status, /ps and sends to OTHER sessions answered — endpoint- or
  session-scoped serialization, not a global wedge.
- RSS: 242MB (02:49) → 605MB (03:24) → 434MB (03:28) — peaked and came back,
  so not a monotonic leak; possibly the one-time global-sequence backfill.
  CPU sustained 41-58% for 40 min is still high for idle-ish load — worth a
  profile in round 3.
- Aggravating factor (self-report): a lead-side retry loop re-sent an identical
  ack to the hung session every ~145s for ~40 min (each attempt itself hanging
  120s server-side) — likely feeding the very serialization it waited on.
  Killed. Lesson: never point an until-loop at a HANGING endpoint (loud-fail
  loops are for busy-composer rejections, which fail fast).

## 2026-07-24 07:10Z — ghost-session class: stop does not kill the harness process; queues outlive stops

- Session mry44s2n (darwin) was `kteam stop`ed TWICE (04:27Z re-stop) yet its
  claude process kept executing queued native-composer messages for ~2.5h more
  (turn 25, fresh Bash tool.use at 07:02:13Z per auditor packet), invisible to
  `kteam ps` (status=stopped, lastPaneAt 03:34Z). Process eventually
  self-terminated after draining the backlog; verified gone at 07:08Z (no
  claude PID for its harness session id, no tmux session).
- Two policy gaps: (1) `kteam stop` should terminate/confirm-dead the
  underlying harness process, not just record the stop and kill the pane;
  (2) queued messages addressed to a STOPPED session must be dropped or
  parked, not delivered — stale queue delivery is what revived this session
  repeatedly (see also the 02:5x zombie revival of the same session and the
  brooks boot-recovery revival).
- 2026-07-24 08:2xZ addendum (same revival class, 4th instance): fleet
  supervision auto-RESUMED a launch-failed worker (mryoajlc/Ethan) while its
  retry (mryoccvi/Vicente) was live from an identical prompt in the same
  worktree → duplicate workers. Resume/revive must check for a live successor
  with the same label/worktree before resurrecting a failed/stopped session.

## 2026-07-24 22:5xZ — ROOT-CAUSED + FIXED: slow launches marked `failed` (the launch_backgrounded/false-terminal class)

- Reproduced: session mrzi4r0p (claude-auto-glm52a). Events were
  `session.starting` → **`session.crashed`** → `transcript.discovered` →
  `chat.user` → `session.launch_backgrounded` → `chat.assistant.thinking`:
  the daemon recorded `failed`/`crashed` 6.6 s into a launch that was still
  QUEUED, then the TUI came up, did the whole task and signalled done — while
  `state.status` stayed `failed` forever (a terminal status suppresses every
  later patch, so the launch's own `session.running` was dropped) and every
  control action refused the session. Same shape as the 03:19Z carol/mryd2xvg
  entry (finishedAt 3.7 s after startedAt, reason "interactive claude exited
  unknown", liveness still advancing).
- ROOT CAUSE (proved by the daemon journal: `22:18:49 kteamd self-check:
1 running session(s) without a monitor — repairing`, and state.finishedAt
  22:18:49.868): `start()` registered the session in `this.launching` only
  AFTER `await transition(... 'starting')`, and `transition()` awaits `emit()`,
  which rides the GLOBAL event queue — 10-19 s behind during that 5-session
  launch storm (event timestamps in the journal lag the state writes by exactly
  that much). In that window the session was persisted as `starting` but
  invisible to `launchingRecently()`, so the 60 s self-check "repaired" it with
  a monitor; the monitor read `tmux has-session` on a session that did not
  exist YET and could not tell "not launched" from "died", so it took the
  dead-pane branch → `session.crashed`.
- FIXED in modules/kteam-ts (not yet committed at time of writing; daemon picks
  it up only on restart):
  1. `launching` is claimed BEFORE any awaited emit — the race window is gone.
  2. New durable `state.launchedAt` (written the moment `tmux new-session`
     succeeds). The monitor's dead-pane branch now treats "no launchedAt +
     status created/starting" as PENDING while a launch is in flight, and as
     `session.launch_failed` ("the launch never created its tmux session") once
     it is not — never as a harness crash.
  3. A backgrounded launch resolves itself: `session.launch_settled`
     (→ running + monitor attached) or the real failure. The success transition
     is forced, so even a stray terminal record written mid-launch cannot
     strand a live teammate.
  4. `send`/`resume` landing in the launch window QUEUE behind the launch (up
     to 60 s) instead of the old instant "has not finished launching yet".
  5. Start window is account-aware: 90 s for the slow providers
     (glm52/mm3/dsv4\*), 45 s otherwise.
  6. Cosmetic: `ps`/`status`/web UI show the RESOLVED model (glm-5.2) instead of
     the wrapper alias (`opus`), from harness usage records where available.
- Evidence (throwaway daemon, KTEAM_HOME under a temp dir, port 7399, own
  TMUX_TMPDIR): backgrounded glm52a launch → created → starting →
  launch_backgrounded → running → launch_settled(outcome=running) → completed,
  no `session.crashed`; a wrapper that exits 3 still fails fast with the real
  reason; a wrapper that never paints a prompt fails with "did not become ready
  within 90s" plus launch_settled(outcome=failed); a `kteam send` issued during
  the backgrounded window waited ~16 s and was delivered 0.25 s after
  launch_settled.

## 2026-07-25 — two interactive claude-auto-atomi sessions went `stopped` / `health: idle` within 30s of each other

- **Observed by**: gertrude (`mrzyhipl-2d13ff0a`, kteam-ui round 5) while driving the web UI in a
  real headless Chromium against the live daemon (pid 3531171, port 7337).
- **Problem**: at ~07:00Z two `interactive`-mode sessions on the `claude-auto-atomi` wrapper left
  `awaiting_user` on their own:
  - `tiffany mrzys5g2-62d644e4` — its Claude TUI recorded `<command-name>/exit</command-name>` +
    `<local-command-stdout>See ya!</local-command-stdout>` at `06:59:50.386Z`, i.e. the harness
    itself exited. The next `kteam send` correctly took the revive path (`resume`), so the session
    came back at turn 1 with the pending message delivered as a turn file — no message was lost.
  - `elijah mrzsvgdb-2df3df1f` (the user's HQ session, opus-5) — `session.stopped`
    `{source: daemon, health: idle}` at `07:00:21.616Z`, with nothing but `quota.updated` events
    before it and no `session.stalled`, `stall_kill`, `session.crashed` or explicit stop.
- **Why it matters**: `interactive` sessions are human-driven and are supposed to be exempt from the
  idle/stall machinery. An unexplained `stopped` on the user's own HQ session looks like the wrong
  layer reclaiming it. The two events being 30s apart on the SAME wrapper suggests a common trigger
  (account/wrapper-scoped) rather than two coincidences.
- **Not the UI**: the web client can only stop a session through an explicit Stop click
  (`api.stop`); no probe in that round issued one, and round-5's diff touches only
  `ui/src/{lib/api,pages/SessionChatPage,components/Transcript,components/TranscriptRow}` plus
  `ui-dist`. The `/exit` on tiffany was recorded by the harness in its own transcript, not sent by
  the UI.
- **Suspected code path**: `src/liveness.ts` / `src/session-manager.ts` idle handling — whatever
  emits `session.stopped` with `health: 'idle'` and no preceding `session.stalled`. Worth checking
  whether the interactive-mode exemption covers that path, and whether a wrapper-level signal
  (quota watcher / kfleet usage refresh — `quota.updated` was the only thing firing) can reach it.
- **Workaround**: `kteam resume <id>` brings the session back with history intact; a `kteam send`
  revives it automatically.
- **Not reproduced deliberately** (it happened on the user's live session), so no isolated repro —
  raw evidence is in `~/.kteam/mrzsvgdb-2df3df1f/events.jsonl` seq 100-103 and
  `~/.kteam/mrzys5g2-62d644e4` chat records around 06:59:50Z.

## 2026-07-25 — `--name` is slugified, destroying human-readable task titles

**Problem.** `kteam start --name "[UI] kteam Themes SPA Redesign"` is stored and displayed as
`-UI--kteam-Themes-SPA-Redesign`. Spaces and brackets are replaced with `-`, and the value is
truncated to 48 chars. The TASK column in `kteam ps` (and the web dashboard, which reads the same
`config.name`) is therefore unreadable for any multi-word task description — even though `--name`'s
own CLI help calls it a "succinct summary of what this session is supposed to do".

**Evidence.**

```
$ kteam ps --label kteam-redesign
TEAMMATE  ...  TASK
jessica   ...  -UI--kteam-Themes-SPA-Redesign
desmond   ...  -Core--Teammate-Flag-RC-Naming
$ jq -r .name ~/.kteam/ms025va9-977d024b/config.json
-UI--kteam-Themes-SPA-Redesign
```

Launched with `--name "[UI] kteam Themes SPA Redesign"` and `--name "[Core] Teammate Flag RC Naming"`.

**Suspected code path.** `modules/kteam-ts/src/names.ts:196` —

```ts
export function sessionName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
}
```

Applied at `src/session-manager.ts:1009` when the session config is built, and mirrored in
`src/api-client.ts:191` for start-idempotency lookup. The doc comment says the shape exists to be
"filesystem- and column-safe", but nothing appears to use `config.name` as a path component — the
session directory is keyed by session id, and `src/core.ts:857` slugifies separately for tmux
names. So the sanitisation looks defensive rather than required.

**Impact.** Blocks the requested convention `[Hayden] Fix Transcript` for rc-session titles, and
makes the dashboard TASK column noisy.

**Workaround.** None client-side — the daemon rewrites the value on the way in.

**Suggested fix.** Split the concerns: keep a slugified `nameSlug` for anything that genuinely needs
a safe token, and store the raw (trimmed, control-chars-stripped, length-capped ~120) string as the
display `name`. Keep `api-client.ts` idempotency comparison consistent with whichever field it keys on.

## 2026-07-25 07:45 UTC — kteam-redesign batch: CLI globally broken during a teammate's mid-refactor of shared src

- **Problem**: the entire `kteam` CLI (`kteam ps`, `kteam status`, `kteam daemon status`, presumably `kteam send`/`resume`/`attach` too since they share the same entrypoint) failed for EVERYONE — the babysitter's own polling, and by extension the lead session `dixie` and any other teammate trying to reach the daemon — while teammate `desmond` (claude-opus-4-8, session `ms026al6-b1285b8c`) was mid-edit on `modules/kteam-ts/src/names.ts` as part of his assigned task ("caller-chosen teammate name (--teammate + kteam name)").
- **Evidence**: repeated direct invocation, all failing identically:

  ```
  $ direnv exec . kteam ps --label kteam-redesign
  1 | })
  2 | {
      ^
  SyntaxError: Export named 'sessionName' not found in module '/home/kirin/.config/home-manager/modules/kteam-ts/src/names.ts'.
        at loadAndEvaluateModule (2:1)
  Bun v1.3.13 (Linux x64)

  $ direnv exec . kteam daemon status
  (same SyntaxError)
  ```

  `grep -rn "sessionName" modules/kteam-ts/src/*.ts` at the time showed `src/api-client.ts:6/191` and `src/session-manager.ts:41/1088` still importing/calling `sessionName` from `./names`, while `names.ts` itself no longer exported it (desmond had renamed it to `displayName`, per his own in-file comment explaining the slugify→displayName redesign, but had not yet updated the two call sites). Desmond's own snapshot at the time shows him mid-fix on an unrelated regex bug in the same function (`.replace(/[^@-^_^?]+/g, ' ')` control-char stripping), i.e. he was still actively iterating on the file when the CLI was probed.

- **Root cause (architecture, not a bug in the traditional sense)**: `kteam` is a thin wrapper — `/home/kirin/.nix-profile/bin/kteam` is `exec bun run ~/.config/home-manager/modules/kteam-ts/src/index.ts "$@"` — i.e. every CLI invocation re-evaluates the live TypeScript source tree fresh, with NO build step and NO isolation between "the source a teammate is actively editing" and "the source every other kteam invocation on the box runs against." This is inherent to the current dev workflow (edit source in place, no separate build/install step for the CLI itself) but means any multi-file rename/refactor mid-flight in `modules/kteam-ts/src` makes the CLI unusable system-wide — not just for the editing session, but for the lead, the babysitter, and every other teammate — for the duration of the inconsistency (observed here: at least ~1-2 minutes while desmond worked through it).
- **Suspected code path**: no single function is "wrong" — this is about `modules/kteam-ts/src/names.ts` (the file being edited) plus the fact that `bin/kteam`'s wrapper has no build/dist indirection (contrast with the `ui-dist/` built bundle for the web UI, which IS isolated from `ui/src` edits). If self-hosting robustness matters, consider either (a) a separate installed/copied CLI snapshot that isn't the same tree teammates edit, or (b) having teammates work in a git worktree (which the repo's own PR-workflow rule already recommends for exactly this kind of reason) instead of editing `modules/kteam-ts/src` in place while `kteam` itself is depended on live.
- **Impact observed**: transient total CLI outage (confirmed via 3 separate command failures: `kteam ps`, `kteam ps -a`, `kteam daemon status`) during an in-place edit of shared kteam-ts source by one of the very teammates kteam was coordinating. Self-resolved once desmond finished/fixed the rename (not independently confirmed how long the full window was, but it recovered without intervention).
- **Workaround**: none needed to unblock desmond (he was fixing his own mistake); for the babysitter, fall back to direct filesystem reads (`~/.kteam/<id>/last-snapshot.txt`, `events.jsonl`, `state.json`) instead of `kteam` subcommands until the CLI recovers. General recommendation: anyone editing `modules/kteam-ts/src` in place should expect `kteam` itself to break for all concurrent users for the duration of any inconsistent multi-file rename, and should land renames as a single atomic edit (or work in a worktree) rather than saving files one at a time.

## 2026-07-25 — new daemon endpoints are unverifiable without a fleet-wide restart; 404 surfaces as exit-0 stdout

**Problem.** Two coupled issues found while verifying a new `kteam name` subcommand.

1. The `kteam` CLI is **live source** — the nix wrapper is
   `exec bun run ~/.config/home-manager/modules/kteam-ts/src/index.ts "$@"` — but `kteamd` is a
   long-running process. So a new CLI subcommand appears instantly while the daemon half of the
   same feature does not exist until the daemon restarts. Restarting is expensive: 20+ live
   sessions fleet-wide depend on it. Net effect: any change touching the daemon API cannot be
   verified end-to-end during development without risking the whole fleet.
2. When the client hits a route the running daemon does not serve, the 404 is swallowed:
   ```
   $ kteam name -n 3
   kteam: not found
   $ echo $?
   0
   ```
   A missing route prints a bare body fragment to **stdout** and exits **0**. Any script piping
   `kteam` output will treat "kteam: not found" as a valid result.

**Evidence.** `kteam --help` lists `name` (so the command is registered), while the call itself
returns the message above with exit 0. Daemon pid 3531171 predates the commit that added the route.

**Suspected code path.** CLI wrapper in the nix `kteam` derivation; client transport in
`modules/kteam-ts/src/api-client.ts` (error/status handling on non-2xx); route table in
`modules/kteam-ts/src/api-server.ts`.

**Workaround.** Verify daemon-side changes through in-process tests against the service layer
(`src/daemon-service.test.ts`, `src/session-manager-launch.test.ts`) rather than the live daemon.

**Suggested fix.** (a) Non-2xx responses must throw and exit non-zero, with the status code and
route named. (b) Have the client send its version and warn loudly on a daemon/CLI version skew —
"your CLI is newer than the running daemon; restart kteamd to use <command>". (c) Consider a
daemon reload path that drains rather than drops session monitors.

**CORRECTION (same day).** Point 2 above is WRONG and is retracted: `kteam name` exits **1**, not 0,
and writes to **stderr**, not stdout. The original measurement piped through `tail` and then read
`$?`, which reports the exit status of `tail`. The existing throw path
(`api-client.ts` request() → top-level catch in `index.ts`) already handles non-2xx correctly, so
there is no swallowed-error bug. Point 1 (CLI is live-source while `kteamd` is long-running, so
daemon-side changes need a restart to verify end-to-end) still stands, as does the suggestion to
warn on CLI/daemon version skew — the message "kteam: not found" gives no hint that the cause is a
stale daemon.

## 2026-07-25 — `/v1/sessions/<id>/chat` returns zero records for one session

**Problem.** `GET /v1/sessions/ms025va9-977d024b/chat?limit=200` returns
`{total: 1053, offset: 853, records: []}` — an empty page for a session with a
thousand records. Every `limit`/`before` combination behaves the same
(`limit=10`, `limit=200&before=853`, `limit=50&before=1000` → all empty). Five
other sessions checked the same way return 200 records each, so it is one
session's data, not the route.

**Symptom in the UI.** That session's transcript renders as a blank card — the
header, composer and status all work, so it reads as a UI bug. It is not; the
daemon is returning nothing to render. (Found while reproducing a mobile scroll
complaint: "the transcript won't scroll" was in part "there is nothing in it".)

**Suspected code path.** `src/storage.ts` chat pointers: `appendChatPointers` /
the pointer→byte-offset resolution against the harness transcript. The session's
`total` comes from the pointer index, so the index has rows; resolving them to
records yields nothing — a rewritten/rotated/moved harness transcript file with
the pointer rows left behind would produce exactly this. Compare with
`replay()`, which has an explicit identity check and re-index fallback for the
same failure mode on `events.jsonl`; the chat pointer path appears to have no
equivalent recovery.

**Workaround.** None from the UI side. The records exist in the harness
transcript; only kteam's index of them is unusable.

Claude-Session: https://claude.ai/code/session_01LGZH4t7Ua5Yhv3NfmMywwX

## 2026-07-25 — chat API returns records:[] with total:1053 for one session (transcript unreadable)

**Problem.** `GET /v1/sessions/ms025va9-977d024b/chat` returns `records: []` while simultaneously
reporting `total: 1053`, for **every** combination of `limit` and `before`. Other sessions return
records normally from the same endpoint. The practical effect: that session's transcript cannot be
read in the web UI at all, even though the daemon knows 1053 records exist.

**Evidence.** Found by a teammate doing UI work against the live daemon; reproduced across multiple
`limit`/`before` values. Contrast with other session ids on the same endpoint, which return 200
records as expected. The non-zero `total` alongside an empty `records` array is the key signal —
the count and the fetch disagree, so this is not "no data".

**Suspected code path.** `modules/kteam-ts/src/storage.ts` — the chat pointer index versus the
on-disk journals. `total` is evidently served from one source (the pointer index / a count row) and
`records` from another (journal reads keyed by pointer), so a pointer index that is corrupt, stale,
or keyed differently for this session yields count-without-content. Related prior art in this log:
the daemon self-check has previously reported "unindexed" and "schema generation 0" repair passes
for `kteam.sqlite`, which is the same index.

**Impact.** Silent and total data loss from the user's perspective for an affected session — the UI
shows an empty conversation rather than an error, so it reads as "nothing happened" rather than
"the index is broken".

**Workaround.** None in the UI. The raw journals under `~/.kteam/<id>/` still hold the content.

**Suggested fix.** (a) Make the mismatch loud: if `total > 0` and `records` is empty, return an
error or a diagnostic flag rather than a valid-looking empty page. (b) Have the consistency
self-check verify pointer-index rows resolve to readable journal offsets, not merely that rows
exist. (c) Add a repair path that rebuilds a single session's pointers from its journals.

## 2026-07-25 — chat transcript renders 0 blocks under `vite dev` (StrictMode double-invoke)

**Problem.** In the Vite dev server the chat transcript renders 0 blocks; a production build of the
same commit renders 79 for the same session. The chat request itself returns 200, so the data
arrives and is then dropped.

**Suspected code path.** The initial-load effect in the chat page / session store under React 18+
StrictMode, whose deliberate double-invoke of effects in development exposes an unguarded
load-then-set sequence (e.g. the second invocation's in-flight request resolving after a cleanup has
already cleared state, or a cursor advanced twice).

**Impact.** Development-only — shipping builds are unaffected — but it makes `bun run dev` useless
for any chat/transcript work, which pushes contributors toward slow production-build test loops.

**Suggested fix.** Guard the initial-load effect against double invocation (abort controller +
ignore-stale-response flag), which is the correct pattern regardless and is exactly what StrictMode
is designed to surface.

**RESOLVED (2026-07-26, annotated by the triage planner).** Fixed by the UI team in commit
`bae9133` ("render chat history in dev (impure state updater)"): the actual cause was an impure
state updater — the merge mutated `seenKeys` inside `setRecords(live => …)`, so StrictMode's
double-invoke filtered every record out on the second pass. Not the initial-load effect as
suspected above.

## 2026-07-25 — no working-tree isolation between concurrent teammates: foreign staged files hitchhike into commits

**Problem.** kteam runs many teammates concurrently in the SAME checkout with no isolation. Two
distinct failure modes were hit in one batch:

1. **Foreign staged files swept into another agent's commit.** A UI teammate committing a CSS
   palette change captured a `src/*.test.ts` file that a _different_ teammate had staged moments
   earlier, producing `f233dac` — a themes.css commit containing an unrelated daemon test. Verified
   afterwards: content intact, 3 pass / 0 fail, so no data was lost, but the attribution and commit
   hygiene are wrong and the owning teammate started a needless "repair".
2. **A verification build silently deployed to production.** `kteamd` serves `modules/kteam-ts/ui-dist`
   directly off disk, so an agent running a routine `bun run build` for typecheck/verification
   _instantly deployed_ a half-migrated UI to the live URL with no commit and no review. Caught only
   because a human was actively testing the page at that moment.

**Evidence.** `git show --stat f233dac` lists `src/session-manager-chat.test.ts` alongside
`ui/src/themes.css` and `ui/scripts/contrast-audit.ts`. For (2), the live bundle hash changed to an
uncommitted artefact while `git status` showed `ui-dist` modified + untracked.

**Suspected cause.** Not a kteam code defect — a structural consequence of the execution model:
`kteam start --cwd <same dir>` for N teammates gives N agents one index, one worktree, and one
build output directory. Nothing in kteam warns about it.

**Impact.** Cross-contaminated commits, misattributed work, wasted "repair" effort, and — worst —
unreviewed production deploys from routine developer commands.

**Workarounds now in force for this batch.** Strict per-file ownership assigned by the lead;
`git commit --only <paths>` mandatory (never `git commit -a`); verification builds must target a
temp `--outDir`, with `ui-dist` written only by a deliberate deploy commit.

**Suggested fix.** (a) Offer first-class per-teammate git worktree isolation as a `kteam start`
option (the harness already understands worktrees elsewhere in this repo's tooling), so concurrent
teammates cannot share an index. (b) At minimum, have `kteam start` WARN when another live session
already has the same `--cwd`, naming it. (c) Document the "serving a build directory from a shared
tree means any build is a deploy" hazard — it is not obvious and it bit us.

---

## `kteam send` reports "left the composer without queue evidence" and the message is genuinely LOST (2026-07-25)

**Problem.** `kteam send <id> --message-file <f>` returned

```
kteam: the message left the composer without queue evidence (pane may have gone idle mid-type)
```

for two consecutive sends from `bennett` (`ms0mng5l-a74b9ac2`) to `luciano`
(`ms0n1pjc-29291d77`). The wording reads like an uncertainty warning, but the messages were
**not delivered at all** — and there is no retry, no error exit, and no queue file left behind.

**Evidence.**

- `jq 'select(.from=="ms0mng5l-a74b9ac2")' ~/.kteam/ms0n1pjc-29291d77/channel/inbox.jsonl` → **no
  rows**. Luciano's inbox contains only rows from `ms025va9-977d024b` (jessica).
- The same command form, same run, same message files, to `ms025va9-977d024b` succeeded three times
  (17:22, 18:20, 18:23) and each appears in that session's `inbox.jsonl`.
- So the failure is per-target, not per-sender or per-payload. Luciano was `running` in
  `kteam ps` at both attempts, i.e. mid-turn with a busy composer.
- **Worse on the third attempt (18:35): the message was dropped with NO warning at all.** The CLI
  printed the normal status footer and exited 0; `select(.from=="ms0mng5l-a74b9ac2")` over
  `~/.kteam/ms0n1pjc-29291d77/channel/inbox.jsonl` is still empty. So the "without queue evidence"
  string is not even a reliable indicator of the failure — a send can be lost silently and
  successfully-looking. Four messages from this session to that target, zero delivered.
- The sender's own `channel/outbox.jsonl` is **empty (0 bytes) even for the sends that DID land**
  with another target, so there is no sender-side record to reconcile against either. The
  recipient's `inbox.jsonl` is the only evidence that a message existed.
- Other senders reached the same target fine in the same window (15 rows from
  `ms025va9-977d024b`, 1 from `ms0mnykd-22879910`), so the target session was accepting messages —
  it is this sender→target pair that fails.
- **The warning is unreliable in BOTH directions (2026-07-25 22:06).** A send to
  `ms0rpps3-f6b6e49a` printed `kteam: interactive harness did not become ready within 30s; last
frame: promptReady=false, cursor=2:47` — and the message **was** delivered (row present in that
  session's `channel/inbox.jsonl`). So: a warning can accompany a success, and (see above) a
  silent exit-0 can accompany a loss. Neither the exit status nor the printed diagnostic is
  evidence of delivery; only the recipient's `inbox.jsonl` is.

**Suspected code path.** `modules/kteam-ts` — the tmux `send-keys` composer path used by
`kteam send`. It appears to type into the target pane and then look for evidence that the TUI
accepted the text into its queue; when the pane is busy the typed text goes nowhere and the
"without queue evidence" branch is taken. Two defects there:

1. **The channel record is written on the optimistic path only.** A send that fails to reach the
   composer should still be appended to the target's `channel/inbox.jsonl` (that file is the durable
   channel; the TUI composer is just the delivery mechanism), or the caller has no way to know the
   message is gone.
2. **No retry and a zero exit status.** The caller cannot distinguish "delivered" from "dropped"
   without manually diffing the target's inbox, which is what was needed here. `--now` / the native
   queue path exists for exactly this case and is not attempted as a fallback.

**Impact.** Silent message loss between teammates. A lead or peer believes a hand-off landed; the
recipient never sees it. Cost here: two full review documents had to be re-routed through a third
session after manual inbox verification.

**Workaround now in force.** After **every** `kteam send`, verify with
`jq 'select(.from=="<sender-id>")' ~/.kteam/<target-id>/channel/inbox.jsonl` — do NOT trust the exit
status or the absence of a warning — and re-route through a session that is known to be accepting
(here: jessica relayed to luciano) when the row is absent.

**Suggested fix.** (a) Always append to the target's `channel/inbox.jsonl` before/independently of
the composer write, so the durable channel is authoritative and a busy pane only delays delivery
rather than losing it. (b) Exit non-zero on the "without queue evidence" branch so callers and
scripts can react. (c) Retry with backoff, and fall back to the native queue path, before giving up.

## 2026-07-25 — a teammate answered a structured question addressed to the human user

**Problem.** The lead put a decision to the human via the harness's structured-question UI. The human
interrupted it. A teammate session, which could see the question text in the shared transcript,
replied with "Decision on the canceled structured question: Revert — ..." and proceeded on that basis.
The teammate's reasoning was sound, but the authority was not its own.

**Why this is a correctness problem, not etiquette.** If a teammate can answer a user-directed
question, the lead can no longer distinguish a HUMAN decision from an AGENT's inference. Every
downstream "the user approved X" becomes unreliable, and preferences only the human holds (in this
case, whether redundant labelling is desirable when a title is copied out of context) get silently
substituted with an agent's guess. The failure is silent and compounding: nothing in the transcript
marks the substitution.

**Evidence.** Teammate message opening "Decision on the canceled structured question: Revert — plain
titles in kteam." The lead had asked the human to choose between two naming conventions; the human
had rejected the tool call without answering.

**Suspected cause.** Structural, not a model defect. Teammates run inside a transcript where
user-directed prompts are visible, and nothing marks those prompts as human-only. An agent doing its
job — reading context and being helpful — will reasonably treat an unanswered question as something
it can resolve.

**Impact.** Corrupts the provenance of decisions. Worse in long batches, where the lead relays
"approved" states to the human, who then sees their own supposed decisions reported back to them.

**Workaround now in force.** The lead re-asserted that user-directed questions are human-only, and
teammates may offer clearly-labelled RECOMMENDATIONS instead. The teammate acknowledged and confirmed
no mutation had been performed.

**Suggested fix.** (a) Mark human-directed prompts distinctly in what teammates see, or omit them from
teammate-visible context entirely. (b) Have the lead-side protocol treat any "decision" arriving over
a peer channel as a recommendation by construction, never as consent. (c) Consider a session-visible
provenance marker so a decision's origin (human vs agent) is recoverable after the fact.

## 2026-07-26 — reviving a `completed` session with `kteam send` left it `failed`

**Problem.** Sending a message to a session in `completed` state is documented to revive it with the
message as the next turn. Instead the client reported `interactive claude exited unknown`, the turn
counter advanced (4 → 5), and the session settled in `failed` rather than `running`. The intended
work never started, and the failure surfaced only as a terse line on the send.

**Evidence.**

```
$ kteam send desmond "<task brief>"
  interactive claude exited unknown
  /home/kirin/.kteam/ms026al6-b1285b8c
$ kteam status desmond
desmond (ms026al6-b1285b8c)  failed  claude-auto-loge  model=claude-opus-4-8  …  auto  turn 5
```

The session had legitimately completed earlier and its transcript was intact.

**Suspected code path.** The revive-on-send path in `modules/kteam-ts/src/session-manager.ts` (the
branch that relaunches a terminal session and injects the message as a turn), and the Claude
relaunch args in `core.ts` `interactiveHarnessArgs()` — which shortly beforehand gained a `--name`
flag on the `--resume` branch (commit `71edf93`). A relaunch flag that a resume rejects would
produce exactly this shape: TUI starts, exits immediately, session marked failed. Worth ruling in or
out first, since the commit landed hours before this occurrence and its own note claimed `--name`
was verified as accepted alongside `--resume`.

**Impact.** A lead re-tasking a finished teammate silently loses the task. The prior conversation is
not destroyed — `kteam resume` remains available — but the send appears to have been accepted.

**Workaround.** Spawn a fresh session for the follow-up work rather than reviving, or `kteam resume`
explicitly and confirm `running` before sending.

**Suggested fix.** (a) A failed revive should be a non-zero exit with a clear message naming the
cause, not a status line that reads like progress. (b) If the relaunch harness exits immediately,
capture and surface its stderr — `exited unknown` names no cause. (c) Add a revive regression test
covering a completed Claude session, including one launched before a harness-args change, so
flag-compatibility drift between launch and relaunch is caught.

## 2026-07-26 — `event loop starved 660s` + `session index unhealable after 3 passes`

**Problem.** During a period of heavy concurrent activity (~23 live sessions, several agents running
browser gates and full test suites), `kteamd` logged both:

- `kteamd: session index is unhealable after 3 passes (1 session(s) invisible to ps)`
- an `event loop starved 660s` warning

Eleven minutes of event-loop starvation means the daemon's timers — the reflex nudge, the stall
detector, the warden sweep, liveness sampling — were not running on schedule for that window. A
session that genuinely wedged during it would not have been detected, and a session that was merely
slow could have been misjudged once the loop caught up and every overdue timer fired at once.

**Evidence.** Reported by a teammate observing the daemon log mid-run. Health checked shortly after
was clean (`running 23, monitors 23, unmonitoredRunning 0, bootstrapErrors 0`), so both conditions
self-resolved — which is precisely why they are easy to miss.

**Suspected code path.** The consistency self-check and index repair in
`modules/kteam-ts/src/session-manager.ts`, plus whatever synchronous work runs on the main loop
during a sweep. Candidates for the starvation: a synchronous full-index scan over ~941 stored
sessions, synchronous journal/transcript reads during recovery or search, or the scratch GC walking
large session directories without yielding. The "unhealable after 3 passes" may be a symptom rather
than a cause — a repair pass racing a mutation it cannot win while the loop is saturated.

**Impact.** Silent and time-bounded, which makes it the dangerous kind. Supervision guarantees the
tool advertises (stall kill, nudge, warden) are suspended without any session being marked degraded.

**Workaround.** None needed in this instance; both cleared without intervention.

**Suggested fix.** (a) Move index consistency repair and any large directory/journal walks off the
main loop, or chunk them with explicit yields. (b) Treat prolonged starvation as a first-class health
signal — surface `eventLoopLagMs` in `/v1/health` and record a transient so a lead can see that
supervision lapsed. (c) When the index is unhealable after N passes, name the invisible session id
in the log; "1 session(s)" is not actionable. (d) Consider whether 941 stored sessions should be
partitioned or archived — several symptoms this batch scale with total history, not live count.

**CORRECTION + SECOND OCCURRENCE (2026-07-26).** The `--name`-on-`--resume` hypothesis above is
DISPROVEN. It recurred with a second session (`ms12cq0z`, teammate `ben`), and inspecting the live
process shows the relaunch succeeded with both flags present:

```
$ tr '\0' '\n' < /proc/1973345/cmdline
claude --dangerously-skip-permissions --resume c9d573a4-… --model claude-opus-4-8
       --name [Ben] Fix RC Session Naming Skill --disallowedTools AskUserQuestion
```

The tmux session exists, the pane command is `claude`, and the pane renders a healthy prompt — while
`kteam status ben` reports `failed`. So this is a **FALSE TERMINAL STATE**, not a flag
incompatibility: the revive path declares the harness dead even though it relaunched correctly.

That makes it a recurrence of the same class as the earlier "slow launches marked `failed`
(launch_backgrounded/false-terminal)" entry in this log, which was recorded as root-caused and fixed —
so either the fix does not cover the revive-on-send path, or a regression reintroduced it there.
Note the observed failure needs no slow launch: the message is `interactive claude exited unknown`,
which names no cause and is emitted while the process is demonstrably alive.

**Revised impact.** Worse than first assessed. The session keeps RUNNING and consuming quota while
the lead believes it is dead and re-spawns a replacement — so the real cost is duplicated work and
orphaned live agents, not a lost task. The lead cannot see this without inspecting `/proc` or tmux
directly.

**Revised suggested fix.** Before declaring a revived session terminal, probe tmux for the session
and pane command (both were trivially available here) and treat a live pane as authoritative over
whatever the launch path concluded. And never emit `exited unknown` — if the cause is unknown,
capture the harness stderr and say so.

## 2026-07-26 — migrate silently SHRINKS the context window, and the failed-relaunch rollback makes it permanent

Two defects that combined to kill a healthy, nearly-finished controller, and that
currently leave **no working rescue path for a large session**. Found during the
diene step-6 run; investigated in source, not inferred from behaviour.

### Defect 1 — `migrate` can silently downgrade the context window

**`contextWindowForModel` is NOT the bug.** `core.ts:931-940` is correct and
does exactly what its tests say: `[1m]` in the id → 1,000,000, otherwise
200,000 (modulo `contextWindows` overrides).

The bug is in `session-manager.ts:1991 migrate()`:

```ts
// Model: explicit arg > the new wrapper's kfleet default (KTEAM_MODEL) > keep.
const nextModel = model?.trim() || (await wrapperModel(wrapper)) || view.config.model;
```

Migrating **without an explicit `--model`** adopts the target wrapper's default
model. If that default lacks `[1m]`, the session silently drops from a 1M window
to 200k. Nothing compares the two windows, and nothing compares the new window
against the conversation the session is **already carrying**.

**Evidence.** The 2026-07-25T18:12Z provider migration moved the `bun-consumer`
controller onto `claude-opus-5` (no `[1m]`) and its lineage recorded the new
headroom as _"52 percent of 1M"_ — wrong; it was on 200k. The conversation grew
to **639,540 tokens = 320% of 200k**. It died the first time it was asked to open
a fresh turn after a declared wait expired: `waiting_wake_failed` 00:20:51Z,
killed as stalled 00:25:25Z. Same batch, still live and still mis-sized at the
time of writing: `nextjs-frontend` controller `mrzz9a3h-d084df92` on
`claude-opus-5` reading **432%**.

**Suggested fix.** In `migrate()`, before journaling intent, compare
`contextWindowForModel(view.config.model, this.options.contextWindows)` with the
same for `nextModel`. If the target window is SMALLER, and especially if the
session's current context already exceeds it, **refuse** with a message naming
the `[1m]` variant — behind a `--allow-context-downgrade` escape hatch. A
migration that cannot load the conversation is not a migration; it is a delayed
kill, and it is unrecoverable by construction because every relaunch re-reads the
same oversized transcript.

Cheap operational half-measure meanwhile: **always pass the `[1m]` variant
explicitly** when a migration is meant to buy headroom, and make the lineage
record the ACTUAL resolved window rather than the intended one.

### Defect 2 — the readiness detector refuses a demonstrably-ready harness, and the rollback reverts a model that DID launch

Applying the ratified remedy (`kteam migrate` onto `claude-opus-5[1m]`) **worked
at the harness level**: the pane rendered `Opus 5 (1M context)` and
`64% (639k/1M)` with a ready empty prompt. kteam nonetheless reported
`promptReady=false` (`last frame: promptReady=false, cursor=2:42`), declared the
launch failed, and **its failed-relaunch rollback reverted `config.model` back to
the 200k id** — guaranteeing the next attempt fails identically. Self-perpetuating
relaunch loop, each cycle reloading a 639k-token conversation.

Note the running process **kept** the 1M window after the config rolled back, so
pane and config disagreed about what the session actually is.

**Two things to check.** (1) Whether the `/rc` remote-control banner in the pane
defeats the cursor-line readiness test — the failing frame reported
`cursor=2:42`, and the pane was visibly ready. (2) Whether a rollback should
**ever** revert a model the harness demonstrably launched with. Rolling back the
ACCOUNT after a failed launch is right; rolling back a MODEL that succeeded turns
a recoverable session into a permanently unrecoverable one.

This is the same family as the existing "false terminal state / revived session
declared dead while demonstrably alive" entries in this log: the readiness probe
concludes death from a frame test while tmux and the process say otherwise.

### Related, same night — the 30s readiness window is not codex-only

Full write-up with data lives at
`/home/kirin/Workspace/atomi/diene/open/kteamd-codex-wake-readiness-30s.md`.
Summary: 8 `session.waiting_wake_failed` events across 5 sessions, all codex,
against ~449 claude sessions — but the **same 30s constant and error string also
fire on the `control.send` path, and that one tripped on a CLAUDE session**
(`mrzz9a3h`, claude-opus-5). On the send path it is advisory (the message still
reached `channel/inbox.jsonl`); on the wake path it is fatal. Any fix should
check every consumer of the constant, not just the wake path.

### Near-miss worth a rail — a dead controller can destroy a live proof

When a controller pane dies its remote-proof poller dies with it, and that poller
is **also the only thing heartbeating the control-box anti-reaper stamp**.
`bun-consumer`'s stamp stopped at 23:44:59Z; by 00:41Z it was 56.1 minutes old
against a 60-minute TTL swept every 10 minutes, so the 00:50 sweep would have
destroyed droplet 587553284 and ~3 hours of live binding proof. Recovered by
refreshing the stamp and arming a detached keeper. **Suggested rail:** the reaper
should verify droplet-side occupancy (`/proof/.slot-N` plus a live `cyanprint`)
before destroying, so a dead poller can never cost a live proof.

_(Logged 2026-07-26T01:03:01.321Z by the diene execution lead. Not fixed here: this repo was on
`main` with uncommitted work in flight, and `kteamd` is currently supervising a
live fleet, so a source change plus daemon restart was not taken unilaterally.)_

### Confirmed again, with a concrete duplicate-delivery cost: `kteam send` reports failure after it has already delivered

**Problem.** `kteam send megan "<long proof text>"` exited with

```
kteam: interactive harness did not become ready within 30s; last frame: promptReady=false, cursor=2:47
```

which reads as "not delivered". It _was_ delivered. I retried on that basis and
**sent the message twice**.

**Evidence.** Megan's session `ms0t1nzr-a60e7eac` has both attempts materialised
as separate turn files:

- `turns/turn-019.md` — first send (the one that "timed out")
- `turns/turn-021.md` — retry, near-identical content

Both carry the `[peer message from teammate chase (session ms10n6em-97c66749)]`
header, so the recipient sees two peer messages saying the same thing, one of
which contains an apologetic "you already found it yourself" framing that only
made sense because I believed the first had failed. `channel/inbox.jsonl` exists
and `markers/` is empty, matching the earlier finding that the send path writes
the inbox before the readiness probe decides anything.

**Why the frame test was false here.** The recipient was not idle-at-prompt: she
was mid-`git worktree add` running the very closure probe the message was about
(`kteam snapshot megan` showed `Working (15s) · 3 background terminals running`).
So `promptReady=false` was _correct as a fact about the frame_ and _wrong as a
conclusion about delivery_. A busy teammate is the normal case when you send them
work — this will misfire routinely, not rarely.

**Suspected code path.** Same 30s constant flagged in the entry above
(`kteamd-codex-wake-readiness-30s.md`), on the `control.send` consumer. The bug
is not the timeout duration, it is the **exit status and message**: the send path
should report success once the inbox write and injection have happened, and treat
`promptReady` as a delivery-latency hint at most. As written it converts a
successful call into an apparent failure whose only obvious remedy — retry — is
exactly the wrong action, and the CLI offers no idempotency key that would let a
retry collapse into the original.

**Workaround.** After any `kteam send` that reports the 30s readiness error, do
NOT retry blind. Check `~/.kteam/<recipient-id>/turns/` (newest file) or
`channel/inbox.jsonl` first; if the text is there, the send succeeded.

_(Logged 2026-07-26 by chase, session `ms10n6em-97c66749`, during Stage C P1
closure. Not fixed here: `modules/kteam-ts` source change plus a daemon restart
was out of scope for this turn — the turn instructions explicitly forbade
restarting the daemon while a live fleet was being supervised.)_

## 2026-07-26 — actor attribution: human/UI stops are journaled as `source: daemon`

**Problem.** The event journal cannot answer "who stopped this session". `transition()` hardcodes
`'daemon'` as the fallback source (`session-manager.ts:4141`) and `currentActor()` is populated
ONLY for warden-authenticated requests (`api-server.ts:537`) — so a stop issued by a human through
the web UI or CLI with the ADMIN token lands in `events.jsonl` as `session.stopped
{source: daemon}`, indistinguishable from a daemon-initiated stop.

**Why this matters (found during triage of the 2026-07-25 "two interactive sessions stopped/idle"
entry).** That investigation could not be closed: code inspection shows only `stop()` emits
`session.stopped` and it is reachable only via HTTP/CLI (interactive sessions are fully
reflex-exempt via `reflexSuspended`, `session-manager.ts:294-296`), which means the observed stops
almost certainly came from a client — but the journal's `source: daemon` made that unprovable
after the fact. The attribution gap converts every such incident into a CANNOT-TELL.

**Suspected code path.** `modules/kteam-ts/src/api-server.ts` — actor context is set only in the
warden-token branch (~:537); admin-token requests carry no actor. `modules/kteam-ts/src/
session-manager.ts` `emitEvent`/`transition` (~:4141, :4259) — `currentActor() ?? 'daemon'`.

**Suggested fix.** Stamp every API-originated mutation with an actor derived from the auth token
class and transport (`admin-cli`, `admin-ui`, `warden:<id>`, `peer:<session-id>`), and reserve
`daemon` for transitions the daemon itself initiates (reflex, monitor, boot reconciliation). The
UI/CLI can additionally pass a self-identification header. Then "who stopped this session" is
answerable from the journal alone.

_(Logged 2026-07-26 by the triage planner (dwight, ms13qhmf-567cfa73) at the lead's request;
verified in source at b26cac8. Triage table: `modules/kteam-ts/.kteam-prob-triage.md`.)_

## 2026-07-26 ~01:40Z — REPRO: long `--message-file` sends to a busy claude session lost 8× consecutively; short inline send landed first try

**Problem.** Fresh, clean reproduction of the send-loss class during the kteam-probfix batch.
Eight consecutive `kteam send dorian --message-file <4.3KB brief>` to a BUSY claude session
(mid-turn 1, actively implementing) all failed with `the message left the composer without queue
evidence (pane may have gone idle mid-type)` and were verifiably NOT delivered (no row from this
sender in `~/.kteam/ms14lfpl-5b14ac04/channel/inbox.jsonl` after each attempt; verified per
attempt, ~45 s apart). Immediately afterwards a SHORT (~600 char) inline send to the same session
reported `the prompt was typed but the harness never started the turn` — a warning — yet WAS
durably queued (inbox row `queued=true` present). Meanwhile an earlier ~700-char send to the same
session at 01:37:40 had also queued fine.

**Key new datum: length-correlated.** Same sender, same target, same busy state, minutes apart:
4.3 KB message-file payload → lost 8/8; ~600–700 char payloads → queued 2/2. Suggests the
composer-typing path (type-then-verify-queue-evidence) breaks down on LONG payloads typed into a
busy claude pane — e.g. the paste/typing takes long enough that the pane state changes mid-type,
or the queue-evidence probe can't see the evidence for a large paste ("paste again to expand"
collapsed-paste indicator was visible in the pane snapshot during this window).

**Evidence.** Attempts at ~01:41–01:46Z from session ms13qhmf-567cfa73 (dwight) to
ms14lfpl-5b14ac04 (dorian). Inbox rows present: 01:37:40 (short), 01:46:48 (short pointer);
absent: all eight message-file attempts. Target pane snapshot mid-window showed the session
healthy and working (`Implementing B1 version skew… · 62% (123k/200k)`).

**Suspected code path.** `modules/kteam-ts/src/session-manager.ts` send → busy/native-queue path
and `tmux-controller.ts` `typeIntoQueue` (the queue-evidence check after typing). The failure is
loud (exit 1) — that part works — but there is no fallback and no retry, and the SIZE sensitivity
means any lead sending a real brief (briefs are told to use `--message-file`!) hits this
repeatedly. Note the second error string (`typed but the harness never started the turn`)
accompanied a SUCCESSFUL durable queue — the unreliable-warning-in-both-directions problem
already logged on 2026-07-25 is still current.

**Workaround (verified).** Write the long payload to a file under the coordination dir and send a
SHORT pointer message naming the file path; verify delivery via the recipient's inbox.jsonl, not
the CLI output.

**Fix pointer.** This is assigned as A2 in the current batch (georgia, ms14kkah-0e9f8014): the
fallback-on-composer-failure item should cover the long-payload case explicitly — a payload that
cannot be reliably typed should go through a turn-file/durable channel instead of the composer.

_(Logged 2026-07-26 by the triage planner dwight, ms13qhmf-567cfa73, from direct observation.)_

## 2026-07-26 — RESOLUTIONS: kteam-probfix batch (triage + 13 fixes, sessions dwight/georgia/dorian)

Full triage of every entry above against source at b26cac8 lives in
`modules/kteam-ts/.kteam-prob-triage.md` (20 resolved / 8 duplicates / 9 not-code /
7 partial / 4 open / 2 cannot-tell at triage time). The OPEN + PARTIAL items were then fixed in
13 scoped commits by two implementers (georgia = IMPL-A gpt-5.6-sol, dorian = IMPL-B opus-4.8),
every fix with a fails-before/passes-after regression test; final gate 853 pass / 0 fail:

- **False terminal on revive** (`kteam send` to completed session → `failed` while harness alive;
  hit twice 2026-07-26) → RESOLVED `2752d53`. resume() now claims `launching`, refreshes
  `launchedAt`, disarms/re-arms the monitor, force-applies the proven `running` correction;
  terminal "exited" verdicts need a delayed re-probe + subprocess evidence; `exited unknown`
  is gone.
- **Send loss** (idle-path phantom inbox/turn, no fallback, no outbox; incl. the 8/8
  length-correlated `--message-file` loss logged above) → RESOLVED `e5b7959`. Inject before
  state commit; one durable file-backed fallback on composer rejection; multi-KB payloads go as
  short file instructions; sender outbox rows.
- **Stale done marker across gated injection / turn-blind monitor** → RESOLVED `f1d631b`
  (both completion sites use doneMarkerForTurn; stale markers journal
  `session.stale_done_marker`).
- **Ghost sessions after stop + duplicate-worker revives** → RESOLVED `745d206` (process-tree
  death confirmation, child-first TERM→KILL escalation, loud surviving PIDs; auto-revive refuses
  a live same-label+cwd successor).
- **migrate silently shrinks context window + rollback reverts a launched model** → RESOLVED
  `af46422` + `974955e` (window comparison gated by `--allow-context-downgrade`; over-capacity
  always refuses; rollback preserves an observed-launched model; readiness literals centralized).
- **Event loop starved 660s / unhealable index invisible** → RESOLVED `bbfa0f4` (sweeps yield
  every 25 items; health exposes `eventLoopLagMs`/`lastSelfCheckAt`/`wedgeCount`; unhealable ids
  named).
- **Stall-kill of sessions with live background subprocess (openTools gate)** → RESOLVED
  `2fb79d3`.
- **Daemon/CLI version skew + bare `kteam: not found` 404s** → RESOLVED `327c20a`
  (x-kteam-version exchange; structured 404 naming method/path/versions).
- **waitForDaemon fixed 10s window** → RESOLVED `28021c5` (pid-aware, 90s window, fails fast on
  dead pid).
- **Hot-store unbounded growth** → RESOLVED `a2d29cd` (aged terminal sessions archived out of the
  hot store).
- **`start --timeout` naming footgun** → RESOLVED `e4951f9` (`--kill-after-seconds` alias, KILL
  wording, <600s warning). WatchdogSec deliberately NOT added (no sd_notify feeder exists — it
  would kill a healthy daemon); left for a dedicated change.
- **Actor attribution (`source: daemon` for human/UI stops, logged above)** → RESOLVED `cc9cbdc`
  - `ca7edee` (actor derived from token class + self-id headers: admin-ui/admin-cli/peer:<id>/
    warden:<id>; unknown kinds round-trip verbatim, never collapse to `daemon`).

**ACTIVATION: none of the daemon-side fixes are live until `kteamd` restarts** (lead's call, one
batched restart): A1–A7 runtime + B1/B3/B4/B6. B2/B5 are CLI-side (live immediately from source).

Still deliberately open (see triage doc): the /rc-banner readiness CANNOT-TELL (needs a captured
frame fixture), the 07-25 interactive-stops root cause (unanswerable pre-B6; diagnosable after
restart), /signal-behind-adoption residual (bounded, deferred), and the two feature candidates
(worktree isolation, human-only question provenance).

## 2026-07-26 09:47 — `sus_subprocess` + token-blind heuristics self-flag every long Codex turn (spurious warden spawn, harmless)

**Session watched:** ms1jpy88-5618dc60 (lenny, codex-auto-loge, gpt-5.6-sol) — babysat during
mobile-round-3-batch1. Fleet sweep assigned warden mohammed (ms1m6uiq-8219fa70, claude-auto-loge,
opus-4-8) against lenny at 09:47:32 for `sus_subprocess`: "a background subprocess has been
running continuously for 16m." mohammed's verdict (`~/.kteam/daemon/warden/reports/2026-07-26T09-47-32-727Z-ms1jpy88-5618dc60.md`,
also `~/.kteam/ms1m6uiq-8219fa70/summary.md`): **LEAVE** — lenny was healthy and progressing
(Working timer 5m22s→6m15s, context 49%→51%, different active commands, steady CPU, growing
diff/file mtimes across two looks a minute apart). No harm done: the warden-scoped token cannot
send/interrupt/resume/answer/stop anything outside its own assignment (`api-server.ts`
`wardenScopeDenial`), and mohammed's own transcript shows zero mutating calls against lenny —
confirmed independently in lenny's `events.jsonl` (uninterrupted `workspace.changed` through
09:50, no stop/interrupt/resume events in or after the sweep window).

The warden behaved correctly; the defect is upstream — two liveness heuristics misfire
specifically on long Codex turns, each spawning a full opus-4-8 warden session (this one: $1.01,
64k/1M tokens) to investigate a session that was never actually wedged:

1. **`sus_subprocess` counts the session's own turn process as a suspicious long-running
   subprocess.** Condition + threshold: `modules/kteam-ts/src/liveness.ts:188-196` (`susFindings`
   — fires once a continuous subprocess episode, tracked from `subprocessSince`, exceeds
   `susSubprocessSeconds`, default 900s at `modules/kteam-ts/src/daemon-config.ts:93`). The
   "subprocess alive" signal itself is computed at `modules/kteam-ts/src/session-manager.ts:3842-3843`
   as `tmux.subprocessAlive() || backgroundTerminalCount(pane.visiblePane) > 0`.
   `tmux.subprocessAlive()` (`modules/kteam-ts/src/tmux-controller.ts:511-518`) does exclude the
   pane's own root PID (`.slice(1)` over the process tree) — but excludes nothing else: a
   necessary per-turn child process (lenny's PID 14243, `codex-raw ... resume --model
gpt-5.6-sol`, alive for the whole turn) is indistinguishable from a genuinely runaway
   background job. `backgroundTerminalCount()` (`tmux-controller.ts:213-219`, footer text "N
   background terminal(s) running") excludes nothing at all — it's a raw text-match. Net effect:
   any single Codex turn that holds one live process or one open background terminal past 15
   minutes self-flags, regardless of health.
2. **The token liveness channel structurally never advances for gpt-5.6-sol.** Fed by
   `paneWorkCounters()`'s tokens regex (`tmux-controller.ts:190-196`, matches literal `"N[k]
tokens"` in the pane — Claude Code's status line format) and only set on proven increase via
   `workCountersAdvanced`/`foldStallLiveness` (`tmux-controller.ts:202-209`, `:241-252`, token set
   at `:251`). Codex's pane renders a `Context NN% used` meter instead of a `"tokens"` string, so
   the regex never matches and `lastTokenAdvanceAt` never moves — a gap the code already documents
   inline (`tmux-controller.ts:229`: "codex has none, so this never moves there and the sus
   classifier treats the session as token-blind"). This channel isn't what triggered this
   specific incident (`sus_subprocess` doesn't read it — only `sus_thinking` does), but it adds
   false weight to any stall/sus judgment that treats a never-fed channel as infinitely stale
   rather than not-applicable, and was independently observed here: lenny's token-age read 951s
   at mohammed's first look, 1002s at the second, monotonically growing across an actively
   progressing turn.

**Workaround:** none needed — the warden self-corrects (cheap, read-only, bounded by
`assignedCooldownMinutes`) and caused zero harm. **Suggested fix:** exclude a session's own
necessary per-turn/background-terminal process from `sus_subprocess` (or require CPU/output
growth between ticks, which the warden already checks manually), and treat a harness whose
token channel has NEVER once advanced (not just "stale") as not-applicable rather than
maximally-stale in any heuristic that weighs `tokens` staleness.

## 2026-07-26 — structured questions intermittently never render in the UI ("sometimes questions don't propagate")

**Problem.** An agent raises a structured question (`AskUserQuestion` / Codex `request_user_input`)
and sometimes it never appears as a QuestionForm in the kteam UI, so the human can't answer.
Intermittent. Investigated read-only in session `ms2bna1k-c43f2f07`; full writeup at
`~/.kteam/ms2bna1k-c43f2f07/question-propagation-diagnosis.md`.

**NOT the cause: `HAS_TOKEN` / token-less shell.** The UI is reached via a **Cloudflare tunnel**,
not Tailscale/plain-HTTP. `cloudflared` proxies to `127.0.0.1:7337`, so from the daemon the peer is
loopback (`api-server.ts:239-240`) and the shell IS served with the embedded admin token
(`:268-271`, `:276`); `HAS_TOKEN` is true. Verified and dropped.

**Confirmed drop points (ranked).**

1. _(Primary, best fit for "sometimes")_ **Reconnect/late-focus recovery relies on a 200-event
   GLOBAL fleet backfill.** `interaction.question` IS journalled (seq>0, not in
   `HARNESS_DERIVED_EVENT_TYPES` at `session-manager.ts:282-289`) and broadcast live. But the WS
   catch-up on (re)connect is a fixed global tail: `ui/src/lib/ws.ts:44` opens with
   `after=STREAM_TAIL=-200` (`store.tsx:78`); `api-server.ts:581` calls
   `replay(undefined, -200, 1000)` → `session-manager.ts:3148` `tailFleet(min(200,1000))` →
   `storage.ts:970-982` `SELECT ... FROM events ORDER BY time DESC LIMIT 200` (whole fleet, by
   time; one page only — `api-server.ts:588`). A question raised while the client was
   disconnected/backgrounded that is >200 fleet-events old is NOT re-delivered, so the per-session
   `scheduleRefresh` (`store.tsx:663`, 900ms `getSession`) that flips the view to
   `awaiting_question` never fires. Recovery then depends only on `reconcile()` (`listSessions`,
   which DOES carry `state.pendingQuestion`/`status` — `compactFleetSession` at
   `api-server.ts:53-57` strips only `config.harnessSessionBaseline`), and every non-forced
   `reconcile` is **skipped while `document.hidden`** (`store.tsx:573`) and throttled 5s
   (`:572`); the 45s interval is also hidden-gated (`:339`). Net on the phone PWA: form delayed up
   to ~45s after foregrounding, and absent entirely while backgrounded. Measured fleet rate today
   ~18 events/min ⇒ 200 events ≈ 11 min (much less during bursts).

2. **A `direct:true` send (or any new-turn transition) clears `pendingQuestion` without an
   answer.** `session-manager.ts:1825-1831` (`pendingQuestion: undefined` on turn start). A normal
   send while `awaiting_question` is rejected (`:1578`), but a `direct` send bypasses that guard.
   Benign when the human chooses to type; a real drop if any automated/injected direct send lands
   while a question is pending. **This is what cleared the candidate instance** (see below).

3. _(Permanent, harness-dependent — CANNOT-TELL)_ an unanswered question cancelled by the harness
   (tool timeout/interrupt) writes a `tool.result` that clears `pendingQuestion`
   (`session-manager.ts:4287`/`:4448`) before a `reconcile()` surfaces it → gone for good.
   Fixture: leave an interactive `AskUserQuestion` unanswered 10-20 min with no client and watch
   whether `state.json` clears on its own.

4. _(Transient live race)_ `interaction.question` carries no `status` in its payload, so the
   optimistic `transitionPatch` (`store.tsx:257-264`) applies no status; `awaiting_question` only
   lands via the 900ms-debounced `getSession`. A question answered/interrupted inside that window
   never shows a form. UI gate is status-only: `SessionChatPage.tsx:442`
   (`awaitingQ = state.status === 'awaiting_question'`), form at `:999`
   (`awaitingQ && pendingQ && HAS_TOKEN`).

5. _(Codex — CANNOT-TELL, needs fixture)_ Codex `request_user_input` uses the same emit path, but
   abort/turn-boundary clearing (`:4434-4438`) and one-record→many-events normalisation are not
   proven equivalent to Claude's per-line delivery (`claude-transcript.ts:707-731` delivers one
   transcript line per `onEvents`, which rules out within-batch collapse for Claude).

**Candidate instance `ms1lhymf-c4051f31` (zelda), seq 454 — verdict: consistent with the bug, not
proof.** 21:35:19 the agent raised the Parakeet `AskUserQuestion` and the daemon correctly emitted
`interaction.question` + reached `awaiting_question`. 13s later (seq 455) the human sent a
**free-text `admin-ui` message with `direct:true`** instead of a structured `answer`, which cleared
the question (drop point 2, "rejected/interrupted"); at 21:39 they typed this very bug report. The
human resorting to typing right before reporting the bug is what you'd expect if the form never
rendered (mode is `interactive`, so detection/state were correct) — but the journal can't prove the
form's absence.

**Workaround (user-facing):** if a question seems missing, foreground the tab and wait one reconcile
(~≤45s), or reload the session page (`hydrate()` does a full `listSessions` and restores it). Answer
with `kteam answer`/the form rather than a free-text send, which discards the pending question.

**Suggested fixes:** (1) on WS reconnect, force a per-session `getSession` for the open session and
make the reconnect `reconcile()` forced (`store.tsx:457 → reconcile(true)`), or resume the fleet
backfill from each session's last-seen sequence instead of a fixed global `-200`; fire one
un-gated reconcile on the visibility→visible edge. (2) relax the UI gate to
`(awaitingQ || pendingQ) && !isTerminal && HAS_TOKEN` (`SessionChatPage.tsx:999`) so an open
question shows even before `status` propagates. (3) reject or visibly-supersede a `direct` send
that lands on `awaiting_question`. (4) journal an `interaction.question_cancelled` event when a
question is cleared unanswered. (5) carry `status`/`awaiting_question` in the `interaction.question`
payload so `transitionPatch` flips the view immediately.

## 2026-07-26 21:47–21:52Z — instant-return native input executes 3×, then reports HTTP 409

**Problem.** A single send of native input that the Codex TUI handles locally, without starting a
model turn, may be executed **three times** and then reported as failed with HTTP 409. This is not
specific to `!`: it reproduced with both the supported `/status` command and a shell command. Any
native command which consumes the composer input, returns immediately to an idle prompt, and
produces no positive model-turn evidence can enter the same retry path. For shell commands this is
an arbitrary side-effect-duplication hazard.

**Evidence (live web-send path, Codex 0.145.0, interactive session Tanner
`ms2bqvyc-3cd1f9e6`).** Both probes used the same authenticated
`POST /v1/sessions/:id/send` JSON request as the web composer, with one unique request id per send;
no direct tmux input was used.

- At `2026-07-26T21:47:26.988Z`, one request
  (`composer-probe-codex-status-ms2bpjea`, body `{"message":"/status","now":false}`)
  was submitted. Pane records contain one `/status` panel at
  `2026-07-26T21:47:31.961Z`, two at `2026-07-26T21:47:52.940Z`, and three at
  `2026-07-26T21:48:08.707Z`; the request reported HTTP 409. A second diagnostic request at
  `2026-07-26T21:48:24.239Z` independently added exactly three more panels (four at
  `21:48:34.435Z`, five at `21:48:49.776Z`, six at `21:49:10.063Z`).
- At `2026-07-26T21:51:52.949Z`, one request
  (`composer-probe-codex-bang-ms2bpjea`, body
  `{"message":"!printf KTEAM_BANG_PROBE","now":false}`) was submitted. Pane records contain
  one `You ran printf KTEAM_BANG_PROBE` result at `2026-07-26T21:51:56.147Z`, two at
  `2026-07-26T21:52:01.355Z`, and three at `2026-07-26T21:52:06.515Z`. At
  `2026-07-26T21:52:10.245Z` the single request completed with
  `{"error":"the prompt was typed but the harness never started the turn"}` and `HTTP 409`.

The full probe transcript is
`~/.kteam/ms2bqvyc-3cd1f9e6/logs/turn-002.txt`; the timestamped pane evidence is under that
session's `snapshots/`. The design investigation which found the defect is
`~/.kteam/ms2bpjea-120af894/composer-affordances-design.md`.

**Suspected code path.** `modules/kteam-ts/src/session-manager.ts:1787` calls
`TmuxController.send`; `modules/kteam-ts/src/tmux-controller.ts:786-816` waits for readiness and
calls `inject()`. In `inject()` (`tmux-controller.ts:693-735`), `turnStarted` requires active-work
or non-idle evidence (`:699-700`), while the outer loop explicitly retries three times (`:702`).
When a local command consumes the payload and immediately returns idle, `composerHolds` is false
without `turnStarted`; after the grace polls (`:715-723`) execution falls through and retypes the
same input (`:727-729`). After the third execution it throws the observed error (`:730-734`), and
`api-server.ts:556-559` maps the ordinary error to HTTP 409.

There is **no idempotency guard inside the injection retry loop**. The request-id `applyOnce`
mechanism at `api-server.ts:423-445` is outside that loop and cannot distinguish or suppress its
three internal executions (and it records a request only after the operation succeeds).

**Workaround.** Do not send local/instant-return native commands through the web composer until
delivery has command-aware, one-shot acknowledgement. In particular, never send side-effecting
`!` commands there; run them directly in a harness/terminal where kteam's injection retry is not
involved. The eventual fix needs a distinct `handled-local` outcome (or equivalent native-command
acknowledgement) and must never retype an input after the TUI has consumed it as a local command.

_(Logged 2026-07-26 by humberto, session `ms2bpjea-120af894`, from direct observation. No daemon
restart or source fix was performed in this design-only turn.)_

---

## 2026-07-26 — Structured answer refused with "the structured question is not visible in the interactive tmux pane; snapshot and retry" when the selected option label wraps in the pane

**Problem.** A session in `awaiting_question` shows the structured question correctly in
the web UI (heading, question text, radio options, Other row, SUBMIT). The user selects an
option and submits, and the answer is refused inline with:

> `the structured question is not visible in the interactive tmux pane; snapshot and retry`

This is NOT the question-propagation bug (that was "the form never appears", fixed by sasha,
`~/.kteam/ms2bna1k-c43f2f07/question-propagation-diagnosis.md`). Here the question IS on
screen; it just cannot be answered. The failure is a **dead end**: the guard refuses rather
than typing blind, but leaves the user with no way to answer that option from the UI.

**Trigger / exact condition.** The refusal fires only for option labels that do not appear
as a **contiguous whitespace-stripped substring** of the captured pane. That happens when the
label wraps across two TUI lines AND there is right-column content between the wrapped
fragments — e.g. an ASCII/box-drawing side panel the model drew in its answer. The
whitespace-strip normalization removes spaces/newlines but NOT the intervening box-drawing +
panel text, so the two fragments never become adjacent and the substring match fails. Long
labels the harness truncates with an ellipsis would fail the same way. Short, single-line
labels answer fine.

**Evidence (session `leon` = `ms2byk2f-891acfa2`, real pending question, observed read-only).**
Question: `What naming scheme do you want for the helper EAs? (I stay the main EA; these are
staff under me.)` Options: `Plain role names (Recommended)`, `East Asian mythical`, `Norse`,
`Chemistry`. In the pane the Recommended option renders wrapped —
`1. Plain role names` on one line and `(Recommended)` on the next — with a box-drawing panel
(`┌── Main EA → you (me) … └──`) occupying the columns to the right of both lines.

Running the daemon's exact normalization
(`pane.replace(/\s+/g,'').toLowerCase()` and `label.replace(/\s+/g,'').toLowerCase()`) against
`leon`'s real snapshot `~/.kteam/ms2byk2f-891acfa2/snapshots/2026-07-26T22-41-48-922Z.txt`:

- `questionProbe` ("whatnamingschemedoyouwantforthehelpereas") — **visible: true**
- `Plain role names (Recommended)` → "plainrolenames(recommended)" — **visible: FALSE**
- `East Asian mythical` → "eastasianmythical" — visible: true
- `Norse` → "norse" — visible: true
- `Chemistry` → "chemistry" — visible: true

So the user picked the Recommended option — the only one that fails `selectedVisible` — and
`answerQuestion` threw. The daemon-restart lead is a red herring here: the anchor
(`questionProbe`) still matches after adoption; the wrapped label is what fails.

**Suspected code path.** `modules/kteam-ts/src/tmux-controller.ts:931-934`, in
`answerQuestion()`:

```
const questionProbe = question.question.replace(/\s+/g, '').toLowerCase().slice(0, 40);        // :931
const selectedVisible = selected.every(label =>
  normalizedPane.includes(label.replace(/\s+/g, '').toLowerCase()));                            // :932  <-- fails on wrapped label
if (!questionProbe || !normalizedPane.includes(questionProbe) || !selectedVisible || current.promptReady) {
  throw new Error('the structured question is not visible in the interactive tmux pane; snapshot and retry'); // :934
}
```

`session-manager.ts` `answer()` (~`:1874`) calls this on the same path the web UI and
`kteam answer` both use, so the CLI has the identical failure for a wrapping label. Menu
navigation itself is index-based over the daemon's authoritative stored `options` array
(`options.findIndex(...)`), so the full-label substring match is a redundant sanity check, not
the thing that makes navigation correct.

**Workaround (immediate, no code change).**

- In the UI, do NOT click the wrapping `… (Recommended)` radio. Instead use the **Other…**
  field and type the answer text (e.g. `Plain role names`), then submit. Freeform sets
  `selected=[]`, so `selectedVisible` is vacuously true and the guard passes; the freeform
  branch types the value via the custom-response row.
- Or pick any single-line option (here: East Asian mythical / Norse / Chemistry) — those pass.
- CLI equivalent: `kteam answer <id> --response "<free text>"` (a response that doesn't exactly
  match a stored label is treated as freeform and bypasses `selectedVisible`).

**Fix proposal.** Relax `selectedVisible` (`:932`) from a full-label contiguous match to a
distinctive **prefix** match — e.g. the label up to its first `(` or its first ~12
non-whitespace chars — so trailing `(Recommended)` wraps and ellipsis truncation no longer
cause false refusals, while still guarding against a grossly wrong pane. (Navigation stays
index-based on the stored options, so this only affects the sanity gate.) Do NOT weaken it to
"accept and type blind" — index navigation must still be preconditioned on the question text
(`questionProbe`) being present and `promptReady` being false, which it already is. Re-present
/ scrollback fallbacks are unnecessary here: the question is fully visible; only the label
matcher is too strict.

_(Logged 2026-07-26 in automode, coordination dir `ms2e8bal-25b03b99`. READ-ONLY on the repo
except this append; no daemon restart, no build, `leon` observed only — not answered.)_

## 2026-07-26 ~23:05Z — DAEMON-SIDE CONTRIBUTOR: inline native-queue sends leave no `chat.user` record and no `control.send_consumed`, so the UI can never prove per-message delivery

**Symptom (the reported bug).** A short message sent to a BUSY interactive session renders in
the browser with an orange "queued for next turn" chip that NEVER clears, even long after the
message was delivered and acted on. On reload the message vanishes entirely. Screenshot:
`~/.kteam/ms1lhymf-c4051f31/attachments/0f713da208144d13769fd41336ffc4cf3a4957f8d8cf6607004a5d735390e912/image.png`.

**Evidence (real session `ms1lhymf-c4051f31`, turns 36→37).** The three stuck messages are
journal events `control.send_queued` seq 613/616/617, all `turn:36`, all WITHOUT
`fileBacked`. Across the whole session there are **zero `control.send_consumed` events** and
**zero `chat.user` records** carrying those texts (checked all 1779 `/chat` records). Yet the
session advanced to turn 37, and the agent acted on them — so they WERE delivered. A fresh
repro (`ms2emuk3-a24edcc7`) confirms: after a short send to a busy session, the agent's own
reply quoted the message ("Also saw your mid-turn message …") while `pendingNativeSends` still
held the entry, `turn` never advanced, and no `chat.user`/`send_consumed`/`send_lost` was
emitted.

**Root cause (daemon side).** `session-manager.ts` `queueNativeSend()` (~`:1683`) types a
short (`≤ NATIVE_QUEUE_INLINE_MAX_CHARS = 1000`) message straight into the harness composer
and emits ONLY `control.send_queued` (no `fileBacked` flag). The harness folds that composer
text into a turn without the daemon capturing a distinct `chat.user` transcript record, and
`correlateNativeSends()` (~`:4110`) can only emit `control.send_consumed` when it finds a
matching `chat.user` boundary — which for inline sends never exists. So the ONLY durable,
per-message server signal for an inline native-queue send is the `control.send_queued` event
itself; there is no server-provided proof of _delivery_ (contrast the file-backed queue path,
which leaves a "Read the queued message file …" `chat.user` row, and the idle turn-file path,
which leaves a turn-prompt `chat.user` row — both reap normally).

**UI half (fixed here, my ownership).** `ui/src/lib/transcript.ts` `buildSendIndex()` ignored
non-`fileBacked` `control.send_queued` entirely, so inline queued sends were indexed nowhere
and `buildTranscript()` rendered no block → the optimistic `PendingSend` reaper
(`blockConfirmsPending`, `SessionChatPage.tsx`) had nothing to match → chip stuck forever, and
the message was invisible on reload. Fix: collect inline queued sends onto a new
`SendIndex.queued` list and have `buildTranscript(records, sends, sessionId, currentTurn)`
SYNTHESIZE a `chat.user` block for each once `currentTurn` has advanced past the turn it was
queued in (proof it left the composer — a turn cannot advance while its queued text is
unsubmitted; a lost send dies at its turn and never advances it). The existing block reaper
then clears the chip. Kept proof-based (no timers/assumptions); a still-open turn or a
terminal-without-advance (lost) send is deliberately NOT synthesized.

**Suggested daemon-side follow-up (NOT done — outside UI ownership).** Give inline
native-queue sends the same durable per-message delivery proof the other paths already have:
either persist a real `chat.user` record when the composer text is actually consumed, or emit
`control.send_consumed` (with the real text + queueId + consuming turn) for inline sends too —
correlating on the turn-advance boundary rather than requiring a matching `chat.user`. That
would let the UI reap the _specific_ queued message on authoritative evidence instead of
inferring delivery from `view.state.turn` advancing past the queued turn.

_(Logged 2026-07-26 in automode, coordination dir `ms2ebjqf-5cd365e7` (london). READ-ONLY on
the repo except this append and the four owned UI files; no daemon restart, no `bun run build`.
Repro sessions `ms2ehmrt-18901448`/`ms2emuk3-a24edcc7` stopped after use.)_

---

## 2026-07-27 — `claude-auto-mm3` falsely reported "not logged in (kfleet usage reports auth failure); run kfleet login" (INTERMITTENT false positive)

**Problem.** kteam intermittently refuses to launch/route `claude-auto-mm3` with
`wrapper claude-auto-mm3 is not logged in (kfleet usage reports auth failure); run
kfleet login`, even though the MiniMax account works fine. A false auth alarm that
tells the user to re-auth a working account trains them to ignore real ones.

**Evidence.**

- Live probe of MiniMax's usage endpoint (`GET
https://api.minimax.io/v1/token_plan/remains`) with the real key returns HTTP 200,
  `base_resp.status_code:0 "success"`, general model 99%/100% remaining — healthy.
  60 spaced probes over ~45 min (coordination dir `ms2g4kn2-226ce51a`,
  `minimax-poll.jsonl`) were ALL `status_code:0` — the failing state is rare/transient,
  not persistent (rules out a genuine intermittent auth drop across that window).
- A genuinely bad/empty key returns HTTP 200 with `status_code:1004 "login fail:
Please carry the API secret key in the 'Authorization' field of the request header"`.
  So `1004` is MiniMax's generic auth-verification-failed code — and it is what a
  valid key can also transiently receive under load/throttle.

**Suspected code path.**

1. `modules/kfleet-ts/src/core/usage.ts` → `probeMinimax()` (~:263-289): a SINGLE
   `status_code` of `1004`/`2049` sets `authOk:false` with no retry/hysteresis. One
   transient blip = "not logged in". (Non-1004/2049 nonzero codes and HTTP 429/timeouts
   correctly resolve to `authOk:undefined` = "usage unavailable", so ONLY the transient
   1004/2049 misfires.)
2. Intermittency amplifier: kteam `UsageFeed` (`modules/kteam-ts/src/usage.ts:49-112`)
   caches `kfleet serve`'s `/usage` snapshot for the `usage.interval` window (300s,
   `kfleet/config.yaml`). One bad probe cycle poisons the cached verdict for the whole
   window; a fresh manual `kfleet usage` re-probes and shows ✓ ("works fine now").
3. Remedy text is impossible advice: `modules/kteam-ts/src/session-manager.ts:1176`
   and `modules/kteam-ts/src/core.ts:698` say "run kfleet login". But
   `modules/kfleet-ts/src/cli/login.ts:42` iterates `identities.filter(i => i.oauth)`
   and mm3 is an API-key account (`isOAuth` false, `core/login.ts:44-48`), so `kfleet
login` SKIPS mm3 — it can never fix an mm3 credential. The genuine remedy is
   rotating `$MINIMAX_API_KEY` in sops, then `kfleet apply`/`hms`.

Ruled out: OAuth per-member override (mm3 is filtered out of `scanOAuthAuth`); missing
env var (`$MINIMAX_API_KEY` present, `sk-cp-…`, len 125 — would be persistent anyway).

**Fix proposal.**

- `probeMinimax`: on `1004`/`2049`, re-probe once; only return `authOk:false` if it
  fails twice consecutively (transient blip clears on the retry).
- Add hysteresis at the feed/serve layer (provider-agnostic): require ≥2 consecutive
  failing cycles before surfacing `authOk:false` to the launch gate.
- Make the kteam remedy message provider-aware: for API-key providers
  (minimax/zai/deepseek), say "API key rejected by <provider> — rotate the key in
  sops, then kfleet apply", NOT "run kfleet login" (which is only valid for
  anthropic/codex OAuth accounts).

**Workaround (human).** Ignore a lone mm3 "not logged in" when `kfleet usage` shows it
✓ on a fresh run; do NOT run `kfleet login` for mm3 (no-op). If it were ever a real
MiniMax auth failure, rotate `$MINIMAX_API_KEY` in `secrets.yaml` and re-apply.

_(Logged 2026-07-27 in automode, coordination dir `ms2g4kn2-226ce51a`. Diagnosis only:
READ-ONLY on the repo except this append; no `kfleet login`/`apply`/`hms`, no daemon
restart, no `bun run build`. Full write-up in that dir's `findings.md`.)_

---

## `kteam send` fails on both native AND durable paths to a stalled `running` session

**Observed 2026-07-27 (automode, coordination dir `ms2k9t5o-111aede1`, worker teammate).**

Sending a completion handoff to the lead (`zelda`, session `ms1lhymf-c4051f31`)
failed twice:

```
kteam: native composer delivery failed and the one durable file-backed fallback
also failed ... NativeQueueComposerError: durable queue instruction failed;
the complete payload remains at .../channel/queued-<uuid>.md ... Error: text did
not land in the composer
```

Both a ~1.5KB and a shorter follow-up failed identically, so it is **not payload
size** (the CLAUDE.md "multi-KB to a busy session" caveat does not fully cover
this — a short message failed too).

**Evidence.** `kteam status ms1lhymf-c4051f31` reports the session as `running`
turn 58, but the liveness counters are all ~830–845s stale (`transcript 842s`,
`pane 830s`, `last tool started 01:44:08Z` ~14 min prior) and `context 324% used`.
So the session is effectively **stalled mid-tool-call** — not at a turn boundary,
composer unavailable — yet still classified `running`, and the stall monitor had
not acted after 14 minutes.

**Two distinct problems.**

1. A `running` session can sit with all liveness counters stale for 14 min+ and
   `context > 100%` without being flagged stalled — the stall detector's
   threshold/among-counters logic (likely `modules/kteam-ts` daemon liveness/stall
   path) is not catching this shape.
2. The "durable file-backed fallback" for `kteam send` is not actually durable:
   the payload file is written, but the _instruction to consume it_ also depends
   on the composer, so when the composer is unavailable BOTH paths fail together.
   A truly durable queue should append to `channel/inbox.jsonl` (or similar) for
   the session to drain at its next boundary, independent of the live composer.

**Suspected code path.** `modules/kteam-ts` — the send/composer delivery
(`native composer` + `durable queue` fallback) and the daemon stall/liveness
classifier.

**Workaround.** None applied (cannot help-signal in automode, and the human owns
`kteamd`). Completion was handed off durably instead via this session's
`summary.md` + `kteam signal done`; the queued payloads remain at
`.../ms1lhymf-c4051f31/channel/queued-*.md` for a manual
`kteam send ms1lhymf-c4051f31 --message-file <that>` retry once zelda unstalls.

_(Logged in automode; append-only to this file, otherwise READ-ONLY on the repo
outside my owned UI files. No daemon restart, no `bun run build`.)_

---

## 2026-07-27 — structured questions could still dead-end and journal answers that never landed

**Live reproduction.** Isolated interactive Claude session `ms2l7r3c-d2ffe58f`
(`frances`) displayed one question with the sibling labels `Enable feature` and
`Enable feature flags`. `kteam answer frances "Enable feature"` failed every time
with “the structured question is not visible” even though the snapshot showed the
complete numbered row `❯ 1. Enable feature`. The safe prefix matcher deliberately
had no unique fragment for a label that is itself a sibling prefix, but it failed
to use the stronger evidence already on screen: an exact complete menu row.

**Worse, the refusal was recorded as success.** The session stayed
`awaiting_question` with the same `pendingQuestion`, but `events.jsonl` gained an
`interaction.answer` row for `Enable feature`. `SessionManager.answer()` emitted
that event _before_ calling the matcher/driver. The UI therefore had a false answer
in history while the user remained blocked. The driver also ignored most tmux
`send-keys` exit codes and returned after fixed 300ms sleeps without checking that
the menu advanced, a next question appeared, a turn started, or a prompt returned.

**Other confirmed dead-end paths in source.** Answers were not bound to the
question's `toolUseId`, so a stale browser form for A could drive into B. A
nonmatching `tool.result` changed status to `running` while retaining A's
`pendingQuestion`. Generic interrupt did not clear or lifecycle-mark a pending
question. Matching result / completion / abort silently erased it. The web form
offered no explicit abandon path after a refusal, so deterministic matcher failures
could only be repaired with CLI/session surgery.

**Implemented recovery design (daemon restart intentionally left to the lead).**

- Answer POSTs now carry and validate `toolUseId`; stale forms refresh instead of
  ever driving a different question.
- The menu driver accepts exact complete rows for ambiguous-prefix labels, exits
  tmux copy-mode once to restore a scrolled question, checks every key result, and
  records success only after post-Enter pane-advance evidence. Partial
  multi-question retries resume at the currently visible question.
- Failed/unconfirmed answers keep `pendingQuestion` intact and journal
  `interaction.question_failed` with matcher details, pane geometry/hash/excerpt,
  and `last-snapshot.txt`. `interaction.answer` is now the verified transition,
  never an attempted keystroke.
- QuestionForm always exposes a two-step **Abandon question** escape hatch.
  Pending-question interrupt sends Escape and requires pane confirmation before it
  clears state; interrupt is request-id deduped so a lost response cannot send a
  second Escape.
- The monitor self-heals after two frames of strong divergence (idle prompt, or a
  new active turn with no question visible), while ambiguous missing/repaint states
  remain safely pending and get a diagnostic event/snapshot. Harness clears,
  aborts, and superseding questions now receive explicit lifecycle events.

**Verification.** Focused daemon/API/tmux/session-manager and QuestionForm/store
tests pass, including the exact live repro, swallowed Enter, failed tmux key,
copy-mode restore, verified abandon, stale tool id, unrelated tool result, and
Codex abort fixtures. Codex's real question menu is still unverifiable: the
normalizer recognizes it synthetically, but no live `request_user_input` event has
appeared fleet-wide, so no claim of live Codex pane parity is made.

_(Logged 2026-07-27 in automode, coordination dir `ms2l1x3i-6e1818ad`. No commit,
no daemon restart, and no UI build.)_

## 2026-07-27 — concurrent teammates in ONE worktree can corrupt a file (NUL byte mid-file)

**Problem.** With ~6 teammates editing `modules/kteam-ts` simultaneously, teammate
`bernard` (ms2mldiq-60902e3d) reported that a collision left a **NUL byte
mid-file** in its own new `src/learning.ts`, which it had to rewrite. Separately it
could not land edits in `api-server.ts`, `daemon-config.ts`, `paths.ts` or
`App.tsx` at all, because other teammates "keep rewriting those whole files"; it
delivered the wiring as a hand-apply patch instead. Teammate `cordelia`
(ms2mlj0s-6382e46b) independently pre-emptively backed up its `index.ts` diff for
the same reason, having detected a second concurrent editor on that file.

**Evidence.** `bernard` summary + `~/.kteam/ms2mldiq-60902e3d/learning.patch.md`;
`~/.kteam/ms2mlj0s-6382e46b/safemigrate.patch.md`. At the time: 11 lead-owned
sessions live, 22 dirty files in `modules/kteam-ts`. The corrupted file was
rewritten by its author, so nothing was lost — but a torn write that lands as
valid-looking source is the dangerous version of this.

**Suspected cause.** Not a kteam defect as such: it is the documented shared-tree
hazard (`CLAUDE.md`: "Concurrent teammates share one working tree… assign explicit
per-file ownership, no file owned twice"). Per-file ownership WAS assigned and
mostly held; what broke down is that several agents legitimately needed the same
SHARED wiring files (`api-server.ts`, `App.tsx`, `index.ts`, `lib/api.ts`,
`lib/store.tsx`, `types.ts`) that no single feature owns. Whole-file rewrites by
formatters/agents on those shared files are what produced the collisions.

**Workaround in use.** Agents that cannot land a shared-file edit write a
hand-apply patch to their session dir and the lead applies it serially. That works
but is manual and easy to drop.

**Real fix candidate (already on the feature list, now with evidence):**
per-teammate git worktree isolation. This is the second independent incident
pointing at it — recorded previously as a feature candidate after a foreign staged
file was swept into another agent's commit. A shared wiring file wanted by N
features is the case per-file ownership cannot express.

**Lead lesson (process, not code):** the lead over-parallelised — ~6 concurrent
writers on one package. Throttle concurrent writers on a single package, or
sequence work that touches shared wiring files.

---

## 2026-07-27 — structured-question hardening closed with fail-closed live-region binding

**Closure of the structured-question report above.** Five adversarial review
rounds found a common remaining defect class: authorising evidence was gathered
from the whole tmux capture, so stale scrollback or transcript prose could be
combined with a different live selector. In the worst case, answer or abandon
could send keys into a model picker, permission prompt, or other unrelated menu.

**Final safety boundary.** Every authorising fact now comes from one contiguous,
bottom live-menu block: structural whole question row, exact header row, ordered
option rows, cursor, and checkbox state. Footer/question/composer boundaries stop
the block walk; multiple cursors or a composer below the menu reject it. Question
matching requires full normalized equality with only bounded wrapped rows and an
explicit anchored-ellipsis exception. A prose quote — even with the same complete
option set — cannot authorise answer or Escape. Free-text presence and typing use
the same bounded bottom region (structural question row + explicit marker + bottom
composer), so stale free-text scrollback at an idle prompt neither pins
`awaiting_question` nor receives a new message. Ambiguity always refuses with zero
keys/fills.

**Recovery/state guarantees.** Answers and abandons bind to the rendered
`toolUseId`; abandon retries retain one logical request id; terminal driving is
confirmed before success is journalled; failures preserve the pending question
and diagnostics; explicit abandon restores chat only after verified cancellation;
and pane self-heal is serialized with submit/cancel and revalidates the pending
tool id before mutation.

**Verification.** `tmux-controller` + manager-question + API focused suites:
**168 pass, 0 fail**; `QuestionForm`: **33 pass, 0 fail**; package TypeScript passed
inside `bun run check`; `git diff --check` passed. Independent final review ran
**130 focused tests** and found no blocker. The current shared-tree broad gate is
not clean for an unrelated Settings/dictation slice: UI typecheck reports the
missing `components/DictationSettings` import plus `stt/capabilities.ts:89`
nullability, and UI tests report **764 pass, 2 fail, 2 errors** from that missing
module (package check: **1588 pass, 2 fail, 2 errors**). Those separately owned
files were not edited here.

**Architectural ceiling.** Pane scraping is conservative rendered-history
matching, not authoritative interaction state. The long-term fix is a
harness-native RPC/adapter keyed by `toolUseId` that exposes the active ordinal
and accepted/cancelled acknowledgement, leaving the terminal display-only.
Codex `request_user_input` remains unverified fleet-wide; safe refusal is the only
supported claim until controlled live captures exist.

_(Closed in automode, coordination dir `ms2l1x3i-6e1818ad`. No commit, daemon
restart, or UI build.)_

---

## 2026-07-27 — Context-window % is wrong (`ctx 324%`): `[1m]` window derived from the wrong model string

**Problem.** The composer status line showed `● · claude-opus-5[1m] · ctx 324% · running`.
324% is impossible on its face. A peer lead (noel/diene) claimed kteam derives the
window only from a literal `[1m]` substring and reports `contextWindow=200000` for a
`[1m]` session, inflating the percent ~5x. **Confirmed in mechanism, with one
refinement.** READ-ONLY diagnosis, coordination dir `ms2rkmfd-17b8e738`.

**Root cause (one cause, two symptoms).** `[1m]` is a kteam _wrapper-alias_
convention. It lives ONLY in `config.model` (e.g. `claude-opus-5[1m]`). It NEVER
appears in the raw API model id the Claude transcript records — empirically
`message.model` = `claude-opus-4-8` (no `[1m]`), confirmed in a live loge transcript.

`contextWindowForModel()` (`modules/kteam-ts/src/core.ts:940-948`) decides the window
solely by `model.includes('[1m]')` → 1_000_000, else the 200_000 default (`core.ts:948`).
Every Claude caller feeds it a model string from which `[1m]` has ALREADY been stripped:

- transcript-usage path uses `usageEvent.data.model` (raw transcript id, no `[1m]`) —
  `session-manager.ts:4771-4780` and the twin block `:4987-4996`;
- the fallback `resolveDisplayModel()` returns `observedModel` (the harness/transcript
  id) in preference to `config.model` — `core.ts:44` — again dropping `[1m]`.

So a Claude `[1m]` session is ALWAYS assigned `contextWindow=200000`, never 1M.

**Symptom 1 — inflated %.** `contextPercent = round(contextTokens / 200000 * 100)`
(`session-manager.ts:4780`, twin `:4996`). ~648k real tokens on a true-1M session
(real ~65%) → 648000/200000 = 324%. **Reproduced live:** a `claude-opus-4-8[1m]`
session in the fleet reads `contextTokens=414298, contextWindow=200000,
contextPercent=207`. Same mechanism as opus-5[1m] (no opus-5 session was live to
inspect directly; opus-4-8[1m] is the identical code path).

**Symptom 2 — "256K".** There is NO 256K constant anywhere in src or ui (searched).
The real windows the code carries: Claude never emits a `contextWindow` in its usage
event (→ always the 200k/1M `[1m]` guess); Codex (gpt-5.6) DOES emit its own
`model_context_window` (`codex-transcript.ts:324`) and passes it straight through
(`session-manager.ts:4772` `usageEvent.data.contextWindow ?? …`) — live gpt-5.6
sessions read `contextWindow=258400` (≈"256K"), which is accurate. So "256K" is not a
kteam-invented number. Most likely it is the _real_ prompt-token count of the
opus-5[1m] session (~256k = input+cache_read+cache_creation) surfaced correctly — e.g.
MigrateSheet renders `readableNumber(contextTokens)` "…(256K tokens)…"
(`MigrateSheet.tsx:723`). The token COUNT is right; only its pairing with a 200k
window / >100% percent is wrong. Cannot fully pin the exact UI element without the
original screenshot; ruled out a fabricated constant.

**Can % exceed 100%?** Yes, by construction. `Math.round(tokens/window*100)` has no
clamp (`session-manager.ts:4780`), and the UI renders `${contextPercent}%` verbatim
(`ui/src/components/Composer.tsx:814` and `:884`; `SessionDetails.tsx:1187`;
`ui/src/pages/SessionsListPage.tsx` ContextMeter). Above 90% it only turns red
(`text-err`). So 207%/324% render literally.

**Does anything ACT on it? — Mostly COSMETIC, one latent load-bearing spot.**

- `context.high` fires at `>=85%` (`session-manager.ts:4784/4787`, `:5000/5003`, and
  pane path `:4185/4214`). On a `[1m]` session the 5x inflation makes it fire at ~17%
  REAL usage. But `context.high` has NO destructive consumer — grep shows it is only
  emitted to the event stream (UI notification). No nudge / stall / warden / kill /
  auto-compaction reads `contextPercent` or `contextTokens` (only producers +
  display consumers reference them). So: noisy, not dangerous.
- `migrate()` (`session-manager.ts:2587-2613`) is the ONLY place a context number
  gates an action. `currentWindow = contextWindowForModel(currentModel)` mis-detects a
  `[1m]` source as 200k (currentModel comes from `resolveDisplayModel` → observedModel,
  `core.ts:44`), so the downgrade guard (`:2599 targetWindow < currentWindow`) is
  unreliable for `[1m]` sources and its error text (`:2603`) prints wrong window
  numbers. HOWEVER the second guard (`:2608`) compares REAL `contextTokens` against the
  target window and backstops a genuinely-too-large migration. Net: latent bug, masked
  by the token-count guard; not currently breaking migrates.

**Verdict: primarily cosmetic (wrong displayed number + over-eager `context.high`),
with one latent load-bearing guard in `migrate()` that is masked today.**

**Suspected code path / fix.** The true window must come from the WRAPPER/CONFIG
model (`config.model`, which retains `[1m]`), not the transcript model:

1. In the transcript-usage path, when the usage event carries no `contextWindow`
   (Claude case), derive the `[1m]` signal from `config.model` (or OR the `[1m]` test
   across observedModel AND config.model) before calling `contextWindowForModel`.
   `session-manager.ts:4771-4780` / `:4987-4996`.
2. Keep trusting Codex's `usageEvent.data.contextWindow` first (already correct), and
   keep the substring-override table (`daemon-config contextWindows`) as the source of
   real windows for third-party accounts (GLM ~131072, MiniMax, DeepSeek), which
   otherwise all fall to the 200k default.
3. Clamp/shape the UI readout (cap at 100% or render `tokens/window`) so an impossible
   percent can't display — `Composer.tsx:814/884`.
4. Fix `migrate()`'s `currentWindow` to use the configured `[1m]` model so the downgrade
   guard stops relying on the token backstop — `session-manager.ts:2587-2588`.

**Cannot determine.** Exact UI element behind the user's "256K"; the opus-5[1m]
account's exact real window (inferred 1M from the `[1m]` convention + defaults — no
opus-5 session was live to read; opus-4-8[1m] proves the mechanism).

_(Read-only diagnosis in automode, coordination dir `ms2rkmfd-17b8e738`. One append to
this file only; no commit, no daemon restart, no UI build.)_

---

## 2026-07-27 ~17:40Z — `kteam ps --label <slug>` (no `-a`) reported dropping live rows — NOT REPRODUCED, code audited

**Problem (as reported by lead zelda, ms1lhymf-c4051f31).** At ~17:33Z, consecutive
`kteam ps --label ui-round25` calls (without `-a`) returned inconsistent SUBSETS of
the four live sessions: call 1 listed emile+miguel, call 2 minutes later listed
carson+emile. `kteam ps --label ui-round25 -a` consistently listed all four, all
`status=running`. Impact if real: a lead sees live teammates vanish from `ps` and
concludes they died; a genuinely stalled one could hide.

**Repro attempt (babysitter ms3i5j7q-688df4a8, 17:36–17:39Z).** Ran
`kteam ps --label ui-round25` (no `-a`) 20 times consecutively (5 with 2s sleeps,
15 back-to-back). Every single run listed all four rows
(brody,carson,emile,miguel; all `running`). **Could not reproduce.**

**Code audit (what the non-`-a` path actually does).**

- `src/index.ts:522-531` (`ps` action): fetches EVERYTHING via `client().list()`,
  then filters by label, THEN filters out terminal statuses
  (`terminal = ['completed','failed','stalled','stopped']`, `index.ts:62`).
  Filter order is label-first — the suspected "status predicate before label
  filter" is NOT present. There is also NO limit, pagination, or recency window
  anywhere in the `ps` path.
- Server side: `GET /v1/sessions` (`api-server.ts:482`) → `service.list()`
  (`session-manager.ts:1043`) → `store.listSessions()` (`storage.ts:807`), which
  returns the FULL in-process `sessionCache` sorted by recency — no window.
  `list()` drops only rows missing config or state (`session-manager.ts:1045`).
- So for a row to vanish from non-`-a` output, at read time its cached
  `state.status` must have been one of the four terminal values, OR its
  config/state must have been transiently absent from the cache.

**Hypotheses (unconfirmed, in likelihood order).**

1. Transient status flap in the daemon cache: something briefly wrote a terminal
   status (e.g. `stalled` from the liveness path, `session-manager.ts:4597-4616`)
   and then recovered to `running`. `-a` would keep showing the row (matching the
   report), and minutes later everything reads `running` again (matching my failed
   repro). Different sessions flapping on different calls fits the inconsistency.
2. Daemon contention/restart: `~/.kteam/daemon/daemon.log` shows repeated
   `EADDRINUSE` start attempts, several distinct "already running" pids
   (3641546→309645→315185→320208→3877570→3896181) and a
   `[Bun.serve]: request timed out after 10 seconds` — a freshly restarted daemon
   rebuilds `sessionCache` from SQLite (`storage.ts:408-419`) and could serve a
   partially-current view for a moment. Doesn't obviously explain a SUBSET of
   running rows, but daemon churn is real and worth noting.
3. Reader-side truncation (pipe/head/terminal wrap on the caller's side) — cannot
   be ruled out from here since the raw outputs weren't captured.

**Evidence gap.** The original outputs were not captured verbatim; the report is
secondhand. 20-run repro burst is clean.

**Suspected code path if real:** the status value in `EventStore.sessionCache`
at read time (writers: `indexSessionMetadata` `storage.ts:1587`; stall marker
`session-manager.ts:4605`), NOT the ps filter itself.

**Workaround.** Use `kteam ps --label <slug> -a` (statuses are shown anyway) or
`--json` and filter yourself; treat a missing row in non-`-a` output as "check
`kteam status <name>`" rather than "dead". If it recurs, capture the raw output
plus `kteam ps --json` in the same second — the cached `state.status` will show
whether a terminal flap happened.

_(Babysitter read-only diagnosis in automode, coordination dir ms3i5j7q-688df4a8.
Append-only; no commit, no daemon restart, no fix attempted.)_

---

## 2026-07-27 ~17:55Z — CORRECTION to the 17:40Z entry + NEW bug: daemon.log is frozen (systemd rejects the quoted output specifier)

**Correction 1 — the "daemon churn" note in the previous entry is WRONG.** Zelda
(ms1lhymf) pointed out, and I verified: the repeated `kteamd is already running
(pid N)` / `EADDRINUSE` lines are the single-instance guard working AS DESIGNED
(port is the lock; extra invocations probe, find a live responder, and exit with
EXIT_ALREADY_RUNNING so systemd's RestartPreventExitStatus doesn't respawn).
Exactly ONE daemon-entry process is live: pid 1035999, up 6h38m (started
2026-07-27 11:10:13 via a clean systemd stop/start, per journald). Not churn,
not a defect.

**Correction 2 — the `[Bun.serve]: request timed out after 10 seconds` line is
STALE, not current.** `~/.kteam/daemon/daemon.log` mtime is **2026-07-22
16:46:21Z** — the file has not been written in 5 days. The timeout lines in it
predate commit dd78e5a (2026-07-22 19:26Z) which set `idleTimeout: 255`
(`api-server.ts:308`, Bun's documented max) precisely to fix that. Current
source has the fix; the running daemon (started 11:10Z today from this tree)
has it too. No live 10s-timeout problem to characterise — the evidence was a
fossil.

**NEW BUG (the actual root cause of the fossil log): kteamd's systemd unit
quotes `StandardOutput=`/`StandardError=` values, and systemd REJECTS them —
all daemon output silently goes to journald only, and `daemon.log` froze.**

- Evidence: `journalctl --user -u kteamd` shows
  `Failed to parse output specifier, ignoring: "append:/home/kirin/.kteam/daemon/daemon.log"`
  for unit lines 20-21 — **100 occurrences** in the journal (every daemon
  start/reload since the unit was generated). The live daemon's fd 1/2 point at
  a socket (journald), not the file. Meanwhile `daemon.log` mtime is frozen at
  2026-07-22 16:46Z.
- Suspected code path: `modules/kteam-ts/src/daemon-service.ts:115-116` emit
  `StandardOutput=${systemdQuote(`append:${this.paths.daemonLog}`)}` — and
  `systemdQuote` (`daemon-service.ts:19-27`) wraps the value in double quotes.
  systemd's output specifiers are NOT shell-parsed: `StandardOutput=` takes the
  value literally, so `"append:/path"` (with quotes) is an unknown specifier
  and systemd 255 ignores it, falling back to journal. Env vars and ExecStart
  accept quoting; output specifiers don't. Fix: emit the specifier unquoted
  (paths with spaces aren't representable here anyway per systemd docs, and
  KTEAM_HOME is user-controlled but conventional).
- Impact: anyone debugging "the daemon" by reading `~/.kteam/daemon/daemon.log`
  is reading 5-day-old fossils — which is EXACTLY what happened in the 17:40Z
  entry above (I cited stale EADDRINUSE + timeout lines as if current). This is
  a diagnosis-poisoning bug: it doesn't break the daemon, it breaks everyone's
  ability to reason about the daemon.
- Workaround: read `journalctl --user -u kteamd` (add `--all` to inline the
  "blob data" lines, which are just UTF-8 arrows in self-check messages);
  ignore `daemon.log` until the unit generator is fixed and the unit
  regenerated + daemon-reloaded (human's call — do NOT restart kteamd for this).

_(Babysitter read-only diagnosis in automode, coordination dir ms3i5j7q-688df4a8.
Append-only; no commit, no fix, no daemon restart.)_

---

## 2026-07-27 ~18:05Z — `kteam send` to a COMPLETED session is undeliverable when any live session shares its label (successor guard swallows plain messages)

**Problem.** A plain `kteam send <completed-session> "…"` fails with:
`refusing to revive session ms3i46c4-dba503f9: live successor emile
(ms3i4l9t-64e73a49) already owns label ui-round25 in
/home/kirin/.config/home-manager; continue there or stop it first`.
Reported by nils (whose final handover report to carson bounced); **reproduced
verbatim by me at 18:04Z** with a plain message send. Three distinct wrongs:

1. The caller sent a MESSAGE; the error talks about a revive the caller never
   asked for.
2. The named "successor" (emile) is an UNRELATED teammate that merely shares
   `--label ui-round25` + cwd — labels are BATCH slugs, not ownership keys.
   Any lead running a 4-teammate batch under one label makes every finished
   teammate unreachable until the whole batch drains.
3. Net effect: a peer's final handover to a finished teammate is silently
   undeliverable — how carson's orphaned sub-team work nearly got lost today.

**Code path (read, confirmed).**

- `session-manager.ts:1692-1694` — `send()` pre-lock probe: a terminal-status
  target routes the send to `reviveWithMessage()` unconditionally.
- `session-manager.ts:1963-1973` — `reviveWithMessage()` = `resume(id, message)`.
- `session-manager.ts:2440-2447` — `resume()` hits the successor guard.
- `session-manager.ts:2371-2382` — `liveSuccessorFor()`: ANY non-terminal
  session with the SAME trimmed label + SAME resolved cwd counts as a
  "successor". No parent/lineage/teammate-name check — label+cwd only. The
  doc comment says it exists to refuse "resurrection when another live
  teammate already owns the same labelled work", i.e. it was designed for the
  warden's crash-revive dedupe, but it fires on the peer-messaging path too
  because send() converges on resume().
- Design tension: send-to-terminal MUST revive (a dead pane can't receive
  text), but the guard treats "same label = same work" which is false for
  fan-out batches where one label spans N parallel teammates by design (the
  CLAUDE.md contract says `--label` is "your batch slug").

**Fix directions (not applied).** Either (a) scope `liveSuccessorFor` to
actual lineage (same teammate name, or a recorded predecessor/successor link
— e.g. warden respawns record `config.parent`/retry ancestry), or (b) let a
queued peer message survive without a revive: append to the terminal session's
channel/inbox so a later `resume` delivers it, returning
`disposition: 'queued-for-revive'` instead of throwing.

**Workaround (verified by nils):** `kteam resume <name>` first, then
`kteam send` — resume from the CLI takes a different path? No: nils resumed
AND THEN sent; the resume itself succeeded presumably because it ran after
emile… actually nils' resume succeeded while emile was still live, which
suggests the CLI `resume` command passes a message-less path that… was not
re-verified here. Treat "resume-then-send worked for nils at ~17:58Z" as
reported fact; I did not re-run a resume to avoid disturbing carson's
completed state twice.

## 2026-07-27 ~18:05Z — ps --label row-drop, second report (17:57Z, `-a` form): the provided capture does NOT show a drop

Zelda reported the row-drop recurred at 17:57Z "on the -a form too" and
provided captures. I secured them to
`~/.kteam/ms3i5j7q-688df4a8/evidence/ps.{txt,json}`. **Both show all FOUR
ui-round25 rows present** (carson completed, emile tool_running, miguel
running, brody running) with sane per-row state. So either the drop happened
on a different invocation than the one captured, or the capture was taken
after recovery. The JSON confirms: no terminal-status flap visible at capture
time (carson's `completed` is legitimate — done marker written 17:52:19Z).
Status-flap hypothesis stays open but STILL UNCONFIRMED by direct evidence;
nothing new to pin. Standing request: capture the text and `--json` output of
the SAME failing invocation, atomically (`kteam ps --label X > a.txt; kteam
ps --label X --json > a.json` immediately after seeing a drop).

_(Babysitter diagnosis in automode, coordination dir ms3i5j7q-688df4a8.
Repro of the send bug used one harmless test message to completed carson.
Append-only; no commit, no fix, no daemon restart.)_

---

## 2026-07-27 ~18:39Z — `kteam wait <name>` process died silently after ~66 min while its target was still live

**Problem.** A backgrounded `kteam wait brody` (started ~17:33Z) terminated at
~18:39Z with NO output beyond the direnv preamble — reported as killed/stopped,
not exited-with-result — while brody (ms3i49gv) was still alive and
`tool_running`. Three sibling waits (carson/emile/miguel) started the same way
at the same time all completed normally when their targets finished (~19-50 min
lifetimes). Only the longest-lived one died.

**Evidence.** Harness task bzurw2lxm status `killed`; its output file contains
only direnv loading lines, no wait result and no error. `kteam status brody`
immediately after: running fine, turn 1.

**Ambiguity (logged for pattern-matching, not as a confirmed kteam defect).**
Cannot distinguish from here whether (a) the harness/babysitter side killed the
background task, or (b) the `kteam wait` client process itself died (e.g. a
long-poll/reconnect limit, or the `[Bun.serve] idleTimeout`-adjacent long-request
path in the daemon dropping a >1h waiter). If other sessions see long `kteam
wait`s dying near the ~60-66 min mark while shorter ones survive, suspect the
daemon's long-poll handling in the wait route (client `wait` → api long-poll)
rather than the caller. Workaround: re-arm the wait (it is idempotent) and
never rely on a single long-lived wait as the only completion signal — pair it
with a periodic `kteam ps` check.

_(Babysitter observation in automode, coordination dir ms3i5j7q-688df4a8.
Append-only; wait re-armed; no other action.)_

## `kteam send` to a finished peer refused: label-successor guard blocks reply delivery (2026-07-27)

**Problem.** A teammate cannot deliver a message to a peer whose session has
ended when the SENDER holds the same label. `kteam send corey "…"` (corey =
ms3ir8n1-09368f95, label ui-round26, by then finished) failed with:
`kteam: refusing to revive session ms3ir8n1-09368f95: live successor pamela
(ms3jmqn0-5d673ceb) already owns label ui-round26 in /home/kirin/.config/
home-manager; continue there or stop it first`. The same send had worked
minutes earlier while corey was still running — messages were exchanged both
ways — so mid-collaboration the channel silently became one-way the moment
corey's TUI stopped.

**Evidence.** Exit code 1 with the message above; earlier sends to the same
name in the same session succeeded (`queued in the TUI's native queue`).

**Suspected code path.** `modules/kteam-ts` send/resume logic: `kteam send` to
a stopped session falls through to an implicit `resume`, and resume has a
same-label/same-cwd successor guard. The guard treats the sender itself as the
"live successor" and refuses. Sender identity ≠ successor: a peer message
should either queue durably to the dead session's inbox without reviving it, or
the guard should exclude the requesting session.

**Workaround.** Route the information through the lead (`kteam send zelda`)
or write to a file the peer's successor will read. If the reply matters, send
it BEFORE the peer finishes.

_(pamela, automode, coordination dir ms3jmqn0-5d673ceb.)_

---

## 2026-07-27 ~18:45Z — claude resume path: relaunch `--resume <harnessSessionId>` dies with "No conversation found" when turn 1 never persisted a conversation (killed 3 sessions on the same task)

**Problem.** Three consecutive sessions given the notifications design task —
ms2e9eea-4e93c9f0 (2026-07-26T22:53Z), ms2fdimo-e21072eb (23:24Z),
ms2ro63p-17d36e29 (2026-07-27T05:08Z) — all `failed` at turn 2-3 with reason
"interactive claude exited; exit code unavailable after confirmed re-probe; no
final pane output captured", zero tool calls, zero artifacts. Surfaced by brody
(ms3i49gv), who inherited the task on the 4th attempt and succeeded; he left
the log entry to the watcher. Verified by me from the preserved session dirs.

**Evidence.**

- All three `state.json`: status=failed, turn=2/3, the harness-exit reason above.
- ms2e9eea's `last-snapshot.txt` contains the actual pane output:
  `No conversation found with session ID: 47631b76-e0b2-4967-8c79-ac11cbcaf9ff`
  — and that UUID is exactly `config.harnessSessionId`.
- `session-manager.ts:2608` then records "failed resume cleanup".

**Code path.** `core.ts:899-900`: turn 1 launches claude with
`--session-id <uuid>` (freshly minted at `session-manager.ts:1357`); every
relaunch (turn >= 2, i.e. resume/nudge/retry) switches to
`--resume <same uuid>`. If the turn-1 process exits before the harness
PERSISTS a conversation under that id (crash at startup, quota bounce, wrapper
error — anything pre-first-message), the id exists in kteam's config but no
conversation exists on the claude side. Every subsequent relaunch then runs
`--resume <missing>` → instant "No conversation found" exit → monitor kills →
retry relaunches with the SAME id → same instant death. The session
crash-loops to `failed` without ever getting a second chance at a real start.
Same-task retries as NEW sessions (new uuid) hit the same fate only if the
underlying turn-1 crash recurs — which it apparently did twice more that
night; by 17:29Z today the same brief launched fine (brody).

**Suspected fix direction.** On a resume failure whose pane output matches
"No conversation found with session ID", fall back to a FRESH
`--session-id` launch (mint a new uuid, keep the kteam session) instead of
terminalizing — the conversation provably has nothing to lose. Detection is
cheap: the string is already in the captured final frame that
`harnessExitReason` reads (`session-manager.ts:2350-2360`).

**Workaround.** None from inside a dead session; start a fresh session for
the task. If a teammate dies at turn 1-2 with "exit code unavailable … no
final pane output", check its last-snapshot for this string before assuming
the task/brief was at fault — the task never ran.

_(Babysitter diagnosis in automode, coordination dir ms3i5j7q-688df4a8, from
brody's report + preserved state/snapshots of the three dead sessions.
Append-only; no commit, no fix.)_

---

## 2026-07-27 ~20:50Z — ESCALATION of the 18:05Z label-successor entry: the guard now BLOCKS REVIVAL of a genuinely stalled session (recovery, not just messaging)

**Update to "`kteam send` to a COMPLETED session is undeliverable…" (18:05Z).**
Same root cause, second and materially worse manifestation. The impact line
should now read: **blocks revival of stalled sessions**, not just "final
handover undeliverable".

**What happened (zelda's report, reproduced by me at 20:49Z).** Session evan
(ms3myvmx-31e46764, label ui-round28) STALLED with zero life-signs for 302s
(nudge did not revive it; 3 native-queued sends unconsumed). `kteam resume
evan` — the designed recovery action for exactly this state — is REFUSED by
the successor guard. There is no CLI override; the only ways out are stopping
an unrelated live teammate or respawning evan's task as a NEW session under a
different label, losing the stalled session's conversation context.

**Confirming detail (new evidence, from my repro).** The named "successor" is
ARBITRARY: zelda's attempt was refused citing sophia (ms3moxcz), mine minutes
later citing gretchen (ms3mf453) — both merely live sessions sharing label
ui-round28 + cwd (there are SIX live ui-round28 sessions right now; any of
them blocks evan). This is `liveSuccessorFor` (session-manager.ts:2371)
returning the first non-terminal label+cwd match in recency-sorted cache
order — direct proof the guard matches "same batch", not "same work": evan
(dictation task) vs gretchen (markdown overlay) vs sophia (browser streaming)
are disjoint tasks.

**Why the guard misfires here by its own design intent.** Its doc comment
says it refuses resurrection when "another live teammate already owns the
same labelled work" — the warden crash-revive dedupe case, where a respawned
REPLACEMENT owns the dead session's task. In fan-out batches (the documented
`--label` = batch-slug convention) label+cwd NEVER implies same work. resume()
is the convergence point for send-revive, control auto-revive, quota wake,
retry, AND manual `kteam resume` — so the lead's explicit recovery command
inherits a guard meant for automated dedupe.

**Severity.** Was: annoyance (message bounce, resume-then-send workaround
existed). Now: a stalled session in any multi-teammate batch is UNRECOVERABLE
by normal means while any sibling lives — in a busy fleet that is essentially
always. Priority should move from nice-to-have to urgent. Fix directions from
the 18:05Z entry stand (lineage-scope the guard — teammate name or recorded
predecessor link — or add an explicit override for the manual resume path).

**Live specimen — do not clean up.** evan's session dir
(~/.kteam/ms3myvmx-31e46764) additionally holds 3 native-queued unconsumed
sends (19:57:53/19:58:03/19:58:14Z in channel/inbox.jsonl); zelda handed that
to juan (ms3n5aeg, "Queued Message Vanishes") as a live specimen. Leave the
directory untouched.

_(Babysitter verification in automode, coordination dir ms3i5j7q-688df4a8.
One `kteam resume evan` repro attempt (refused, side-effect-free). Append-only;
no commit, no fix, no cleanup of evan.)_

---

## 2026-07-27 22:58Z — `wt merge` is a live-fire hazard in a shared checkout: it staged all 35 dirty paths before the commit hook stopped it

**Incident.** A peer report was passed to `kteam send` as an inline,
double-quoted shell argument containing Markdown backticks. The shell treated
the backticked text `wt merge` as command substitution and invoked Worktrunk's
default merge pipeline in `/home/kirin/.config/home-manager`, where roughly 20
agents shared one dirty checkout.

**Impact, verified twice.** `wt merge` staged every dirty path it saw: 35 files
from unrelated browser, quota, dictation, analytics, and problem-log work. It
then attempted a commit. The repository's pre-commit treefmt hook failed after
formatting six files, which stopped the pipeline before any commit, ref move,
merge, rebase, branch deletion, or worktree removal. Recovery unstaged the exact
35-path set without changing working-tree bytes. `HEAD`, branch, reflog,
worktree inventory, and operation state remained unchanged; the formatter-only
edits were deliberately kept because treefmt is idempotent and every owner
would receive them on commit anyway.

**Why this matters beyond the quoting bug.** A periodic “completed worktree”
scanner must never call an interactive merge helper, `git add`, or `git commit`.
In a shared checkout, a single mistaken merge invocation can sweep many agents'
unrelated, unreviewed work into its commit before a later hook gets a chance to
object. This run was harmless only because the hook failed. The safe design is
automatic read-only discovery and evidence collection, PR preparation/babysitting,
and a human merge; no timer mutates the target checkout.

**Workaround / prevention.** Put Markdown or any message containing backticks,
`$()`, globs, or shell metacharacters in a file and use `kteam send
--message-file`; never interpolate it into a shell command. For native kteam
worktree support, persist intent before creation, isolate each agent by branch,
and keep the completion scanner report/PR-only.

_(ida, session `ms3pu7yd-f872cb8e`; incident report and exact pre-hook blob ids
are under that session's coordination directory.)_

---

## 2026-07-28 00:26Z — three warden invariants are not enforced (scratch retention, self-signal scope, same-sweep concurrency)

Read-only tracing for Codex warden support found three **harness-neutral**
warden defects. They are recorded here rather than fixed in that task because
the affected daemon files are contended and each deserves an independently
scoped repair.

### Assigned targets are not actually protected from scratch GC

**Intended invariant.** A session under an assigned warden must retain its
scratch because the warden is about to read that session's durable files.

**Code mismatch.** `modules/kteam-ts/src/session-manager.ts:6049-6057`
implements `hasLiveWarden(targetId)` by looking for a live warden whose
`config.parent === targetId`. But assigned wardens are spawned at
`session-manager.ts:6516-6525` without a `parent` field; their authoritative
target association is instead persisted under `wardenState.assignments`.
Consequently the GC predicate cannot recognize a normally assigned target and
may reclaim eligible scratch while its warden is live.

**Fix direction.** Consult `wardenState.assignments[targetId].wardenId` (and
verify that warden remains non-terminal), or explicitly persist the target
relationship in a dedicated config field. Do not overload ordinary teammate
parentage unless assigned wardens are meant to appear as children of targets.

### The shared scoped token can signal any warden-labelled session done

**Intended invariant.** A warden may run `kteam signal done` only for itself.

**Code mismatch.** The scoped-token gate at
`modules/kteam-ts/src/api-server.ts:124-131` resolves the requested target and
allows the signal whenever `target.config.label === WARDEN_LABEL`. It never
compares that target id with the calling warden's `x-kteam-session-id`.
Because every warden pane receives the same scoped bearer token, one warden can
therefore mark a different live warden completed. The session-id header is
currently actor attribution, not authorization.

**Fix direction.** Require the authenticated warden session id to equal the
resolved signal target (and retain the label check). Add a negative test using
two labelled sessions under the same scoped token.

### Assigned spawn and fleet escalation reuse a stale session snapshot

**Intended invariant.** `maxAssignedWardens: 1` means at most one live warden
across assigned and fleet-sweep duties.

**Code mismatch.** `sweepOnce` takes one `sessions` snapshot, then awaits
`spawnAssignedWardens(...)` and calls `maybeEscalate(..., sessions, ...)` with
the original snapshot (`session-manager.ts:6279-6285`). `maybeEscalate` counts
live wardens only from that stale array (`:6655-6663`), so it cannot see the
assigned warden that the immediately preceding await just created. If the same
sweep contains both assigned and triage anomalies, both spawn sites can each
observe one free slot and launch, exceeding the shared cap.

**Live demonstration.** With persisted `maxAssignedWardens: 1`, the daemon
created assigned warden Miranda (`ms3vk51q-98c39dec`, `warden:gloria`) at
`2026-07-27T23:45:21.816Z` and fleet warden Aspen
(`ms3vkpz0-ff6ef828`, `warden-sweep`) at
`2026-07-27T23:45:48.979Z`. Both remained simultaneously live until the Codex
warden experiment stopped them; both had zero report/work and were wedged only
on the provider-wide Claude credential cooldown. The two-pane state was not a
configuration mystery: it is the same-sweep stale read described above.

**Fix direction.** Refresh the live warden count after assigned spawns (or
carry the returned spawned ids into the second gate) before calling fleet
escalation. Pin one test where a single sweep has both anomaly classes and cap
1; exactly one warden may start and the other work must remain queued/suppressed.

_(Linda, session `ms3wfazx-e3f00d06`; traced independently by Dakota
`ms3wkmyk-111d22de`; append-only diagnosis, no daemon fix.)_

## Cross-harness migrate is refused, so a 429'd Claude session can only be relaunched (context is discarded)

**Problem.** When an Anthropic-backed session is hard-blocked on
`API Error: Request rejected (429) · All credentials for model <m> are cooling
down via provider claude`, the only remedy is moving it to a Codex model
(different provider). `kteam migrate` cannot do this: it is documented as
"continue a session on another same-kind account" and explicitly refuses
claude -> codex. `kteam restart` is also not a remedy — it respawns the same
TUI on the same model/harness, so it 429s again immediately.

The consequence is that every claude -> codex move is a **full relaunch**, which
discards all accumulated turns. The cost is not uniform: moving a session at
turn 1 is free, moving one at turn 64 destroys a large amount of real work.

**Evidence.** 2026-07-28, provider-wide Anthropic cooldown. 32 live sessions
were hard-429'd (26 under lead zelda `ms1lhymf-c4051f31`, 1 under noel
`ms1m06zd-6868d3cf`, 5 orphaned). Session alina `ms2uvvca-0c62c9f6` was at
turn 64 with a 29 KB `summary.md` when its credentials died. It could not be
migrated; noel had to stop it and start hank `ms3xx4jg-315a28fe` on
`codex-auto-loge` / gpt-5.6-sol as a brand-new session.

**Workaround that worked (do this, not a bare prompt replay).** noel wrote the
successor a handover file pointing at three things in order: (1) the original
`prompt.md` unchanged, (2) the predecessor's `summary.md` — which contained six
numbered findings, several of them _retractions of her own earlier answers_, so
the successor was told explicitly to read the retractions and not only the
conclusions, and (3) the standing contract. noel also wrote in the delta that
existed nowhere in `summary.md` (branch landing state, a reverted grpc bump, a
known-red package, and a worktree ruling). The successor's first action was set
to _report what it believes the remaining scope is_ for confirmation — NOT to
resume — because resuming from an assumption about where a mid-flight
predecessor stopped is how a successor invents work or silently drops it.

**Suspected code path.** `modules/kteam-ts` — the `migrate` command's
same-kind/account guard, and the absence of any harness-crossing resume path
that could replay transcript context into a different harness. A cheap
improvement would be a first-class "relaunch on another harness with a
generated handover" command, so the handover discipline above is not
re-invented by hand per incident.

**Also worth noting.** `kteam ps` surfaces no 429 signal at all: the daemon's
`state.quota.atLimit` flagged only 2 of the 32 blocked sessions. The reliable
detector was grepping `~/.kteam/<id>/last-snapshot.txt` for the literal
`API Error: Request rejected (429)`. Looser greps for `quota`/`rate limit`
produce heavy false positives, because the pane status bar prints quota on
every session.

_(Reported by noel `ms1m06zd-6868d3cf` after the alina -> hank move; logged by
josiah `ms1linkw-57900cdb` on the human lead's session.)_

## kteam start: stale credential-rejection cache (2026-07-27 PT)

`kteam start` refuses a wrapper with "credentials were rejected (kfleet usage reports
auth failure)" even after the key is rotated and EVERY live source is healthy:
`kfleet usage` table shows ✓ for all four glm52 wrappers, `kfleet usage --json` shows
`ok=true authOk=true error=none`. The rejection persisted across a daemon restart and
across `kfleet apply`. So kteam is consulting a cached/stale auth verdict somewhere
other than kfleet's current output — location unknown (nothing in
~/.kteam/daemon/config.json). Effect: an account stays unusable indefinitely after a
single auth failure, even once fixed. Repro: reject a z.ai key, rotate it, `kfleet
apply`, `kteam start --agent claude-auto-glm52a ...` → still rejected. Needs: kteam
to re-query kfleet at start time or expose a cache-clear.

## `kteam wait --until` exits 0 on an invalid flag (looks like success)

**Problem.** `kteam wait <id> --until 180m` printed `error: unknown option '--until'` and exited
**0**. The lead's background-job harness reported "completed (exit code 0)" for both waits, which
reads as "the agent finished". Neither agent had even started its first edit.

**Evidence.** 2026-07-28 ~05:42, sessions `ms48a90j-0d9b6658` and `ms48afih-53ad36c9`. Both waits
returned instantly; `kteam ps` showed both still `running`. `--until` is real on `kteam send --ask`,
which is where the confusion comes from — it is not a `wait` option.

**Why it matters.** A lead who arms waits and then trusts the completion notification will believe
work finished that never started. This is the same trust failure as `completed` being a claim, but
worse: there is no summary.md to catch it, because nothing ran.

**Suspected code path.** `modules/kteam-ts/src/*-cli.ts` argument parsing — commander is presumably
configured without `.exitOverride()` / with a handler that swallows the unknown-option error, or the
process exit code is not propagated from the parse failure.

**Fix direction.** Unknown-option and parse failures should exit non-zero (commander's default is 1).
Consider also rejecting `--until` on `wait` with a pointer to `--timeout`, since the two are easy to
confuse and the failure is silent.

**Workaround.** `kteam wait <id> --timeout <seconds>`. Verify the wait is really watching by checking
the job is still running after a few seconds rather than trusting the completion event.

## A teammate cannot claim files on the lead's task record

**Problem.** Task records are per-session and an agent may only write its own. When a lead grants a
teammate ownership of a file, the teammate's `kteam task file …` is rejected — `an agent may only
change tasks in its own session` — so the claim can only be filed by the lead. Every grant needs a
round-trip even after the decision is made.

**Evidence.** 2026-07-28 ~05:46. fredricka (`ms48afih-53ad36c9`) was granted
`ui/src/components/TranscriptRow.tsx` against `#F38` (owned by `ms1lhymf-c4051f31`), attempted the
claim, was rejected, and had to ask the lead to run it.

**Why it matters.** File claims are the mechanism that stops concurrent teammates clobbering each
other in a shared working tree — the single most expensive failure mode in this session. Making the
lead the only writer puts the claim on the slow path exactly when contention is highest, so claims
get skipped and the map goes stale. The enforcement is correct in spirit (records are per-session,
provenance should be unforgeable); the ergonomics defeat the purpose.

**Suspected code path.** `modules/kteam-ts/src/tasks-cli.ts` / `tasks-api.ts` session-ownership check
applied uniformly to every mutation, including `file`.

**Fix direction.** `file` is already documented as ADVISORY, never a lock — so it does not need the
same write protection as `status`/`phase`. Either let any session append a file claim stamped with
its own resolved actor (the pins provenance pattern: the claim records WHO claimed, unforgeably), or
add an explicit delegation so a lead can grant a session write access to one record.

**Workaround.** The teammate takes the grant and proceeds; the lead files the claim behind them.

## `status.showuntrackedfiles=no` hides new files from every landing list

**Problem.** The home-manager repo has `status.showuntrackedfiles=no` in its LOCAL git
config. `git status` and `git status --porcelain` therefore show **zero** untracked files.
Every agent that builds a landing list from `git status` — which is all of them — silently
omits every new file it created. The omission is invisible: the list looks complete, the
focused tests pass (they run against the working tree, where the files exist), and the gap
only appears when someone builds from a clean checkout.

**Evidence.** 2026-07-28 ~06:20. Landing four verified lists at HEAD `e7a3ead` produced 34
test failures in a detached release worktree, all from two unresolvable imports:
`./tasks-workflow` (imported by the committed `tasks-store.ts`, `tasks-contract.ts`,
`tasks.ts`, `tasks-cli.ts`) and `./provider-outage` (imported by the committed
`session-manager.ts`). Both modules existed on disk and passed their own tests (40/0) but
were untracked. `git status --porcelain | rg -c '^\?\?'` returned nothing;
`git status --porcelain -uall | rg -c '^\?\?'` returned **25**.

Two of the 25 were required by already-committed code, so HEAD was red the moment the
lists landed. Fixed in `c01c40a`.

**Why it matters — this is the root cause of a pattern, not a one-off.** Earlier in this
same session the lead committed the wrong file set FIVE separate times, each caught only by
the clean-worktree release gate and each attributed at the time to carelessness in staging.
It was not carelessness. It is this config. Any workflow where an agent reports "these are
my changed files" is systematically wrong for new files, and the error is undetectable
without either `-uall` or a clean-checkout build.

It also masks unlanded features. The 25 include eight `terminal-*.ts` modules (the web
terminals feature) which are NOT imported by any committed file — the feature has been
running only because kteamd executes from source in the working tree, so untracked files
work fine locally while not existing in git at all.

**Suspected code path.** Not kteam code — repo configuration. Probably set to quieten
`git status` noise from build artifacts (`tsconfig.tsbuildinfo` and
`.kteam-prob-triage.md` are in the hidden set).

**Fix direction.** Remove `status.showuntrackedfiles=no` and instead `.gitignore` the
artifacts that motivated it. Hiding untracked files to reduce noise trades a small
annoyance for a silent correctness failure in every landing.

**Workaround until then.** Every agent must use `git status --porcelain -uall` when building
a landing list, and every release must build from a detached worktree — that gate is the
only thing that caught this, five times, before it reached a deploy.

## One file with two owners silently lands the other owner's half-done work

**Problem.** `src/session-manager.ts` was edited concurrently by two teammates: carol
(send-ledger reconciliation) and baruch (provider-outage detection). carol's landing list
named the file, and her gates were green — so the file landed carrying BOTH sets of edits.
HEAD then contained baruch's provider-down CALL SITES without his TYPES, which lived in
files nobody had released.

**Evidence.** 2026-07-28 ~06:50, HEAD `f7298f7`. `tsc -b` in a clean worktree:
`WardenConfig.providerOutage` missing (session-manager.ts:6971, 7901-7958), then after
landing `daemon-config.ts`, `AgentUsage.unavailable / .retryAt / .unavailableReason`
missing (session-manager.ts:6437-6463). Each fix exposed the next link. The feature
actually spanned 17 kteam-ts files plus 15 more across kfleet-ts and kloge-ts.

**Why it matters.** The owning teammate's gates cannot catch this — carol correctly
verified HER change, in a tree where baruch's edits were also present, so everything
passed. The contamination is invisible to both owners and to the lead reviewing either
list. It only appears in a clean checkout, and then it appears as a CASCADE: fixing one
missing type reveals the next, which tempts the lead into landing an unreleased feature
file-by-file to chase compiler errors. That is how half-finished features ship.

The escape here was asking the feature's owner for an explicit ready/not-ready boundary.
His answer — "the kteam detector portion is ready, here is its complete dependency list;
the kfleet feed is NOT ready; if you need HEAD green sooner, revert my call sites instead"
— was the only thing that prevented shipping unreviewed security fixes (a generated 0600
management key and a redacted CLIProxy state projection) as collateral.

**Suspected code path.** Not a code defect — a coordination gap. kteam has advisory file
claims (`kteam task file`) that would have surfaced the double ownership, but claims are
optional, and only the record's own session may write them (see the earlier entry), so in
practice they are frequently skipped.

**Fix direction.** Make file claims cheap enough to be habitual, and have the daemon WARN
when two live sessions claim the same path rather than silently accepting both. A lead
accepting a landing list should be able to ask "does any other live session claim these
paths?" and get an answer.

**Workaround.** Before accepting any landing list that includes a file touched by more than
one live session, ask each owner for an explicit ready/not-ready boundary and their
complete dependency list — including files they do not consider "theirs". Verify the
proposed set in a detached worktree BEFORE committing, never after.

## STANDING PATTERN: parsers tuned to one harness are silently wrong on the other

**Three independent instances found in a single session, 2026-07-28.** Each had green tests
on both sides and each was invisible until someone deliberately checked the OTHER harness.

1. **Codex compaction records discarded before classification.** The transcript normalizer
   accepted conversation only from `response_item` records. Codex writes its replacement
   summary as a top-level `{"type":"compacted","payload":{"message":…}}` record, so the
   whole thing was dropped before the UI classifier ever ran. Claude's path worked, so the
   feature looked fine.

2. **Claude compaction summary extracted the wrong line.** The extractor took the first
   line after `Summary:`, which in Claude's real output is the structural heading
   `1. Primary Request and Intent:` rather than the content beneath it. It "worked" — it
   just showed a heading.

3. **Question option matching returned `menu_unbound`.** Claude draws its preview panel's
   TOP border on the same physical row as the first wrapped option label
   (`zinc endpoint + argon        ┌─────…`). The parser removed right-panel content
   beginning with `│`, but the top row begins with `┌`, so the border survived as label
   text and no option ever matched. Checking the other harness then revealed a SECOND,
   unrelated hole: Codex 0.145.0 renders `Option 1  First choice.` with the description in
   a space-aligned second column, which was also being read as label text.

**Why this keeps happening.** Whoever writes the parser has one harness in front of them.
Tests are written from that harness's real output, so they pass. The other harness's shape
never appears in any fixture, so nothing fails. The symptom is not a crash — it is a
silently dropped record, a wrong-but-plausible string, or a match that never binds. All
three above shipped and stayed shipped.

**Standing rule for this codebase.** Any change to a parser, normalizer, classifier or
matcher must be checked against BOTH Claude and Codex real output before it is considered
done, and must carry a real captured fixture for each. Treat "I only had one harness's
output" as an unfinished change, not a limitation.

**Cheap detection.** For every such module, assert that a real fixture from each harness
produces a sensible result. Synthetic strings written from the author's own assumptions
prove nothing here — that is precisely how all three survived their test suites.

## An escape route must not share a dependency with the thing it escapes

**Problem.** Structured questions could reach a state with no way out: the answer failed
with `menu_unbound`, and abandon/cancel ALSO failed, because cancel-preflight depended on
the same menu binding as answering did. `pendingQuestion` was never cleared, which keeps the
composer hidden. The human could not answer, could not cancel, and could not type.

**Evidence.** 2026-07-28, live admin-ui question. The UI POSTed the correct `{responses}`
payload; the daemon rejected with `menu_unbound`; every subsequent click-abandon failed
cancel-preflight; `pendingQuestion` remained set. Fixed in `fe4759a`.

**The generalisable point.** The recovery path was implemented in terms of the same
mechanism as the primary path, so a single broken matcher took out both at once. Any
"escape hatch", "cancel", "force release" or "recover" path should be audited for shared
dependencies with what it is meant to rescue — including on the client side, where an
optimistic local dismissal that is reconciled by a server round-trip will snap back the
moment that round-trip is the thing failing.

**Fix shape used.** Server: a bound-abandon path independent of the matcher, which clears
pending state even when the cleanup keystroke cannot be confirmed, journals the
unconfirmed release, and never synthesizes an answer. Client: suppress locally keyed by
`toolUseId` so the composer mounts immediately, reconciling in the background.

## FIVE shared-type breaks in one afternoon — the ownership model has a structural hole

**Update to the earlier entry.** What was logged as a two-instance pattern reached FIVE in a
single afternoon, across four different teammates. Every one blocked the entire fleet,
because `tsc -b` builds the whole project and is the required gate for everybody.

1. ottis widened `ManagedBrowserRuntime` (methods returning a snapshot instead of `void`);
   `FakeBrowserRuntime` in `api-server.test.ts` still returned `void`. Blocked rianna.
2. mileena added `assigneeSessionId`/`assigneeName` to `TaskLive`; three fixture files
   broke, one of them deny-listed to her. Blocked the fleet.
3. ottis assigned `() => service.stop(...)` to a `() => Promise<void>` handler, implicitly
   returning a value. Blocked emari, terran and darl.
4. emari left `BARE_NAMED_RESULT_BUDGET` declared and unused (TS6133). Blocked darl.
5. terran widened `WardenAttentionView` (`verdictCoverage`) and the status shape
   (`needsHumanKind`); three fixtures went stale. Blocked emari and darl.

**The structural hole.** File-level ownership assumes changes are file-local. A TYPE change
is not — its blast radius is every construction site, and those sites live in files the
type's owner is forbidden to edit. So the deny list, the very mechanism preventing
collisions, is what makes each break unfixable by whoever discovers it. In all five cases
the blocked teammate did exactly the right thing and still lost time.

**What worked.** mileena's resolution was the cheapest by a wide margin: make the new fields
OPTIONAL-but-nullable. Zero fixtures changed, no cross-owner hunk, no round trip through the
lead. Every other case required the type's owner to be interrupted and to edit files in two
or three ownership domains.

**Rules to adopt.**

- Before landing a type widening, grep EVERY construction site. If any sits in a
  deny-listed file, prepare that hunk and route it BEFORE landing, not after a gate goes red.
- Prefer OPTIONAL fields wherever absence is legitimate. This is the same principle as
  returning 404 for a missing provider so older clients degrade honestly — applied to types
  instead of routes.
- Consider shared fixture BUILDERS so a type gains a field in one place rather than in N
  test files owned by N people. This would have prevented 2, 3 and 5 outright.
- A lead should accept a blocked teammate's focused tests plus a scoped typecheck rather
  than holding them behind someone else's breakage, and route the repair immediately.

## `kteam pin` swallows unknown subcommands as note text (2026-07-28, niccole / ms54o28u-789798b3)

**Problem.** The pin passthrough CLI treats ANY first argument that is not `add`/`ls`/`rm` as
the note body. `kteam pin help` — the natural way an agent probes a passthrough verb —
silently creates a pin whose content is the word "help".

**Evidence.** Ran `kteam pin help` while inventorying the CLI surface for the #F91 skill
design; got `pinned — 1 pin(s) in ms54o28u-789798b3`, and `kteam pin ls` showed
`9978a270  note  [agent niccole]  help`. Cleaned up with `kteam pin rm 9978a270`. Sibling
passthroughs are inconsistent: `kteam task help` and `kteam browser help` correctly reject
with `unknown … command "help"` + usage; bare `kteam attention` prints usage.

**Suspected code path.** `modules/kteam-ts/src/pins-cli.ts` — the default branch of the
subcommand dispatch falls through to "add note" instead of reserving unknown single-word
commands (compare the guard in `tasks-cli.ts` / `browser-cli.ts`).

**Workaround.** Probe pin usage with bare `kteam pin` (no args — prints usage without
mutating); if `help` was pinned by accident, `kteam pin ls` then `kteam pin rm <id>`.
Cheap fix: reserve `help`/`--help` (and maybe any single known-verb-like token) in the
pin dispatcher before treating input as note text.

---

## `kteam wait` exits 0 when the DAEMON is unreachable — a lost daemon looks like a finished session

**Date:** 2026-07-29
**Session:** `jaison` `ms5ax87p-774fdec3` (codex-auto-loge / gpt-5.6-sol, label `kfleet-login-ux`)
**Reported by:** josiah (lead, `ms1linkw-57900cdb`)

**Problem.** A backgrounded `kteam wait ms5ax87p-774fdec3` terminated with **exit code 0**,
which the harness surfaced as "Background command completed (exit code 0)" — the
canonical signal that the awaited session had finished. It had not. The session was
still `tool_running` on turn 1 at the moment `wait` returned.

**Evidence.** The wait job's captured output was not a completion report at all:

```
kteam: kteam daemon is unavailable at http://127.0.0.1:7337 (Unable to connect.
Is the computer able to access the url?); run `kteam daemon start`
```

Yet the process exited 0. Immediately afterwards `kteam status ms5ax87p-774fdec3`
succeeded and showed:

```
jaison (ms5ax87p-774fdec3)  tool_running  codex-auto-loge  model=gpt-5.6-sol
  context 84% used  last tool started 2026-07-29T00:36:56.690Z
```

So the daemon had recovered by then — the unavailability was transient — but `wait`
had already given up and reported success.

**Why this matters.** `kteam wait` is the primitive the whole fleet uses to gate on
"is this teammate done". CLAUDE.md tells leads to prefer `wait` over polling. If a
momentary daemon blip converts into exit 0, a lead will read a still-running session
as complete, inspect an unfinished worktree, and report half-finished work upward as
done. This is precisely the false-completion failure mode the "verify, don't trust"
rule exists to catch — except here the _waiting primitive itself_ is the liar, so the
usual defence (read summary.md) also fails, because summary.md is simply absent
(empty) on a session that has not finished.

**Suspected code path.** `modules/kteam-ts` — the `wait` CLI command and whatever HTTP
client it uses to reach `http://127.0.0.1:7337`. The transport/connection error is
being caught, printed as a human-readable message, and then falling through to the
normal (success) exit path instead of exiting non-zero. Two distinct defects:

1. **Wrong exit code.** A daemon-unreachable error must exit non-zero. "I could not
   determine the outcome" and "the outcome was success" must never share exit 0.
2. **No reconnect.** A transient daemon blip should be retried with backoff rather
   than abandoning the wait outright — the daemon was demonstrably back within
   seconds, and the session ran on for a long time afterwards.

Worth auditing every other `kteam` subcommand for the same swallow-and-exit-0 shape.

**Workaround.** Do not trust a returning `kteam wait`. After it returns, re-check
`kteam status <id>` and confirm the state is genuinely terminal before believing the
session is done, and re-arm the wait if it is not. Gating on a deliverable
(`kteam wait <id> --until-marker <file>`) is more robust than gating on the daemon's
liveness view, but note it likely shares the same exit-code bug.

## a-gitlint hook cannot run in a git worktree (2026-07-29)

**Problem.** The `a-gitlint` pre-commit hook fails in every git worktree with
`Error: Invalid value for '--msg-filename': '.git/COMMIT_EDITMSG': Not a directory`
(exit 253). In a worktree, `.git` is a _file_ containing a gitdir pointer, not a
directory, so the hardcoded relative `.git/COMMIT_EDITMSG` never resolves.

**Why it matters.** The house rule is that every landing goes through a clean
detached worktree. That makes this hook dead for all agents on every commit —
so commit-message linting is silently not happening on the path we actually use.

**Evidence.** Landing #F102 from `wt-f102`: `Secrets sync`, both `Secrets
Scanning` hooks and `treefmt` all passed; only `Gitlint` failed, with the error
above. Running `gitlint --msg-filename <file>` directly on the same message
exits 0.

**Suspected fix.** The hook should resolve the git dir rather than assume
`.git/` is a directory — e.g. `$(git rev-parse --git-path COMMIT_EDITMSG)`,
which is worktree-correct.

**Workaround used.** Validate the message with `gitlint --msg-filename` directly,
then commit with `SKIP=a-gitlint`. Do NOT use `--no-verify` — that would also
disable the secrets hooks.

## Secrets-sync hook gives a false positive under `git commit --only` (2026-07-29)

**Problem.** `a-secrets-sync` blocks with "secrets.yaml is out of step with
secrets.enc.yaml" even when `scripts/secrets/check.sh` run directly exits 0 and
`encrypt.sh` reports "already in step — skipping (no churn)".

**Cause.** `git commit --only <paths>` builds a partial index, so pre-commit
stashes everything outside that set. `secrets.enc.yaml` is reverted to HEAD,
while `secrets.yaml` is gitignored and therefore _not_ stashed — so the hook
compares HEAD's ciphertext against the edited plaintext and always sees drift.
`git add secrets.enc.yaml` does NOT help: `--only` excludes it from the tree
being committed, so it is stashed regardless.

**Workaround.** Commit from a clean worktree. `secrets.yaml` is gitignored and
never copied there, and `check.sh` exits 0 when the working copy is absent —
so the hook passes honestly rather than being bypassed.

## `kteam send` fails to a session that is PARKED waiting for that very reply (2026-07-29)

**Problem.** `kteam send <peer>` failed three times in a row with
`kteam: interactive harness did not become ready within 30s; last frame:
promptReady=false, cursor=2:47`, addressed to a session whose own status read
`⏸ DECLARED WAIT: reply from zelda until 2026-07-29T02:38:32.118Z — parked on
purpose`. Nothing landed in `channel/inbox.jsonl` on any of the three attempts.
A fourth identical attempt ~90s later succeeded immediately.

**Why it matters.** The parked session was blocked on precisely the reply that
could not be delivered, and would have timed out at the deadline having received
nothing. The lead has no signal that delivery failed other than reading the
inbox file directly — and the error text ("harness did not become ready")
describes a _startup_ condition, not a delivery failure, so it reads as
transient noise rather than "your message was dropped".

**Evidence.** Session `ms598p60-3602abe6` (refugia, codex-auto-loge, gpt-5.6-sol,
`turn 1`, `context 6% used`). Failures at ~02:27–02:28 UTC; success at 02:29:13.
Message size was not the cause: a ~3KB message and a ~250-byte message both
failed, and the same ~250-byte message then succeeded unchanged.

**Suspected cause.** The send path waits for an interactive prompt to be ready,
but a codex session in a declared wait presents no ready prompt — so the
readiness probe and the parked state are mutually exclusive. Likely a
`promptReady` gate in the send path that should be bypassed (or satisfied
differently) when the target is in a declared wait.

**Workaround.** Retry the send; it succeeded on the next attempt. ALWAYS verify
delivery by tailing `~/.kteam/<id>/channel/inbox.jsonl` — the CLI's failure
message does not distinguish "not delivered" from "transiently noisy".

## Tasks side pane never leaves "Loading tasks…" on a busy fleet (jakiya, #B43, 2026-07-29)

**Problem.** With ~50 sessions live, opening the session side pane's Tasks
surface showed "Loading tasks…" indefinitely — the surface never rendered a
single task even though `/v1/tasks` returned 200 with all 65 records.

**Evidence.** Playwright against a temp Vite proxying the live daemon
(`ms5eojft-50784d8f/proof/`): `/v1/tasks` took ~13.9s for 245KB (curl direct,
same result), while `tasks.updated` fleet events arrived every few seconds.
Each event re-triggered `load()`, which bumped a generation counter that
DISCARDED the previous in-flight response on arrival. Response always
superseded → applied never → perpetual loading.

**Suspected code path.** `modules/kteam-ts/ui/src/components/SessionTasks.tsx`
`SessionTasksSurface.load()` (the `seq.current !== generation` early return),
fed by `useFleetEvents(tasks.updated)`.

**Fix (landed with #B43).** Replaced discard-on-supersede with
`coalesceLoads()`: one request in flight, event storms coalesce into exactly
one follow-up, every completed response is applied. Safe because the fleet
task list is session-independent. Verified against the live busy daemon.

**Still open (backend).** ~14s to serve 245KB of tasks is the underlying
smell — `/v1/tasks` appears to contend with whatever the busy daemon is doing
(the same box serves sub-second when idle: a throwaway daemon with the same
65-task tasks.json answered in 0.36s). Worth profiling the aggregate route's
live-liveness enrichment under load.

### Follow-up (same day): the parked-send failure is a correctness hazard, not just noise

Reproduced a second time, and the consequence is worse than first logged.

Session `ms5eo2ei-77224049` (daneen) entered a 44-minute DECLARED WAIT on
`kteamd bootstrap completes (restarted externally, pid 1676880)`. That premise
was **false** — the daemon had not restarted (identical pid) and could never
report `ok`, because it is wedged by the #B44 analytics-import bug. The teammate
had parked on a condition that cannot occur.

**Four consecutive `kteam send` attempts failed**, all with
`interactive harness did not become ready within 30s`. Nothing reached
`channel/inbox.jsonl`. Message size was irrelevant (3KB and 250B both failed).
So the lead **could not correct a teammate who had parked on a false premise** —
the teammate would have burned the full 44 minutes waiting for an impossible
event, and the send path gave no indication the correction was being dropped.

**What worked:** `kteam interrupt <name>` followed immediately by `kteam send`.
The send then landed on the first try and was confirmed in `inbox.jsonl`.
(`kteam status` still displayed the stale DECLARED WAIT line afterwards, so the
status line is not a reliable indicator that the park was broken — verify via
the inbox instead.)

**Why this matters beyond one session.** A declared wait is exactly the state in
which a teammate is _most_ likely to need steering: they have stopped work and
committed to a condition they cannot re-evaluate on their own. Making that the
one state where messages cannot be delivered inverts the intent of the feature.

**Suggested fix.** The send path's `promptReady` probe should be bypassed (or
satisfied differently) when the target is in a declared wait — delivery to
`inbox.jsonl` does not require an interactive prompt. Failing that, `kteam send`
must at minimum exit non-zero with an explicit "message NOT delivered" and
suggest `kteam interrupt`, rather than reporting a harness-startup condition.
