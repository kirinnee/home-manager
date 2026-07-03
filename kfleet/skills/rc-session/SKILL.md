---
name: rc-session
description: 'Start or hand off a named assistant session inside zellij. Use when the user runs /rc-session, says "start a session" or "start an rc session", or wants to switch between mobile/browser SSH and CLI for Claude remote-control or Codex. Use `klaude handoff` for Claude and `kodex handoff` for Codex. Do not create or ask about worktrees.'
---

# Start an RC Session

Start a named assistant session in detached `zellij`, without creating a worktree.
The same session can then be attached from mobile/browser SSH or from a local CLI.

## Defaults

- **Claude**: run `klaude handoff` — it launches the `crc-kirin` binary inside the session.
- **Codex**: run `kodex handoff` — it launches the `codex` binary inside the session.
- **Directory**: use the current working directory unless the user explicitly gives another path.
- **Name**: the default session NAME is the cwd basename. Prefer a user-provided name; if none is given and the basename would be unclear, ask for a short name.

## Gather Only What Is Missing

Ask only for:

- **Target assistant**, if the user did not say Claude, Codex, `crc`, or `rc`.
- **Session name**, if no usable name can be derived.

Do not ask about worktrees, ticket systems, categories, harnesses, or wrappers.

Target selection:

- Choose **Claude** when the user says Claude, `crc`, remote control, phone-driveable, or just `rc` without saying Codex.
- Choose **Codex** when the user says Codex.
- Treat "mobile to CLI", "CLI to mobile", "phone", "handoff", "switch devices", and "continue from terminal" as a handoff request.

## Launch

Run one of these from the intended working directory:

```bash
klaude handoff -n "<slug>"
kodex handoff -n "<slug>"
```

Pass any extra agent flags after the name. Examples:

```bash
klaude handoff -n "pe-investigate" --model opus
kodex handoff -n "codex-spike" --model <model>
```

Notes:

- **Existing session name**: if a zellij session with that name already exists, `klaude`/`kodex` ignore ALL agent flags and just attach to it. Pick a new name if the flags must apply — and the report must say the session was reused.
- **kodex flag forwarding**: any flags forwarded to `kodex` replace its default bootstrap prompt.
- If the user gave a directory, launch via `direnv exec <dir> klaude handoff -n "<slug>"` (or `kodex …`) — do not try to `cd`.

## Report

After launch, report (take the session name from `klaude`/`kodex`'s own stderr output — names are sanitized, so never re-derive it yourself; say "reused existing session" if it attached to one):

```text
Session started
  Target : claude|codex
  Dir    : <work_dir>
  zellij : <slug>
  Attach : klaude -n "<slug>" | kodex -n "<slug>"
  Raw    : zellij attach "<slug>"
```
