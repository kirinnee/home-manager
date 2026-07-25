---
name: rc-session
description: 'Start or attach a named human-driven assistant session on kteam. Use when the user runs /rc-session, says "start a session" or "start an rc session", or wants to switch between mobile/browser and the CLI for Claude remote control or Codex. Sessions are kteam interactive sessions; attach with `kteam attach <name>`. Do not create or ask about worktrees.'
---

# Start an RC session (kteam interactive)

Start a named, human-driven assistant session with `kteam` — a plain TUI the user drives
themselves. Remote control is ON by default for Claude, so the same session continues in
the terminal, on the phone, or at claude.ai. This supersedes the old `klaude handoff` /
`kodex handoff` (zellij) flow.

## The session title: `[Teammate] Task Title`

Every session gets a human title of the form **`[Hayden] Fix Transcript`**:

- `Hayden` — the **teammate callsign**, Title-Cased.
- `Fix Transcript` — the **task**, Title-Cased, 2–3 words.

This title is what `kteam ps` and the dashboard show in the TASK column. `kteam` stores it
**verbatim** (the brackets survive), so compose it correctly up front.

To compose it you must know the teammate name **before** you start — so pick it first with
`kteam name`, then pass BOTH the chosen name (`--teammate`) and the composed title
(`--name`) in one `kteam start`.

> **`--name` is the TASK TITLE, not a slug and not the directory basename.** (The old
> version of this skill passed the cwd basename as `--name` — that is wrong now.) The
> teammate callsign goes in `--teammate`; the human title goes in `--name`.

## Steps

1. **Get the task** (2–3 words) if the user did not already say what the session is for —
   e.g. "Fix Transcript", "HQ Notes", "Codex Spike". If the user gave a full name/title
   explicitly, use it as-is and skip the composing below.

2. **Pick the teammate name first:**

   ```bash
   kteam name          # prints one available teammate name, e.g. `hayden`
   ```

   This is a _suggestion_, not a reservation — a later `start --teammate` can still collide
   (rare); if it does, just take the next suggestion (`kteam name -n 5` prints several).

3. **Compose the title:** `[<Teammate>] <Task Title>` — teammate Title-Cased, task
   Title-Cased. `hayden` + "fix transcript" → `[Hayden] Fix Transcript`.

4. **Start with both flags in one shot** (run from the intended dir, or pass `--cwd`):

   ```bash
   kteam start -a claude-auto-kirin --model 'claude-opus-5[1m]' --mode interactive \
     --teammate hayden --name "[Hayden] Fix Transcript" --cwd "$PWD"
   ```

5. **Handle a collision.** If `start` fails with _"teammate name … is already taken by a
   live session"_, pick the next suggested name, re-Title-Case, recompose the title, and
   retry. (Or add `--teammate-fallback` to let kteam auto-assign a free name instead of
   failing — but then read the ACTUAL teammate name back from kteam's output before you
   report the title, since it will differ from what you composed.)

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
  --teammate marlon --name "[Marlon] Codex Spike" --cwd "$PWD"
```

## Attach

```bash
kteam attach <name>          # teammate name or session id (Ctrl-b d detaches)
kteam attach <name> --print  # print the tmux command instead of attaching
```

Inside an existing tmux client this switches the client rather than nesting.

## Gather Only What Is Missing

Ask only for:

- **Target assistant**, if the user did not say Claude, Codex, `crc`, or `rc`.
- **Task** (2–3 words), if the user did not say what the session is for and no full name
  was supplied.

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

```text
Session started
  Target : claude|codex
  Dir    : <work_dir>
  Title  : [Hayden] Fix Transcript
  Name   : <teammate name>
  Attach : kteam attach "<name>"
  Remote : the pane prints a claude.ai/code link while RC is active
```
