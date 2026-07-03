# khost-ts

Host-exposure suite: SSH over a Cloudflare Tunnel + Grafana Alloy metrics.

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

## Config: `~/.khost/` (standalone, no monorepo, no sops)

All config lives under `~/.khost/` — khost reads nothing from this repo at
runtime. Override the dir with `KHOST_CONFIG_DIR`.

```sh
khost init     # scaffold ~/.khost/config.yaml + alloy.alloy
khost doctor   # preflight: tools, sshd, config, Cloudflare, Alloy
khost up       # bring up ssh + alloy + tunnel + routes
```

- **`~/.khost/config.yaml`** — everything: `machine`, `ssh`, `tunnel`,
  `cloudflare` (account_id + api_token), `access`, `routes`, `alloy`, `metrics`.
  Plaintext (it's in your home dir, never a repo).
- **Access policy ownership:** `access.policy` names an externally-managed
  reusable Cloudflare Access policy. khost looks it up by exact name and attaches
  it to owned apps; it does not create, update, or delete reusable policies.
- **`~/.khost/alloy.alloy`** — the full Grafana Alloy config. `khost alloy up`
  copies it into the runtime state dir and runs docker compose (UI on `:12345`).
  Scrapes the local kloop/kautopilot/kfleet exporters by default. To ship metrics
  out, uncomment the `remote_write` block (it reads `sys.env(...)`) and set the
  destination in `config.yaml`'s `alloy.remote_write` (url/username/password) —
  **the token: env wins** (`ALLOY_REMOTE_WRITE_PASSWORD`), so it can stay out of
  plaintext. khost injects these into the container at `up` time; the generated
  compose file holds no secret. `khost alloy edit` opens the config.
- **`khost metrics`** — khost's own Prometheus exporter (`khost metrics serve`,
  port 47319): ssh-into-self (loopback + mesh), alloy/docker up, Cloudflare
  tunnel health + connections, route drift, and credential validity. Run it as a
  background service with `khost metrics service install` (launchd/systemd).
- **Machine identity** = `config.machine` (else the sanitized short hostname).
  It drives the tunnel name (`khost-<machine>`) and the `{machine}` route token.
- **No secrets infra:** Cloudflare creds are plaintext in `~/.khost` (env wins for
  the Alloy remote_write token). No sops/age. Zones are auto-discovered.
