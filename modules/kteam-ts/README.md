# kteam

`kteamd` owns interactive Claude/Codex teammates; `kteam` is its local or remote
client. Harness input always goes through tmux. Output is tailed from native
transcript JSONL with filesystem notifications and normalized into durable events.

```text
kteam daemon install                 # launchd (macOS) or systemd --user (Linux)
kteam daemon status
kteam recommend "build and review a frontend"          # --budget cheap|balanced|max, --roles, --json
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

`start` answers within 45 s — 90 s for the slow providers (GLM/MiniMax/DeepSeek)
— even when the bootstrap queue is longer than that: the session comes back
`starting` and its launch continues in the background (`--detach` returns
immediately). A backgrounded launch is PENDING, never failed: it resolves itself
with `session.launch_settled` (→ `running`, monitor attached) or fails with the
real reason. Control actions that land in that window queue behind the launch
rather than being refused. Creates are idempotent per request id (pass your own
with `--request-id` / `KTEAM_REQUEST_ID` and reuse it on every retry), so a start
whose response is lost never yields a duplicate teammate.

`recommend` classifies the task along explicit axes (complexity, kind, risk,
size, ambiguity, audience — each with the words that drove it) and proposes a
team SHAPE per the handoff chain: planner → implementer(s)/researcher → fan-out →
cross-family reviewer. Every role offers a primary plus ranked alternatives with
the exact `kteam start` command; the doctrine tiers in
`kfleet/skills/kteam/SKILL.md` are enforced as floors, so hard work can never
land on the mass-chore tier and a chore never burns the top tier.

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

Fleet analytics use that SQLite index, including terminal and archived sessions:

```text
kteam analytics
kteam analytics "count by (wrapper)"
kteam analytics "avg by (model, harness) {label=ui-r28-*}"
kteam analytics "sum by (day) {status=completed}" --json
```

The command is named `analytics` rather than `metrics` because it describes
fleet history and outcomes, while leaving run-local metrics terminology to
`kloop`.

The query language deliberately follows `kloop metrics`: `sum`, `avg`, `min`,
`max`, or `count`; optional `by (label, ...)`; and `{label=value}` / glob-style
`{label=~value-*}` filters. Labels are wrapper/binary, model, harness, mode,
status, label, cwd/repo, parent, day, and week. Results include session count,
tokens, turns, wall duration (unknown until a session records its finish), time
to first output, last/end context percent, and stall/failure/completion rates.
`/v1/analytics?q=...` returns the same contract as `--json`.

`token_data` is an additional honesty label (`known` or `unknown`). The default
keeps incomplete model groups blank; when a known-only sample is intentional,
say so in the query: `avg by (model) {status=completed, token_data=known}`.

Analytics metadata is materialized on every indexed config/state/event change;
a missing analytics schema is rebuilt from `kteam.sqlite` without opening the
1,000+ session directories. Exact token totals need transcript usage records,
so a low-priority byte-cursor worker streams changed sources once and keeps the
derived totals incremental. Queries never read transcripts. Until every source
for a session has been indexed, its token count is unknown (`null` / `—`), not
zero; an aggregate is likewise blank unless all sessions in that group know the
measure, with `[known/total]` coverage shown. Raw output is capped at 200 rows,
grouped output at 500 groups, query text at 2,048 characters, and transcript
scanning at one bounded line plus a 32 MiB background batch.

The daemon combines transcript activity, tmux/pane health, Git diffs, exit
codes, markers, and `kfleet` quota data before classifying a stall.
