# kteam

`kteamd` owns interactive Claude/Codex teammates; `kteam` is its local or remote
client. Harness input always goes through tmux. Output is tailed from native
transcript JSONL with filesystem notifications and normalized into durable events.

```text
kteam daemon install                 # launchd (macOS) or systemd --user (Linux)
kteam daemon status
kteam recommend "build and review a frontend"          # --budget cheap|balanced|max, --roles, --json
kteam start --agent claude-auto-mm3 --mode auto --file reference.png "build the frontend"
kteam start --agent codex-auto-atomi --file brief.pdf --file notes.md "review these documents"
kteam start --agent codex-auto-atomi --mode interactive "review it with me"
kteam stream <id>
kteam send <id> --file report.docx "summarize the report"
kteam send <id> --image screenshot.png "compare this with the UI"  # compatibility alias
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
HTTP provides session control, paginated history, and attachment upload;
`/v1/events` is a cursor-based replayable WebSocket stream.

## One-time shared-browser sign-in

On Linux, kteam runs Chrome genuinely headful on a daemon-owned Xvfb display.
The shared profile lives at `~/.kteam/daemon/browser/profile` with mode `0700`.
To sign it in once, use your own shell — not a teammate pane:

```text
kteam browser login start --minutes 15
```

The command prints an ephemeral VNC password, a loopback port, and the complete
SSH tunnel command. On the phone or laptop where the VNC viewer runs:

1. Run the printed `ssh -N -L ...` command.
2. Connect the VNC viewer to the printed `127.0.0.1:<port>` address.
3. Enter the ephemeral password.
4. Verify the visible Chrome address bar says `accounts.google.com`.
5. Sign in yourself and complete 2FA. kteam never receives or automates the
   password, consent screens, CAPTCHA, or second factor.
6. Choose **Close — I signed in** in the UI, or run
   `kteam browser login stop --primed` from your own shell. If sign-in did not
   finish, use `kteam browser login stop` without `--primed`.

The login window is explicit and short-lived (15 minutes by default, 60 maximum).
Chrome has no CDP/debugging port while it is open, all agent browser control is
blocked, and x11vnc accepts one password-protected viewer on IPv4 loopback only.
There is deliberately no noVNC/websockify route; remote access must cross the SSH
tunnel. The VNC password is held in memory and is not written to the event journal
or durable login state.

Afterward, reuse is automatic. The first browser instance leases the signed-in
daemon profile; concurrent instances use their own persistent session profile and
report that fallback truthfully. Clean stop, idle expiry, crash handling, and
daemon shutdown release the lease. A newer Chrome version becomes the profile's
high-water mark, and an older Chrome is refused before it can alter the profile.

Do not copy the profile. A live copy is inconsistent (SQLite/LevelDB state and
Chrome lock files), macOS cookies are Keychain-bound and do not work on Linux, and
Linux keyring-backed cookies may be machine-bound. This Linux profile uses
`--password-store=basic`, so its `0700` directory is its protection: never put it
in a worktree, attachment, repository, or off-box backup.

This is the best honest compatibility path, not bot-protection evasion. The
headful browser no longer advertises `HeadlessChrome`, but a GPU-less host still
reports SwiftShader, a datacenter IP can remain high-risk, and normal automated
sessions attach CDP after the one-time login. Google and other high-security sites
may still refuse; kteam does not spoof fingerprints or bypass that decision.

## Attachments and document reading

Use repeatable `--file/-f` flags on `start` or `send`. The existing
`--image/-i` flag remains a compatibility alias. The web composer supports the
same allowlist and shows documents as file cards rather than broken image tiles.

- Images: PNG, JPEG, GIF, and WebP.
- Documents: PDF, UTF-8 plain text, Markdown, CSV, JSON, and DOCX.
- Legacy binary `.doc` files are not supported. Convert them to DOCX, PDF, or
  text first.
- Each original file is limited to 20 MiB. The daemon verifies bytes instead of
  trusting the filename or browser MIME declaration, derives a safe extension,
  and keeps the successful original downloadable.
- Text, Markdown, CSV, and JSON are delivered as verified local text paths.
- PDF text is extracted by kteam before the prompt is sent: at most the first
  100 pages, at most 250,000 retained characters, and a 15-second extraction
  deadline.
- DOCX is validated as an OOXML ZIP and read from `word/document.xml`. Styles,
  layout, images, and other non-text content are not retained.
- Prompt injection is bounded to 32,000 extracted characters per document and
  64,000 across one send. The prompt names the retained extraction path when an
  agent needs more of the bounded 250,000-character copy.
- Every extraction and truncation is disclosed in the agent prompt and UI. PDF
  extraction is text-only: page layout, figures, and scanned content are not
  included.
- Scanned/image-only PDFs, unreadable files, and password-protected PDF/DOCX
  files fail explicitly instead of producing an empty successful attachment.

The harnesses have different native file support, so kteam does not rely on it
for PDFs or DOCX:

| Input                 | Claude CLI                                                        | Codex CLI                                                                                   | kteam guarantee                                   |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| TXT/Markdown/CSV/JSON | Reads local text                                                  | Reads through shell tools                                                                   | Verified original path                            |
| PDF                   | Native reader can see text and rendered pages (20 pages per read) | No native document input; shell extraction is tool-dependent and text-only                  | Bounded daemon-side text extraction in the prompt |
| DOCX                  | Native reader refuses the binary                                  | No native document input                                                                    | Bounded OOXML text extraction in the prompt       |
| Images                | Can inspect the verified local path with vision                   | Native vision requires Codex's `-i`; a kteam path reference alone is not native image input | Verified original path only                       |

PDF parsing uses the pinned, serverless pdf.js bundle from `unpdf` with input
bytes only. Auto-fetch, streaming, worker fetch, Wasm, XFA, image decoding, font
rendering, and offscreen canvas are disabled; the daemon calls only
`getTextContent`, never annotations, links, scripts, or rendering. The pinned
bundle has no dynamic `eval`/`Function` path. `@napi-rs/canvas` is an optional
rendering peer and is not installed or used for text extraction.

Every session remains inspectable under `~/.kteam/<id>/`:

- `events.jsonl` — durable ordered event journal
- `chat.jsonl` — normalized native transcript messages
- `attachments/` — validated content-addressed originals and retained document text
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
