# khost-ts

Host-exposure suite: CLIProxyAPI `:8317` + SSH over Cloudflare Tunnel.

## Runtime: dynamic (`bun run` from source)

This app is **not built into Nix**. Home Manager installs only a thin wrapper
that runs `bun run …/khost-ts/src/index.ts`, so:

- **Edits to `src/` apply immediately** — no `hms`/rebuild needed.
- There is **no `node_modules` in the repo**. Bun auto-installs dependencies into
  its global cache (`~/.bun/install/cache`) on first run.
- ⚠️ **Do not commit or leave a `node_modules/` here.** A local `node_modules`
  gets copied into the Nix store on every `hms` and makes rebuilds slow. If you
  run `bun install`, delete `node_modules` afterward — the global cache stays
  warm, so the app keeps working.

## Proxy config: declarative skeleton + sops fragment

The runtime config (`~/.local/state/khost/proxy/config.yaml`) is **regenerated
on every `khost proxy up`** by merging two committed files:

- `proxy/config.skeleton.yaml` — non-secret config (plaintext, comments preserved).
- `proxy/config.secrets.enc.yaml` — secret subtrees (API keys, tokens, etc.),
  sops-encrypted.

Because `up` re-renders, **edits made through the CLIProxyAPI control panel /
management API are not durable on their own** — the next re-render would
overwrite them. `khost proxy capture` folds them back into the two committed
files so they survive:

- `khost proxy up` / `khost proxy down` run capture **automatically** first, so
  panel edits are absorbed, not lost. (No-op when already in sync — sops is only
  re-encrypted when a secret actually changed, so there's no git churn.)
- Run `khost proxy capture` manually anytime to pull the live config into the
  repo, then **commit** `proxy/config.skeleton.yaml` + `proxy/config.secrets.enc.yaml`.
- Prefer editing secrets directly with `khost proxy edit` (sops) when you don't
  need the panel.

Secret sections (see `secretPaths` in `src/deps.ts`) always go to the encrypted
fragment — capture never writes a credential into the plaintext skeleton.
