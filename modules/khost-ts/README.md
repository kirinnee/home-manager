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
