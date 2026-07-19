## Session 2026-07-13 (Tesla claim infographic build, agent claude-auto-mm3, id mrjrm4nt-65d9b709)

- `kteam wait <id> --timeout 600` -> `error: unknown option '--timeout'`. The `wait` subcommand
  does not accept a timeout flag, so there is no built-in way to bound how long you block. Had to
  fall back to `kteam wait <id>` with no bound (runs indefinitely) plus manual `kteam status` polling.
  Suggestion: add `--timeout <seconds>` to `kteam wait`.

- STALL: teammate `claude-auto-mm3` (MiniMax-M3 · API Usage Billing) started and `kteam status`
  reported `running / turn 1`, but the snapshot showed the Claude Code TUI stuck on
  `Not logged in · Please run /login`. The auto-mode prompts were injected but every turn returns
  `Not logged in`, so no work happens. `kteam status` still says "running", giving a false-positive —
  a not-logged-in TUI is indistinguishable from a working one via status alone. Had to `kteam snapshot`
  to discover it. Suggestions: (1) kteam should detect the "Not logged in" banner and surface it as a
  `failed`/`blocked` state instead of `running`; (2) validate wrapper auth at `kteam start` time.

- ROOT CAUSE of the above stall (important): auth was NEVER the problem. Verified:
  - `curl` to https://api.minimax.io/anthropic/v1/messages with $MINIMAX_API_KEY -> HTTP 200, valid reply.
  - `claude-auto-mm3 --dangerously-skip-permissions -p "reply PONG"` (headless) -> printed `PONG`, exit 0.
    The interactive TUI launched by kteam was stuck on the Claude Code "Welcome back!" startup splash;
    the two auto-mode prompts kteam injected appear to have been sent BEFORE the TUI finished booting,
    so they landed as no-op turns ("Brewed for 0s" / "Cooked for 0s") and the pane sat idle at 0% context.
    The "Not logged in · Run /login" text is just the cosmetic statusline for token-based (ANTHROPIC_AUTH_TOKEN)
    third-party endpoints and is NOT a real auth failure.
    Likely kteam bug: prompt injection timing / not waiting for the TUI to reach the interactive input state
    (and possibly not dismissing a first-run splash) before typing. Suggestion: gate prompt injection on a
    readiness check (input box present) with a retry, and don't treat the token-mode statusline as logged-out.

## 2026-07-13T22:09Z — session start (nitroso unified-priority work)

Team: claude-auto-mm3 (mrjrutsz-e9ffaa68, argon locales), claude-auto-loge (mrjrx0n2-5321ff4f, argon finish+ship), codex-auto-loge (mrjrxyzm-370b88fe, zinc PR #43 land).
No problems at launch: daemon 0.2.0 up, all three sessions started on first try.
Minor note (not kteam's fault): `kfleet health --json` output is large; piping through `tail` loses the claude entries — probed the 3 candidate wrappers directly with -p/exec instead.

- CONFIRMED REAL BUG (env not propagated to tmux pane): the launcher runs
  `tmux new-session -d -s kteam-<id>-agent ... -e KTEAM_HOME=... -e KTEAM_SESSION_ID=... -e PATH=... -e KTEAM_URL=... -e CLAUDECODE= env -u CLAUDECODE claude-auto-mm3 ...`
  It forwards KTEAM*\*/PATH/CLAUDECODE via `-e` but NOT the model API key `MINIMAX_API_KEY` (nor the
  ANTHROPIC*\* vars the wrapper needs). `tmux new-session` attaches to a PRE-EXISTING tmux server whose
  global environment lacks MINIMAX_API_KEY, so the pane's shell has it EMPTY. The wrapper then does
  `export ANTHROPIC_AUTH_TOKEN="$MINIMAX_API_KEY"` -> empty token -> interactive Claude Code shows
  "Not logged in" and every turn no-ops. `kteam status` still reports `running`, so this is a silent stall.
  Proof: `tmux show-environment -t kteam-<id>-agent` has no MINIMAX/ANTHROPIC vars; headless run of the
  same wrapper FROM A SHELL THAT HAS THE KEY works fine.
  FIX for kteam: pass the wrapper's required secret env (MINIMAX_API_KEY and friends) explicitly via `-e`
  on `tmux new-session`, or `tmux set-environment -g` on the server before spawning, or start a dedicated
  tmux server (‑L kteam) from kteamd's own env so panes inherit the daemon environment.

- WORKAROUND CONFIRMED WORKING: before starting the session, inject the secret into the tmux server's
  global env so new panes inherit it:
  tmux set-environment -g MINIMAX_API_KEY "$MINIMAX_API_KEY"
  Then `kteam stop <stuck-id>` and `kteam start ...` a fresh session. The new pane booted fully logged in
  and started doing real work immediately (reading files, running Bash, context climbing). New session
  mrjs1pb1-56d49a5d replaced the stalled mrjrm4nt-65d9b709. This confirms the diagnosis: the daemon must
  propagate wrapper secrets into the tmux pane env (via `-e` on new-session, `set-environment -g`, or a
  dedicated daemon-env tmux server) — otherwise token-based wrappers silently boot logged-out.

- OUTCOME: after the tmux global-env workaround, session mrjs1pb1-56d49a5d ran to `completed` (turn 1,
  done marker written, full summary.md) and produced the correct 20.3KB single-file HTML. Net: kteam is
  usable for token-based wrappers ONLY if you pre-seed the tmux server env with the wrapper's secret.
  The one blocking bug this session was the env-not-propagated-to-pane issue documented above.

## 2026-07-13T22:24Z — mrjrutsz-e9ffaa68 (claude-auto-mm3, locale task) STALLED at login

TUI came up with "Not logged in · Please run /login"; both the turn prompt and the automode nudge bounced off it (transcript shows the login error as the reply, 0 tokens). kteamd correctly flagged 'no durable transcript progress for 900s' -> stalled.
Confounder: a SECOND mm3 session started 25 min later (mrjsed3l, radon bump) authenticated fine and completed real work — same wrapper, same machine. So mm3 TUI auth is FLAKY at session start, not deterministically broken (direct 'claude-auto-mm3 -p' also worked). Impact: 15 min lost on the locale task. Workaround: kteam resume (fresh TUI re-reads credentials) / reassign.
Also reconfirmed the earlier note: the statusline shows "Not logged in" + "0% (0/200k)" even on sessions that ARE working (mrjsed3l completed a full PR flow showing 0% tokens) — the statusline is not a reliable health signal; transcript progress is.

## 2026-07-13 — RESOLUTIONS (claude-kirin main session)

1. ✅ `kteam wait --timeout <seconds>` implemented (src/index.ts). On expiry it prints the
   current state and exits 124 (invalid values exit 2). Unbounded wait remains the default.

2. ✅ ROOT-CAUSE FIX — env not propagated to tmux pane (the confirmed blocking bug):
   `TmuxController.launch()` now forwards the daemon's ENTIRE environment to the pane via
   `-e` (denylisting only tmux/terminal-session vars and the explicitly-managed KTEAM*\*/
   PATH/CLAUDECODE). Wrapper secrets (MINIMAX_API_KEY, ANTHROPIC*\*, …) reach token-based
   wrappers regardless of the pre-existing tmux server's global env. The
   `tmux set-environment -g` workaround is no longer needed.

3. ✅ Prompt-injection timing: the three raw `tmux.inject()` call sites in
   session-manager (initial prompt, resume prompt, automode nudge) now go through
   `tmux.send()`, which re-verifies prompt readiness (input box present, startup
   dialogs/splash cleared) immediately before typing, with retry + landed-text
   verification. Prompts can no longer land as no-op turns on a booting TUI.

4. ✳️ NOT implemented (on purpose): treating the "Not logged in" statusline as a
   failed/blocked state — the 22:24Z entry itself confirms that banner shows on
   HEALTHY token-based sessions (mrjsed3l completed a full PR flow displaying it),
   so it is not a reliable health signal. Transcript progress (the existing 900s
   stall detection) remains the health source of truth. With fix #2 the underlying
   logged-out-boot cause is gone.

All 42 kteam-ts tests pass post-change.

## 2026-07-13T22:35Z — resolution notes (nitroso session)

mrjrutsz (mm3 locale stall): `kteam resume` fixed it — turn 2 authenticated fine and completed; work verified good (i18n catalog check passed 1432 keys x 3 locales downstream). Net: mm3 TUI auth flake is recoverable via resume, cost ~15 min.
No other kteam problems this session: 5 sessions total, 4 completed cleanly on turn 1 (codex-auto-loge zinc land, claude-auto-loge argon ship, 2x mm3), waits/status/snapshots all behaved. Cross-teammate file gating (loge polling for mm3's locale keys before committing in the SAME worktree) worked as instructed.

## 2026-07-14T02:54Z — mm3 login-wall RECURRENCE (mrk1xfkz radon bump + mrk1y9qk argon promo)

Both claude-auto-mm3 sessions started within ~1 min of each other came up "Not logged in · Please run /login" and froze (chat.jsonl static at 1589B for 90s+, prompts bouncing). Same failure as mrjrutsz earlier today. Pattern so far: mm3 works via -p probes and SOMETIMES in kteam TUIs (mrjsed3l, mrjs1pb1 fine), but fresh TUI launches intermittently miss credentials — possibly a credential-sync race in the wrapper when multiple mm3 TUIs spawn near-simultaneously. kteamd's stall detector takes 900s to flag it; a login-state check at session start would catch this in seconds. Workaround again: kteam resume (fresh TUI usually authenticates).
Addendum: `kteam resume` refuses on a login-walled session because state is still 'running' (stall flag takes 900s) — had to `kteam stop` + `kteam resume`. A `kteam restart <id>` (or resume --force) would make the workaround one step; better yet, detect the login-wall reply and fail fast.
Addendum 2 (03:02Z): resume did NOT fix the recurrence — both mm3 sessions came back login-walled again (transcripts frozen after restart too). Differs from the morning incident where one resume recovered. Suspect the mm3 credential/token itself expired since (~4h between working and broken). Escalation path used: stop both, reassign tasks to codex-auto-loge. Suggest: kteam start should probe the TUI for the login-wall reply within ~30s and fail the session immediately with a distinct 'auth' status instead of burning the 900s stall timer (twice, if you resume).

## Session 2026-07-14..16 (PE-8837 labelling trace + PE-8838 alloy, ~11 sessions across claude/codex wrappers)

- DAEMON FLAPS FOR BACKGROUND SHELLS: `kteam` calls run from the harness's background shells
  frequently fail with `kteam daemon is unavailable at http://127.0.0.1:7337` while the SAME
  command succeeds in a foreground shell seconds later. `kteam daemon status` shows ok/pid stable
  throughout — the daemon never actually died. Suspect an env/proxy variable difference in
  background shells (HTTP_PROXY?) or a localhost resolution issue. Effect: `kteam send`/`stop`/`ps`
  are unreliable from automation; had to fall back to raw `tmux send-keys`/`capture-pane`.

- INITIAL TASK PROMPT NOT INJECTED (recurring, both harness types): sessions reach the TUI but the
  turn-001 task prompt never arrives. Seen on: claude sessions sitting at the splash with 0% context
  and only `turn-001.md` on disk, and codex sessions stuck at the `Do you trust this directory?`
  prompt (kteam injects before/without answering it, prompt is lost). Fix each time was manual:
  `tmux send-keys` the trust-accept Enter, then send "Read turns/turn-001.md and follow it".
  Suggestions: (1) kteamd should answer the codex trust prompt (or launch codex with the trust
  flag); (2) verify the prompt actually landed (snapshot grep) and retry injection; (3) surface
  "TUI idle at 0% context after N minutes" as a distinct state, not `starting`/`running`.

- `kteam start --cwd` LANDED IN WRONG DIRECTORY once under daemon flap: requested cwd
  PE-label-ernest, session came up in pe-llm (previous session's cwd) on wrapper claude-auto-mm3
  (not the requested claude-auto-loge either). Looks like a daemon-side race when a start request
  is retried/queued during a flap. Effect: wasted session + manual kill; task re-sent to the
  original session via tmux instead.

- WRAPPER AUTH/QUOTA NOT VALIDATED AT START: three launches burned sessions on dead accounts —
  glm52a and glm52b both `Not logged in · Run /login`, codex-auto-ernest at `weekly 0% left`
  (usage exhausted; TUI opens but any turn would fail). kteam start returns success for all of
  these. Suggestion: preflight auth + remaining quota at `kteam start` and fail fast with a clear
  error naming the wrapper.

- DUPLICATE SESSIONS FROM RETRIES: retrying `kteam start` after an apparent daemon-unavailable
  error produced two live sessions for the same task twice (mrl9syj3/mrl9t9mz, mrny4vo3/mrny4hxg).
  The first request had actually succeeded server-side despite the client error. Suggestion:
  idempotency key on start (e.g. hash of cwd+prompt) or a `--replace-existing` flag.

- `kteam stop` UNRELIABLE UNDER FLAP: repeatedly returned daemon-unavailable; had to
  `tmux kill-session` directly, which leaves kteamd state stale (`ps` kept showing the session as
  `starting` afterwards).

- API-KEY CONFIRMATION PROMPT BLOCKS loge WRAPPER: claude-auto-loge sessions stop at Claude Code's
  "Detected a custom API key ... Do you want to use this API key?" dialog (defaults to No). kteamd
  does not answer it; session sits idle and any pre-injected prompt queues behind it. Had to tmux
  Up+Enter manually. Suggestion: wrapper should set the key via settings (apiKeyHelper) or kteamd
  should handle this known dialog.

- CONTEXT EXHAUSTION NOT SURFACED: the ernest trace session hit 100%+ context (274k/200k shown) and
  went effectively unresponsive to new prompts (queued but never processed) while kteam still
  reported `running`. A "context ≥ N%" health signal (it's in the TUI status bar, parseable) would
  let the lead rotate sessions before they wedge.

- Codex TUI status line ambiguity: sol sessions show `Working (13m ...)` for both real work and
  hook stalls (`Running PreToolUse hook`). Only tmux capture distinguishes them. A parsed
  "last-tool-started-at" in `kteam status` would help stall detection.

## 2026-07-16 — RESOLUTIONS (claude-kirin main session, kteam 0.2.1)

1. ✅ DAEMON FLAPS / `stop` UNRELIABLE FROM BACKGROUND SHELLS: the client now (a) force-adds
   127.0.0.1/localhost/::1 to NO_PROXY at startup (background shells carried HTTP(S)\_PROXY vars
   that proxied loopback and made the healthy daemon look dead) and (b) retries each API request
   3x with backoff before declaring the daemon unavailable; the error now includes the underlying
   fetch failure message instead of a generic banner. (src/index.ts, src/api-client.ts)

2. ✅ "command too long" LAUNCH FAILURES (the 3 failed sol sessions on the box, 2026-07-15): the
   env-propagation fix from 07-13 forwarded the daemon's ENTIRE environment as `tmux new-session -e`
   flags, which blows tmux's command length limit on real machines. The pane env + harness argv now
   travel via a generated `launch.sh` (mode 0700, in the session dir) — same env guarantee, no
   length limit. (src/tmux-controller.ts launch())

3. ✅ INITIAL PROMPT NOT INJECTED / codex trust prompt / api-key dialog: `send()` now runs the
   startup-dialog handler (trust prompts, onboarding, permission-bypass) at injection time too, not
   only at launch; a new `api-key` dialog kind answers Claude Code's "Detected a custom API key ...
   Do you want to use this API key?" (defaults to No — kteam navigates to Yes). `inject()` now also
   verifies the turn actually STARTED after pressing Enter (pane leaves the idle prompt or the text
   clears), re-pressing Enter up to 3x — a typed-but-unsubmitted prompt can no longer sit idle at
   0% context. (src/tmux-controller.ts)

4. ✅ LOGIN-WALL / LOST-PROMPT FAIL-FAST (mm3 recurrence + "TUI idle at 0% after N minutes"): the
   monitor now tracks whether ANY transcript record landed since the current turn started. If the
   pane is idle at the input box with zero transcript progress, it re-injects the turn prompt once
   at 120s, and at 360s kills the session with a distinct reason — "harness authentication failed:
   TUI is login-walled ..." when the pane shows the login wall, else "turn never started ..." — via
   a `session.turn_never_started` event, instead of burning the 900s stall timer (twice, if you
   resume). (src/session-manager.ts monitorLoop)

5. ✅ `kteam restart <id>`: one-step stop+resume for wedged sessions (works while state is still
   'running'); replaces the manual `kteam stop` + `kteam resume` dance. (src/index.ts)

6. ✅ WRAPPER QUOTA NOT VALIDATED AT START: `kteam start` now preflights the quota service and
   fails fast with the wrapper named ("wrapper X is at its usage limit (resets ...)") when the
   account is exhausted. Auth preflight beyond quota remains covered by fix #4's fast fail (the
   statusline "Not logged in" banner is cosmetic on token wrappers and cannot be trusted at start).
   (src/session-manager.ts start())

7. ✅ DUPLICATE SESSIONS FROM RETRIES: `kteam start` rejects a start when an identical
   (binary, cwd, prompt) session is already live and was created <10 min ago — a client retry after
   a transient error now surfaces the existing session id instead of double-launching.
   (src/session-manager.ts start())

8. ✅ CONTEXT EXHAUSTION NOT SURFACED: the monitor parses context usage from the TUI statusline
   (Codex "Context N% used", Claude "N% context left"/ratio forms) into `state.contextPercent`,
   shown by `kteam status`, and emits a one-shot `context.high` event when it crosses 85% so the
   lead can rotate the teammate before it wedges. (src/tmux-controller.ts, src/session-manager.ts)

9. ✅ Codex "Working" AMBIGUITY: `state.lastToolStartedAt` is now recorded from transcript
   tool.use events and shown in `kteam status` — a "Working (13m)" with a 13-minute-old last tool
   start is a hook stall, not progress.

10. ✅ `kteam recommend` ONLY GAVE 2 RECOMMENDATIONS: the recommender only topped up to 2
    teammates when no keyword rule fired. It now fills to min(3, available) from the frontier pool
    (preferring the other harness family for independent validation) and caps at 4.
    (src/core.ts recommendAgents)

- NOT DONE (on purpose): daemon-side idempotency keys for start (the 10-min duplicate guard covers
  the observed failure); `--cwd` landing in the wrong directory under flap was not reproducible
  from the code (start resolves cwd per-request with no shared mutable state) — most plausibly a
  client-side retry mixing shells; will re-log with evidence if it recurs now that flaps are fixed.

All 51 kteam-ts tests pass post-change (`bun test`), tsc clean.

## 2026-07-16 addendum — mm3 login-wall TRUE ROOT CAUSE found and fixed

Smoke-testing the launch.sh change exposed it: when kteamd runs as a SERVICE (launchd on the Mac,
systemd on the box), its environment is only KTEAM*HOME+PATH — the wrapper API keys
(MINIMAX_API_KEY etc., loaded by interactive shells from ~/.secrets) are NOT in the daemon env, so
"forward the daemon's env to the pane" (the 07-13 fix) forwards no keys at all when the daemon is
service-managed. That's why mm3 TUIs were INTERMITTENTLY login-walled: sessions worked only while
the tmux server (or daemon) happened to be started from a user shell, and broke after a
reboot/service restart. Fix: the generated launch.sh now sources ~/.secrets at pane start (fresh
file beats stale daemon copy; KTEAM*\*/PATH still pinned after it). Verified: claude-auto-mm3
smoke session under the launchd daemon booted authenticated, did real work, wrote the done marker,
completed. (src/tmux-controller.ts launch())

Also observed while smoke-testing (glm52a): the new inject() verification correctly failed fast
with "the prompt was typed but the harness never started the turn" on a login-walled TUI —
previously this sat "running" for 900s.

## Session 2026-07-17→19 (diene env-round docs + STEP-6 wave 5, main session c89153f8)

Context: heavy multi-session use — 8-page site conversion fan-out, doc synthesis, plus the
step-6 execution fleet. Codex-auto-loge was the only fully reliable lane all session; every
Claude-side wrapper misbehaved. All items below reproduced on daemon-managed sessions.

- CLAUDE-WRAPPER INJECTION STALL (systemic, the big one). Affected claude-auto-loge (twice,
  logged as RB-20/RB-21 in the diene build), claude-auto-liftoff, claude-auto-atomi,
  claude-auto-glm52a, claude-auto-glm52b, claude-auto-mm3. Pattern: `kteam start` reports
  "the prompt was typed but the harness never started the turn"; session dir + TUI exist; the
  input box is EMPTY (typed prompt vanished entirely — not sitting unsubmitted); status=failed.
  `kteam resume` re-injects successfully and the session starts real work — but several then ran
  one partial turn (read the brief + sources, 26–42k ctx consumed) and went idle again without
  producing output; a second resume did not recover them and they were rerouted to codex.
  Suggestion: readiness-gated injection exists but is still insufficient on these TUIs —
  verify TURN START (spinner/tokens moving), not just typed text, and auto-retry injection
  N times before declaring failure; also investigate why a started turn silently ends after
  the first few tool calls on Claude wrappers (harness-side?), since resume alone doesn't fix it.

- RAPID SEQUENTIAL STARTS RACE: launching several sessions in quick succession (one shell call,
  3s sleeps), only the FIRST `kteam start` per batch succeeded; the rest all hit the
  typed-but-never-started failure. Spacing to ~1 launch per Bash invocation didn't help on the
  Claude side either (a standalone claude-auto-atomi start failed identically). Suggestion:
  serialize/queue session bootstrap in kteamd so concurrent starts can't race the injector.

- FALSE TERMINAL STATES (both directions):
  (a) status=completed while the TUI showed an ACTIVE turn ("Working (6m52s)", plan checklist
  mid-flight) — `kteam wait` returned, deliverable files not yet written (codex-auto-loge session
  mrphq5jc). The session later genuinely stalled mid-plan and needed resume to finish.
  (b) status=failed while snapshots showed live work (GLM "Lollygagging…", Sonnet "Mustering…",
  tokens counting) right after resume — the watcher gave up before slow models emitted first output.
  Suggestion: derive state from the pane (spinner/token counters/input-box presence), not from
  the injection watcher's timeout; treat "active spinner" as running unconditionally.

- SEND/STOP RACE — no reliable way to give a follow-up task to a finished session:
  `kteam send <id>` → "session is stopped; use resume"; `kteam resume <id>` then
  `kteam send` → "session is running; interrupt it before sending"; by the next idle poll it is
  "stopped" again. Hit on mrphq5jc (ida) and mrpzwwa9 (olive); both times the workaround was a
  brand-new session re-reading all context (expensive). Suggestion: a single verb that revives a
  completed session and injects a new turn atomically (send --revive), with the race handled daemon-side.

- kteam wait: returns on the (unreliable, see above) completed state; combined with (a) it fires
  before deliverables exist. Watching output files by hand was the workaround. Suggestion: optional
  `kteam wait --until-marker <file>` or wait-on-done-marker semantics.

- codex-auto-loai / codex-auto-atomi: terra model returned HTTP 400 at session start (RB-01,
  session lincoln) / usage-limit rejections. Both accounts effectively unusable this session;
  100% of implement/verify load fell on codex-auto-loge (quota single-point-of-failure).
  Needs: re-auth or model-config fix + a cheap preflight (see next).

- WISH: `kteam doctor` / start-time preflight — one canary turn per wrapper validating (1) auth,
  (2) model availability, (3) injection round-trip, emitting a green/red table. Would have saved
  ~10 dead launches and hours of snapshot forensics this session.

- Orchestrator ergonomics: the 4h session ceiling + harness ending turns early forced an external
  watchdog loop (bash) that respawns fresh orchestrators reading STATUS.md. Works, but native
  support (kteam-managed long-running orchestration with auto-resume/respawn policy) would remove
  a whole class of babysitting.

- Reminder from earlier session (still applies, memory-documented): claude-auto-loge first start
  stalls on the custom-API-key approval dialog unless loge-internal is pre-approved in its
  .claude.json — belongs in the kfleet template so `kfleet apply` bakes it into generated homes.

## 2026-07-19 — RESOLUTIONS (claude-kirin main session, kteam 0.2.1)

1. ✅ CLAUDE-WRAPPER INJECTION STALL (typed prompt vanishes, turn never starts): root
   cause found in `inject()` — a probe that disappeared from the input box was treated as
   "instant turn — done" even when the pane was back at an IDLE prompt, so a TUI that
   swallowed the text during a repaint passed as submitted. inject() now requires positive
   turn-start evidence (spinner/token counter via the new `paneShowsActiveWork()`, or a
   non-idle pane); a vanished-but-idle probe is retyped from scratch (4 attempts), and
   polling per submit is 3x longer for slow models. (src/tmux-controller.ts)

2. ✅ RAPID SEQUENTIAL STARTS RACE: TUI bootstrap (launch + first inject) is now
   serialized ACROSS sessions through a daemon-side queue — concurrent `kteam start`s
   can no longer race the injector. Applies to start() and resume(). (src/session-manager.ts)

3. ✅ FALSE TERMINAL STATES, both directions:
   (a) completed-while-working: a done marker with the pane still showing an active turn
   defers completion until the pane idles (one-shot `session.done_deferred` event) instead
   of killing tmux mid-turn with deliverables unwritten.
   (b) failed-while-working: `promptReady()` now returns false whenever the pane shows
   active work (spinner glyphs "✻ Lollygagging…", token counters, Codex "Working (6m…"),
   so promptStable can't accumulate on slow models and the 360s turn-never-started fail
   can't fire while work is visibly happening. (src/tmux-controller.ts, src/session-manager.ts)

4. ✅ SEND/STOP RACE: `kteam send` now atomically revives finished/stopped sessions —
   dead pane ⇒ send delegates to resume(id, message), which relaunches the TUI and
   injects the message as the next turn under the session lock (and delivers as a plain
   send if the pane turns out to be alive). The send⇄resume ping-pong is gone; no new
   verb needed. (src/session-manager.ts)

5. ✅ `kteam wait --until-marker <file>`: waits for the deliverable file itself;
   completed without the marker keeps waiting (bounded by --timeout), failed/stalled/
   stopped exits 1 ("marker never appeared"), waiting/awaiting states return so the lead
   can respond. `completed` alone is no longer trusted as proof of deliverables.
   (src/index.ts)

6. ✅ loge CUSTOM-API-KEY DIALOG: kfleet wrappers now pre-approve the wrapper's own
   ANTHROPIC_API_KEY in .claude.json (customApiKeyResponses.approved, verbatim ≤20 chars
   else last-20 tail) at launch, same self-healing pattern as autotrust — the "Detected a
   custom API key" dialog can never stall a session again. Verified idempotent; applied
   to all generated homes. (modules/kfleet-ts/src/core/generate.ts)

NOT bugs (filtered out, no action): codex-auto-loai terra HTTP 400 + codex-auto-atomi
usage-limit (account/provider), glm52a/b login walls (expired creds), ernest weekly 0%
(quota), mm3 recurrence (token expiry; env-propagation root cause fixed 07-16).

All 57 kteam-ts tests + 70 kfleet-ts tests pass, tsc clean; daemon restarted on the new
code, wrappers regenerated (`kfleet apply`).
