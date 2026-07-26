---
name: rc-session
description: 'Start or attach a named human-driven assistant session on kteam. Use when the user runs /rc-session, says "start a session" or "start an rc session", or wants to switch between mobile/browser and the CLI for Claude remote control or Codex. Sessions are kteam interactive sessions; attach with `kteam attach <name>`. Do not create or ask about worktrees.'
---

# Start an RC session (kteam interactive)

Start a named, human-driven assistant session with `kteam` — a plain TUI the user drives
themselves. Remote control is ON by default for Claude, so the same session continues in
the terminal, on the phone, or at claude.ai. This supersedes the old `klaude handoff` /
`kodex handoff` (zellij) flow.

## Two names, and kteam composes the bracketed one for you

A session has **two** distinct names — do not conflate them:

- **The task title** — `--name`, the **PLAIN** task, natural Title Case, up to 5 words:
  `Fix Transcript`. **No brackets, no callsign.** This is what `kteam ps` and the dashboard
  show in the TASK column, stored verbatim.
- **The teammate callsign** — `--teammate`, a slug like `hayden`. The session's identity.
- **The Claude-side session name** — you do **not** pass this. kteam automatically names
  Claude's own session **`[Teammate] Task`** (e.g. `[Hayden] Fix Transcript`) at launch, so
  it shows up that way in claude.ai/code and the `claude` resume picker.

> **Pass the PLAIN task title as `--name` — never compose `[Teammate] …` by hand.** kteam
> adds the `[Teammate]` prefix for the Claude-side name itself; if you pre-bracket `--name`
> you pollute the TASK column with brackets the user does not want there (and risk a doubled
> `[Team] [Team] …`). The callsign goes in `--teammate`; the plain task goes in `--name`.

You must still know the teammate name **before** you start (kteam needs it at launch to
compose the Claude-side name), so pick it first with `kteam name`, then pass BOTH
`--teammate` and the plain `--name` in one `kteam start`.

## Steps

1. **Get the task title** (natural Title Case, up to 5 words) if the user did not already say
   what the session is for — e.g. "Fix Transcript", "HQ Notes", "Codex Spike". This is the
   **PLAIN** title only — you never add a `[Teammate]` prefix. If the user gave a full title
   explicitly, use it as-is.

2. **Pick the teammate name first:**

   ```bash
   kteam name          # prints one available teammate name, e.g. `hayden`
   ```

   This is a _suggestion_, not a reservation — a later `start --teammate` can still collide
   (rare); if it does, just take the next suggestion (`kteam name -n 5` prints several).

3. **Start with both flags in one shot** (run from the intended dir, or pass `--cwd`). Put
   the callsign in `--teammate` and the **plain** task title in `--name` — no brackets, no
   callsign in `--name`. kteam composes the `[Hayden] Fix Transcript` Claude-side name itself:

   ```bash
   kteam start -a claude-auto-kirin --model 'claude-opus-5[1m]' --mode interactive \
     --teammate hayden --name "Fix Transcript" --cwd "$PWD"
   ```

4. **Handle a collision.** If `start` fails with _"teammate name … is already taken by a
   live session"_, pick the next suggested name and retry with it in `--teammate` — the
   plain `--name` title never changes. (Or add `--teammate-fallback` to let kteam
   auto-assign a free name instead of failing — but then read the ACTUAL teammate name back
   from kteam's output before you report, since kteam composes the Claude-side name from it.)

## Rules that always apply

- **No prompt/task argument.** Interactive sessions start bare at the harness prompt —
  never inject an opening turn; the human types the first thing themselves. The task only
  names the session; it is not sent into the TUI.
- **Wrapper**: default `claude-auto-kirin` with **Opus 5** for Claude —
  `-a claude-auto-kirin --model 'claude-opus-5[1m]'`. (The fleet rule that bans
  `claude-auto-kirin` is about AUTONOMOUS teammate work; these are the user's OWN hands-on
  sessions, so the personal account is the right one.) For Codex use a codex wrapper
  (e.g. `codex-auto-loge`); Codex has no RC flag, so RC applies to Claude only.
- **Directory**: the current working directory unless the user gives another path. Never
  ask about or create worktrees.
- `--no-rc` opts a single session out of remote control.

Codex example:

```bash
kteam name   # -> e.g. `marlon`
kteam start -a codex-auto-loge --mode interactive \
  --teammate marlon --name "Codex Spike" --cwd "$PWD"
```

## Attach

```bash
kteam attach <name>          # teammate name or session id (Ctrl-b d detaches)
kteam attach <name> --print  # print the tmux command instead of attaching
```

Inside an existing tmux client this switches the client rather than nesting.

## Rename later

`kteam rename <name> --name "New Title"` takes the **plain** title too — kept verbatim, no
brackets, exactly the same rule as `start`. (`--teammate <slug>` renames the callsign.)

One limitation to know: rename only rewrites config, so it updates kteam's **TASK column
immediately**, but the **Claude-side session name only re-composes on the next
relaunch/resume**. A session that is currently LIVE keeps its old `[Teammate] …` name in
claude.ai/code and the resume picker until it is resumed. So after renaming a running
session, expect the TASK column to change now and the claude.ai title to catch up only after
the next `kteam resume`.

## Gather Only What Is Missing

Ask only for:

- **Target assistant**, if the user did not say Claude, Codex, `crc`, or `rc`.
- **Task** (natural Title Case, up to 5 words), if the user did not say what the session is
  for and no full name was supplied.

Do not ask about worktrees, ticket systems, categories, harnesses, or wrappers.

Target selection:

- Choose **Claude** when the user says Claude, `crc`, remote control, phone-driveable, or
  just `rc` without saying Codex.
- Choose **Codex** when the user says Codex.
- Treat "mobile to CLI", "CLI to mobile", "phone", "handoff", "switch devices", and
  "continue from terminal" as a request for one of these sessions — they are all the same
  thing now, since the session is attachable from anywhere.

## Why kteam rather than zellij

Interactive sessions are **immortal**: the reflex monitor never nudges or kills them and
the fleet warden never flags them, so one may sit idle for days. They also get kteam's
history, the web UI (chat + live terminal view), and `kteam ps` visibility for free.

## Report

After launch, report (take the teammate NAME from kteam's own output — never re-derive it;
say "reused existing session" if one was attached instead of created):

Report the **plain task title** AND the **Claude-side session name** separately — since
kteam now composes the second from the first, they differ and both matter (one is what the
TASK column shows, the other is what claude.ai/code and the resume picker show):

```text
Session started
  Target  : claude|codex
  Dir     : <work_dir>
  Task    : Fix Transcript             # plain title — kteam's TASK column, what you passed to --name
  Session : [Hayden] Fix Transcript    # Claude-side name (claude.ai/code + resume picker), composed by kteam
  Name    : <teammate name>
  Attach  : kteam attach "<name>"
  Remote  : the pane prints a claude.ai/code link while RC is active
```

The `Session` line is Claude-only: Codex has no launch-time display-name flag, so a Codex
session has no `[Teammate] Task` name — report just the plain Task for it.
