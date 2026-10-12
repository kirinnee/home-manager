# kslack

**Read-only** Slack CLI for the agent fleet: search, channels, DMs, history,
threads and users, from the shell. No MCP. A thin bun CLI in the
kloge/kteam mold: run-from-source, wrapper in `modules/default.nix`.

It cannot write. `src/client.ts` only calls an explicit allowlist of read
methods (`auth.test`, `search.messages`, `conversations.{list,history,replies,info,members}`,
`users.{info,list,conversations}`, `chat.getPermalink`); anything else throws
before a request is made. It never opens DMs or joins channels.

## One-time Slack app setup (human)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**;
   pick the workspace.
2. **OAuth & Permissions** → **User Token Scopes** (not Bot Token Scopes) → add:
   `channels:history`, `groups:history`, `im:history`, `mpim:history`,
   `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`,
   `search:read`. (Optional: `users:read.email` to see/search emails.)
3. **Install to Workspace** (on Enterprise Grid an admin may need to approve).
4. Copy the **User OAuth Token** (`xoxp-…`).
5. Add it to the decrypted `secrets.yaml` under `env:`:
   ```yaml
   env:
     SLACK_USER_TOKEN: xoxp-...
   ```
6. `./scripts/secrets/encrypt.sh`, commit `secrets.enc.yaml`, then `hms`. The
   token lands in `~/.secrets`, which every shell sources.

Check with `kslack auth`.

## Usage

```bash
kslack auth                                    # who am I (user, team, enterprise_id)
kslack search 'deploy from:@alice in:#eng' -n 30
kslack channels --type public,private          # conversations you are in
kslack dms -l 10                               # DMs + group DMs, most recent first
kslack history '#eng' --since 2d               # channel by name
kslack history @alice -l 20                    # existing DM with a user
kslack history C0123ABCD                       # by ID
kslack thread C0123ABCD 1700000000.123456      # a thread
kslack thread 'https://acme.slack.com/archives/C0123ABCD/p1700000000123456'
kslack users alice                             # find users (name/display/email)
```

Every command takes `--json` (raw Slack JSON) and `--team <id>` (Enterprise
Grid workspace; defaults to auth.test's team on Grid).

- Cursor pagination, HTTP 429 `Retry-After` retries, Slack `error` strings
  shown verbatim (with the `needed` scope on `missing_scope`).
- User names are cached in `~/.cache/kslack/users.json` (users only; no message
  content). Entries live 7 days; `kslack users --refresh` re-sweeps the list.
- The token is never printed, including in errors.

## Dev

```bash
cd modules/kslack-ts
bun install
bun test
bunx tsc --noEmit
```
