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

## Commands

```
kfleet init     # scaffold ~/.kfleet from the bundled templates (won't clobber)
kfleet apply    # generate wrappers + config dirs from config.yaml
kfleet apply --prune   # ...and remove managed wrappers no longer in config
kfleet list     # list configured agents + commands + aliases
kfleet prune    # remove managed wrappers no longer in config.yaml
kfleet doctor   # check PATH, config validity, agent binaries
kfleet health   # launch every auto-* agent with a sentinel prompt; report up/down
kfleet serve    # expose Prometheus fleet-health metrics on /metrics (background re-probe)
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

## config.yaml

**Everything composes from profiles.** A wrapper is generated for every
**agent × variant**. Its fields merge, right overriding left:

```
base  →  agent.profiles  →  variant.profiles  →  variant.inline  →  agent.inline
```

Merge rules: `env` objects merge, `flags` arrays concatenate, everything else
(paths) replaces (last wins). Profiles are flat (they don't reference each other)
— all composition happens in the `profiles:` / `variants:` lists.

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

**Agent** — `name`, `kind` (`claude|codex`), optional `profiles: [...]`, plus any
profile field inline.

**Variant** — a profile-composition cloned across every agent: optional
`profiles: [...]` + any profile field inline. The `default` variant always exists
(no name infix); any other variant `V` infixes `V-`. Keep cross-kind-**uniform**
overlays here (memory, skills, mcp, env) — not `settings` (which differs per kind).

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
