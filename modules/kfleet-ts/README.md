# kfleet

Generate and manage a fleet of AI-agent account wrappers — `claude-<name>`,
`codex-<name>` — from a single YAML file.
Replaces the old Nix `multi-{claude,codex}` home-manager modules.

Everything lives under `~/.kfleet/`:

```
~/.kfleet/
  config.yaml      # the fleet (you edit this)
  CLAUDE.md        # shared memory                    ┐ asset sources referenced
  CLAUDE.auto.md   # autonomous-variant memory       │ by profiles/agents via
  skills/  skills-codex/  hooks/  templates/         ┘ relative ./paths
  bin/             # generated wrappers — on PATH (home.sessionPath)
```

Per agent, `apply` writes a wrapper to `~/.kfleet/bin/<kind>-<name>` and
materializes its config dir: `~/.claude-<name>`, `~/.codex-<name>`. It only
touches the files it owns — sessions, auth, sqlite, etc. inside those dirs are
never removed.

If `defaultHomes` is configured, `apply` also materializes the selected resolved
agents into the bare CLI homes (`~/.claude`, `~/.codex`) so running `claude` or
`codex` without a kfleet wrapper gets the same managed settings, memory, hooks,
and skills. Existing auth/session state in those homes is left alone.

## Commands

```
kfleet init     # scaffold ~/.kfleet from the bundled templates (won't clobber)
kfleet apply    # generate wrappers + config dirs from config.yaml
kfleet apply --prune   # ...and remove managed wrappers no longer in config
kfleet list     # list configured agents + commands + aliases
kfleet prune    # remove managed wrappers no longer in config.yaml
kfleet doctor   # check PATH, config validity, agent binaries
kfleet health   # launch every auto-* agent with a sentinel prompt; report up/down
kfleet usage    # probe each subscription account (claude/codex/z.ai/minimax) for 5h + weekly usage + login
kfleet serve    # expose Prometheus metrics on /metrics + usage JSON on /usage (background re-probe)
kfleet service install|uninstall|status|restart   # run `serve` as a launchd/systemd service
```

Edit `~/.kfleet/config.yaml`, then run `kfleet apply`. That's the whole loop.

`health`/`serve` probe the **`auto-*`** wrappers (the non-interactive ones automation
drives) by actually launching each with a tiny "echo a sentinel" prompt — a real
(cheap) LLM call, so `serve` caches on an interval rather than probing per scrape.

The background probing in `serve` (and the installed service) is **OFF by default**
because each cycle is real LLM calls. Turn it on + tune it via `config.yaml`:

```yaml
health:
  enabled: true # default false — serve/service won't auto-probe until set
  interval: 300 # seconds between background re-probes
  concurrency: 8 # agents probed at once
  timeout: 90 # seconds per probe before it's "down"
```

`kfleet health` (the explicit one-shot) always runs regardless; `kfleet serve --probe`
forces the background loop on without editing config.

### Account usage (`kfleet usage`)

`kfleet usage` reports, per **subscription/usage-windowed** account, how much of its
5-hour and weekly limits are used — so you can see (and automate around) accounts that
are maxed out — plus whether each account is **logged in** (`auth_ok`). It tracks four
providers and reads each one's usage from the same read-only endpoint the underlying CLI
uses, so it **does not consume any quota**:

| Provider    | Accounts               | Source                                                                        |
| ----------- | ---------------------- | ----------------------------------------------------------------------------- |
| `anthropic` | Claude Max/Pro (OAuth) | `api.anthropic.com/api/oauth/usage` (token from the Keychain)                 |
| `codex`     | Codex / ChatGPT plan   | `chatgpt.com/backend-api/codex/usage` (token from `auth.json`)                |
| `zai`       | z.ai GLM coding plan   | `api.z.ai/api/monitor/usage/quota/limit` (the `$ZAI_API_KEY_*` key)           |
| `minimax`   | MiniMax coding plan    | `api.minimax.io/v1/token_plan/remains` (the `$MINIMAX_API_KEY`, `.io` region) |

Every other account (deepseek/raw API keys) reports `usageBased: false` in `/usage` and
`kfleet_account_usage_based 0` in Prometheus, and is left alone. Probes are deduped by
credential — many wrappers sharing one key/account are probed once.

**Logged-in (`auth_ok`)** is a separate, **token-free** signal: `1` = has a currently
**usable** (present, non-expired) token, `0` = missing/expired/rejected (re-auth needed),
absent = couldn't tell. The pre-probe relogin (below) refreshes a refreshable token first,
so a token still expired _after_ relogin means its refresh token is dead and the account
needs an interactive `claude`/`codex login`. Auth is judged by token validity, **not** by
whether the usage probe returned data — some endpoints (codex) serve usage on a stale
token, so a maxed-out-looking account can still be `auth_ok = 0`.

**Pre-probe re-login** (`relogin`, default on): before each cycle, any OAuth account whose
access token is expired/near-expiry is refreshed **token-free** by driving the CLI through a
no-inference path (`claude mcp list`; codex `app-server` `getAuthStatus`) so it rotates the
token via its refresh token — then the usage read sees a fresh token instead of "expired". It
only fires near expiry (Claude tokens last ~18h, Codex ~10d), and a fully-dead refresh token
still needs an interactive `claude`/`codex login`. Because it's cheap and read-only,
background usage probing in `serve` is **ON by default**; tune it via `config.yaml`:

```yaml
usage:
  enabled: true # default true — read-only, no quota used
  interval: 60 # seconds between background re-probes (before jitter)
  jitter: 0.25 # ± fraction of interval, so a fleet's probes don't sync up
  relogin: true # token-free refresh of expired OAuth tokens before probing
  concurrency: 6 # credentials probed at once
  timeout: 15 # seconds per HTTP probe
  atLimitPercent: 100 # 5h OR weekly ≥ this ⇒ "at limit" (exhausted)
```

`kfleet serve` exposes this two ways:

- **`/metrics`** — `kfleet_account_usage_based`, `kfleet_account_usage_5h_percent`,
  `kfleet_account_usage_weekly_percent`, `kfleet_account_usage_{5h,weekly}_reset_seconds`,
  `kfleet_account_at_limit`, `kfleet_account_usage_ok`, `kfleet_account_auth_ok`
  (all labelled `binary`/`kind`/`provider`).
- **`/usage`** — a JSON snapshot (`{ at, accounts[] }`) that **kloop** consumes for
  usage-aware account selection (see kloop's `requireUsageLeft`).

## config.yaml

**Everything composes from profiles.** A wrapper is generated for every
**agent × variant**. Its fields merge, right overriding left:

```
base  →  agent.profiles  →  variant.profiles  →  variant.inline  →  agent.inline
```

Merge rules: `env` objects merge, `flags` and `settings` layers concatenate,
everything else (paths) replaces (last wins). Profiles are flat (they don't
reference each other) — all composition happens in the `profiles:` / `variants:`
lists.

```yaml
profiles:
  claude: { settings: ./templates/claude/settings.json, skills: ./skills }
  codex: { hooks: ./templates/codex/hooks.json, hooksDir: ./hooks, skills: ./skills-codex }
  # direct upstream Anthropic-compatible endpoints (keys come from ~/.secrets env)
  zai-a: { env: { ANTHROPIC_AUTH_TOKEN: $ZAI_API_KEY_A, ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic } }
  deepseek: { env: { ANTHROPIC_AUTH_TOKEN: $DEEPSEEK_API_KEY, ANTHROPIC_BASE_URL: https://api.deepseek.com/anthropic } }

variants: # every agent is cloned across all of these
  default: { memory: ./CLAUDE.md } # no name infix → claude-kirin
  auto: { memory: ./CLAUDE.auto.md } # infix → claude-auto-kirin

defaultHomes: # optional: configure the bare upstream CLI homes too
  claude: kirin # ~/.claude gets the same assets as claude-kirin
  codex: personal # ~/.codex gets the same assets as codex-personal

agents: # define each ONCE — variants generate the auto-* clones
  - { name: kirin, kind: claude, profiles: [claude] } # manual Anthropic OAuth
  - { name: glm52a, kind: claude, profiles: [claude, zai-a], env: { ANTHROPIC_DEFAULT_OPUS_MODEL: glm-5.2, ... } }
  - { name: loai, kind: codex, profiles: [codex], settings: ./templates/codex/chatgpt.toml }

# Aliases fan ONE entry out across the whole fleet: per listed kind, the alias
# REPLACES the kind prefix (keeping any variant infix) → <alias>-<name> execing
# <kind>-<name>. Flags are per-kind. Whitespace string or a list.
aliases:
  yolo:
    claude: --dangerously-skip-permissions # → yolo-kirin, yolo-auto-kirin, yolo-glm52a, …
  crc:
    claude: --dangerously-skip-permissions --chrome --rc # → crc-kirin, crc-auto-kirin, …
```

That yields `claude-kirin` **and** `claude-auto-kirin` (etc.) from one definition.

### Fields

**Profile** (a flat, reusable bundle) — any of: `env`, `flags`, `settings`,
`memory`, `skills`, `hooks` (codex hooks.json), `hooksDir`, `mcp`. All paths are
relative to `~/.kfleet` (or `~/…` / absolute). The per-kind generator drops each
asset to the right filename in the config dir (e.g. `settings` → `settings.json`
for claude, `config.toml` for codex — copied not symlinked since codex rewrites it;
`memory` → `CLAUDE.md` for claude, `AGENTS.md` for codex).

`settings` is **layered**: a file path, an inline object of override values, or a
list of either. Layers **accumulate across the merge chain** (like `flags`) and are
deep-merged left→right into the destination file — parsed/serialized per kind
(codex:TOML claude:JSON). Define the base file once (e.g. on the kind profile) and
layer overrides on top elsewhere; the base needn't be repeated. A lone file-path
layer is emitted verbatim (copy/symlink, no parse → comments & formatting kept); the
moment an override merges on, the file is re-serialized (TOML round-trip drops
comments), so keep durable docs in `config.yaml`, not the base toml.

A profile/variant/agent may also carry **kind-scoped overlays** — a `claude:` or
`codex:` block of the same fields that merges in **only for an agent of that kind**,
then is dropped. The overlay folds into its own slot (it overrides that block's flat
scalar fields, but a later slot's flat field still wins), so `env`/`flags`/`settings`
accumulate and scalars last-win exactly as the flat fields do. This is how a single
cross-kind variant varies a per-kind asset — e.g. give codex's interactive wrappers a
`fast` service tier without that override ever reaching a claude wrapper, by layering
an inline override onto the codex profile's base `config.toml`:

```yaml
profiles:
  codex: { settings: ./templates/codex/chatgpt.toml } # base config.toml
variants:
  default:
    memory: ./CLAUDE.md
    codex: { settings: { service_tier: fast } } # merges on top; auto variant omits it
```

**Agent** — `name`, `kind` (`claude|codex`), optional `profiles: [...]`, plus any
profile field inline (including `claude:`/`codex:` overlays).

**Variant** — a profile-composition cloned across every agent: optional
`profiles: [...]` + any profile field inline. The `default` variant always exists
(no name infix); any other variant `V` infixes `V-`. Cross-kind-**uniform** overlays
(memory, skills, mcp, env) go inline; anything that **differs per kind** (notably
`settings`, whose destination differs) goes in a `claude:`/`codex:` overlay.

**Default homes** — optional `defaultHomes: { claude: <target>, codex: <target> }`.
Each target may be a resolved agent name (`kirin`, `personal`) or a full wrapper
name (`claude-kirin`, `codex-personal`). `kfleet apply` writes that agent's owned
assets into the bare CLI home (`~/.claude` / `~/.codex`) in addition to the normal
per-agent home. It does not delete auth, sessions, sqlite databases, or other
unmanaged files already in those homes.

**Alias** — `name` → `{ <kind>: flags }`. Fans out into one command per agent of
each listed kind: the alias **replaces the kind prefix** (keeping any variant
infix), so `<alias>-<name>` execs `<kind>-<name>` with the flags — e.g. claude
agents `kirin` / `auto-kirin` → `yolo-kirin` / `yolo-auto-kirin`. Per-kind because
each harness's flags differ (claude `--dangerously-skip-permissions`, codex
`--full-auto`, …). This is the one-line way to give the whole fleet `yolo-*` /
`crc-*` — including the exact names `klaude` (`crc-kirin`) and `rc-session`
(`yolo-{kirin,liftoff,atomi}`) expect.

**Command** — `name` (the generated binary), `target` (an agent wrapper name like
`claude-kirin`), `flags` (prepended before the user's args). Generates
`~/.kfleet/bin/<name>` that execs the target wrapper with the flags. For one-off
targeted commands; prefer `aliases` for fleet-wide flag bundles.

## Notes

- `$` in env values is intentionally **not** shell-escaped, so `$HOME` and
  `$API_CLI_PROXY_TOKEN` expand at runtime in the generated wrappers.
- claude hooks are baked into its `settings.json` (one file), not merged at
  runtime; codex hooks are a separate `hooks.json`.
- After `hms`, home-manager's generation cleanup removes the materialized
  symlinks — re-run `kfleet apply` afterwards.
- Run-from-source via bun (no build step); `bun run ./src/index.ts`. Checks:
  `tsc --noEmit && knip && bun test`.

```

```
