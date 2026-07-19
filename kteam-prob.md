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
