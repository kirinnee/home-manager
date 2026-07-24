# kteam

`kteamd` owns interactive Claude/Codex teammates; `kteam` is its local or remote
client. Harness input always goes through tmux. Output is tailed from native
transcript JSONL with filesystem notifications and normalized into durable events.

```text
kteam daemon install                 # launchd (macOS) or systemd --user (Linux)
kteam daemon status
kteam recommend "build and review a frontend"
kteam start --agent claude-auto-mm3 --mode auto --image reference.png "build the frontend"
kteam start --agent codex-auto-atomi --mode interactive "review it with me"
kteam stream <id>
kteam send <id> --image screenshot.png "compare this with the UI"
kteam interrupt <id>
kteam answer <id> React
kteam answer <id> --other "Use the existing stack"
kteam answer <id> --response React --response "Use the existing stack"
kteam stop <id>
kteam resume <id> "continue"
kteam signal waiting --until 45m --on "droplet proof suite"   # park; --until is optional
kteam signal working                 # end the park early (any new turn also clears it)
kteam delete <id>                    # soft delete; --purge is permanent
```

`start` answers within 45 s even when the bootstrap queue is longer than that —
the session comes back `starting` and its launch continues in the background
(`--detach` returns immediately). Creates are idempotent per request id (pass your
own with `--request-id` / `KTEAM_REQUEST_ID` and reuse it on every retry), so a
start whose response is lost never yields a duplicate teammate.

A declared wait suspends the idle nudge, the stall kill, and the turn ceiling
while heartbeating every 5 minutes; at `--until` — or after 4 hours, whichever
comes first — the daemon clears it and wakes the teammate, crediting the parked
time back against the ceiling.

The authenticated API defaults to `http://127.0.0.1:7337`. Configure clients with
`KTEAM_URL` and `KTEAM_TOKEN`; configure the daemon bind with `KTEAM_HOST` and
`KTEAM_PORT`. Use an SSH tunnel or TLS reverse proxy outside one trusted host.
HTTP provides session control, paginated history, and image upload;
`/v1/events` is a cursor-based replayable WebSocket stream.

Every session remains inspectable under `~/.kteam/<id>/`:

- `events.jsonl` — durable ordered event journal
- `chat.jsonl` — normalized native transcript messages
- `attachments/` — validated content-addressed images
- `snapshots/`, `checks/`, `kill.json` — pane and health evidence
- `config.json`, `state.json`, `channel/`, `logs/`, `summary.md`

SQLite under `~/.kteam/daemon/` is a disposable query index and can be rebuilt
from these files. It also answers the event feeds: per-session replay is
complete, while the FLEET-wide feed is a live window (the newest 5 000 events) —
both are index-bounded queries, never a load of every journal. Every 60 s the
daemon checks its own timer lateness and reconciles that index against the
session directories, reindexing or re-adopting what drifted; an index that will
not heal in place asks the service manager for a clean restart.

The daemon combines transcript activity, tmux/pane health, Git diffs, exit
codes, markers, and `kfleet` quota data before classifying a stall.
