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
