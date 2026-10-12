# kslack-proxy

One Slack MCP login per machine, shared by every `claude-*` and `codex-*` account.

Slack's official MCP server (`https://mcp.slack.com/mcp`) uses **rotating** OAuth
tokens: the access token lives ~12h and every refresh hands out a new,
single-use refresh token. If 15+ account homes each held a login, they would
each need a browser login, and two owners of the same refresh token would
invalidate each other. So each machine (Mac, pebox, kirin-box) runs this small
proxy instead:

```
claude-* / codex-*  ──►  http://127.0.0.1:37373/mcp  (no auth)
                              │  kslack-proxy: adds Bearer token, refreshes it,
                              │  hides + blocks write tools
                              ▼
                     https://mcp.slack.com/mcp
```

## Log in (once per machine)

**Mac:**

```bash
kslack-proxy login        # opens the browser; callback on localhost:3118
kslack-proxy status
```

**Headless box (pebox, kirin-box):** forward the callback port from your laptop,
then log in on the box and open the printed URL in your laptop's browser:

```bash
ssh -L 3118:localhost:3118 <box>
kslack-proxy login --no-browser
```

If port 3118 is busy (often a Claude Code session in the middle of its own Slack
login), `login` stops and prints `lsof -nP -iTCP:3118 -sTCP:LISTEN` so you can
find it. Wait for it to finish, or stop it, then retry.

`login` asks only for **read** scopes. `--all-scopes` asks for everything Slack
offers (writes included). It is only useful together with
`KSLACK_PROXY_ALLOW_WRITES=1`.

The OAuth client is Claude Code's public Slack client
(`1601185624273.8899143856786`, PKCE, no client secret, redirect
`http://localhost:3118/callback`). Endpoints are discovered from
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

## Commands

| Command                                      | What it does                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kslack-proxy login`                         | Browser OAuth (PKCE). Saves the token set. A running `serve` picks it up without a restart.                                                                    |
| `kslack-proxy serve`                         | Runs the MCP proxy on `127.0.0.1:${KSLACK_PROXY_PORT:-37373}/mcp` and `/healthz`. The service manager runs this; you normally don't.                           |
| `kslack-proxy status [--json] [--no-verify]` | Shows: logged in or not, who (via `auth.test`), token expiry, last refresh, scopes, whether the service is listening. Never prints tokens and never refreshes. |
| `kslack-proxy logout`                        | Deletes the stored tokens.                                                                                                                                     |

## How it behaves

- **Token file:** `~/.local/state/kslack-proxy/token.json`. The directory is 0700 and the file is 0600. Every write goes to a temp file, is fsynced, then renamed into place. The token is deliberately **not** in sops because it rotates.
- **Refresh:** the proxy refreshes early, when less than 10 minutes are left, and again on an upstream 401 (then retries the request once). Only one refresh can run at a time, so concurrent requests never spend the refresh token twice. The new token set is saved **before** it is used. Only `serve` refreshes.
- **Dead session:** if the refresh token was revoked or already spent, requests get HTTP 503 with a JSON-RPC error: `… run kslack-proxy login`. The proxy stays up and does not crash-loop. A new `login` fixes it with no restart.
- **Pass-through:** POST, GET (SSE) and DELETE are forwarded, with `Mcp-Session-Id`, `MCP-Protocol-Version`, `Accept` and the other headers. SSE responses are streamed through as they arrive. Any `Authorization` header from the client is removed.
- **No secrets in logs:** log lines and error bodies are scrubbed of tokens (`xox…`, `Bearer …`, `*_token=`).
- **Env knobs:** `KSLACK_PROXY_PORT` (default 37373), `KSLACK_PROXY_STATE_DIR`, `KSLACK_PROXY_ALLOW_WRITES=1`, `KSLACK_PROXY_UPSTREAM` (for tests).

## Read-only policy (default ON)

The policy is an **allowlist**, so any new tool Slack adds is blocked until
someone adds it here (`src/policy.ts`). The proxy filters `tools/list` results
(plain JSON and SSE frames) down to the allowlist. A `tools/call` for any other
tool is rejected with JSON-RPC error `-32003` and never reaches Slack.
`KSLACK_PROXY_ALLOW_WRITES=1` on the proxy turns both filters off.

These tools were observed on `mcp.slack.com` in 2026-10, from real fleet session
transcripts:

| Allowed (read)                    | Blocked (write)              |
| --------------------------------- | ---------------------------- |
| `slack_search_public`             | `slack_send_message`         |
| `slack_search_public_and_private` | `slack_send_message_draft`   |
| `slack_search_channels`           | `slack_schedule_message`     |
| `slack_search_users`              | `slack_create_canvas`        |
| `slack_search_emojis`             | `slack_update_canvas`        |
| `slack_read_channel`              | `slack_create_conversation`  |
| `slack_read_thread`               | `slack_add_reaction`         |
| `slack_read_canvas`               | `slack_get_file_upload_url`  |
| `slack_read_file`                 | `slack_complete_file_upload` |
| `slack_read_list`                 | `slack_create_list`          |
| `slack_read_user_profile`         | `slack_update_list`          |
| `slack_list_user_channels`        | `slack_add_list_record`      |
| `slack_list_channel_members`      | `slack_update_list_record`   |
| `slack_get_reactions`             |                              |

## Service

- **macOS:** home-manager `launchd.agents.kslack-proxy` (`home-template.nix`), with `KeepAlive` on. Logs go to `~/Library/Logs/kslack-proxy.log`.
- **Linux boxes:** the systemd user unit `kslack-proxy.service`. Activation enables it and restarts it on every `hms`. Logs: `journalctl --user -u kslack-proxy`.

The wrapper (`modules/default.nix`) runs from source. On a fresh checkout it
first runs `bun install --frozen-lockfile`.

## How fleet accounts are wired

kfleet (`kfleet/config.yaml`) does the wiring, so every account on every
machine gets it after `hms`:

- **Claude:** `profiles.claude.mcp: ./templates/claude/mcp.json`. kfleet merges that `mcpServers` map into each home's `.claude.json`, which is where Claude Code reads **user-scope** servers. `$CLAUDE_CONFIG_DIR/.mcp.json` is never loaded, because that file name is project scope. The names kfleet owns are recorded in `.kfleet-mcp.json`. A fleet entry replaces a hand-added server of the same name, such as an old direct `slack` OAuth entry.
- **Codex:** `[mcp_servers.slack] url = "http://127.0.0.1:37373/mcp"` in `kfleet/templates/codex/chatgpt.toml`. Codex treats it as `streamable_http`.

Both entries have no auth, because the proxy adds it.

## Develop

```bash
bun install && bun test && bunx tsc --noEmit
```
