---
name: rc-session
description: 'Start or attach a named human-driven assistant session on kteam. Use when the user runs /rc-session, says "start a session" or "start an rc session", or wants to switch between mobile/browser and the CLI for Claude remote control or Codex. Sessions are kteam interactive sessions; attach with `kteam attach <name>`. Do not create or ask about worktrees.'
---

# Start an RC session (kteam interactive)

Start a named, human-driven assistant session with `kteam` — a plain TUI the user drives
themselves. Remote control is ON by default for Claude, so the same session continues in
the terminal, on the phone, or at claude.ai. This supersedes the old `klaude handoff` /
`kodex handoff` (zellij) flow.

## Launch

Run from the intended working directory (or pass `--cwd`):

```bash
kteam start -a <wrapper> --mode interactive --name "<slug>" --cwd "$PWD"
```

- **No prompt/task argument.** Interactive sessions start bare at the harness prompt —
  never inject an opening turn; the human types the first thing themselves.
- **Wrapper**: default `claude-auto-atomi` for Claude; for Codex use a codex wrapper
  (e.g. `codex-auto-loge`). Codex has no RC flag, so RC applies to Claude only.
- **Name**: default to the cwd basename; prefer a user-provided name.
- **Directory**: the current working directory unless the user gives another path.
- `--no-rc` opts a single session out of remote control.

Examples:

```bash
kteam start -a claude-auto-atomi --mode interactive --name "HQ" --cwd ~/Obsidian/HQ
kteam start -a codex-auto-loge  --mode interactive --name "codex-spike" --cwd "$PWD"
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
- **Session name**, if no usable name can be derived.

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
  Name   : <teammate name>
  Attach : kteam attach "<name>"
  Remote : the pane prints a claude.ai/code link while RC is active
```
