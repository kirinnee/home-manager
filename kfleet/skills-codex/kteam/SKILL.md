---
name: kteam
description: Coordinate full-strength Claude and Codex teammates in detached tmux sessions with external stall monitoring, durable file channels, completion markers, and resumable conversations. Use when work can be divided into independent tasks, when the user asks for teammates or subagents, or when delegating research, implementation, frontend, review, or long-running work across model accounts.
---

# KTeam

Use `kteam` instead of harness-native subagents. Keep the current conversation as team lead; delegate bounded tasks to full-strength Claude or Codex harnesses. Teammates always run as interactive TUIs inside tmux; never replace that base with Claude `--print` or Codex `exec`.

`kteam` is a client of the long-running `kteamd` daemon. Check `kteam daemon status`; start or install it when unavailable. The daemon owns tmux, transcript watching, state, health, attachments, and event streaming.

## Choose the team first

1. Run `kteam recommend "<task>"` and inspect the installed auto-mode wrappers.
2. Present a small proposed team with one task per teammate.
3. Wait for approval before consuming account quota, unless the user already named the exact wrappers or established a standing preference.
4. Start only independent, clearly bounded tasks. Avoid two teammates editing the same files.

Routing guidance:

- `claude-auto-mm3`: fast, strong frontend/UI, screenshot-to-code, SVG, and direct implementation.
- `claude-auto-glm52a` / `claude-auto-glm52b`: slower, difficult, cost-sensitive work.
- `claude-auto-dsv4f`: fast scouting, inventory, triage, and mechanical tasks.
- `claude-auto-f5-*`, `claude-auto-loge`, and `codex-auto-*`: hard implementation, debugging, architecture, and independent review.
- Prefer different model families for implementation and review.

## Launch and supervise

Start one approved teammate per task:

```bash
kteam start --agent claude-auto-mm3 --mode auto --cwd "$PWD" --image reference.png "Build the requested frontend and verify it"
kteam start --agent codex-auto-atomi --mode interactive --cwd "$PWD" "Review the current diff with me"
```

Each wrapper already carries its own default model (kfleet's `KTEAM_MODEL`: `opus` for standard Claude accounts, `fable-5` for F5/frontier, `terra` for Codex), so you normally omit the model. Override only when a task needs a specific one with `--model <alias|id>`, e.g. `kteam start --agent claude-auto-kirin --model sonnet --cwd "$PWD" "…"`. Leave it off to keep the account default.

Record each returned session ID. Use `kteam ps`, `kteam status <id>`, `kteam stream <id>`, and `kteam wait <id>` to supervise. `kteamd` is the external watcher; do not create another watcher.

Each session stores its complete protocol under `~/.kteam/<id>/`, including configuration, prompts, JSONL channels, snapshots, heartbeat/diff checks, logs, summary, markers, and kill diagnostics.

## Handle teammate messages

When a session enters `waiting`, `awaiting_user`, or `awaiting_question`:

1. Read `~/.kteam/<id>/channel/outbox.jsonl` and the latest snapshot.
2. Resolve the question in the main thread. Ask the user only when their decision is required.
3. Send the answer through the same interactive harness:

```bash
kteam send <id> "The decision or missing context"
```

Use `kteam send <id> "…"` for an interactive user turn, `kteam answer <id> <labels...>` for structured questions, and `kteam answer <id> --other "free-form answer"` for Other. For multiple questions, repeat `--response` once per question in order. Use `kteam interrupt <id>` to steer a busy turn. Use `kteam resume` only after a stopped/dead TUI; it preserves the Claude/Codex conversation.

Attach initial images with `kteam start ... --image <file> "…"`; send follow-up images with `kteam send <id> --image <file> "…"`. The client uploads the bytes to the daemon, which validates and stores them under the session, then injects daemon-local absolute paths through tmux.

## Finish safely

Treat `completed` as a teammate claim, not proof. Read `summary.md`, inspect the repository diff, and run appropriate verification. For `failed`, `stalled`, or `stopped`, inspect `last-snapshot.txt`, `kill.json`, and the current turn log before deciding whether to reply, restart, or finish locally.

Useful commands:

```bash
kteam logs <id>
kteam snapshot <id>
kteam attach <id>
kteam stop <id> --reason "why it was stopped"
```
