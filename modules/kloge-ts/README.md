# kloge

Run the **loge credential pool** locally (or on a box) via **CLIProxyAPI in
Docker**, so Claude Code / Codex / anything OpenAI- or Anthropic-compatible can
hit `http://127.0.0.1:8317` without the loge gateway or the tailnet.

`kloge` is a thin bun CLI in the kteam/kfleet/khost mold: run-from-source,
config under `~/.kloge/`.

## ⚠️ Read this first

`kloge pull` copies **shared production credentials** (the loge OAuth pool) out
of the `loge/loge-credentials` Kubernetes Secret onto this machine — and
`kloge push` copies them to a box. That is a real security trade-off:

- Running the **same OAuth sessions** from extra locations/IPs (cluster + your
  laptop + a box) is exactly the pattern Anthropic/OpenAI flag as account
  sharing. A suspension takes **loge down for everyone**, not just you.
- The auth files are live provider credentials. `~/.kloge` is created `0700`
  and the files `0600`, but they are plaintext on disk.
- Prefer just pointing tools at the loge endpoint (`loge-internal` key) if you
  have tailnet or kube access. Use `kloge` only when you genuinely need a
  local/offline proxy, and consider provisioning your **own** credential rather
  than mirroring the shared pool.

## How it works

```
loge/loge-credentials (k8s Secret)         # 3 codex + 3 claude OAuth creds
        │  kloge pull  (kubectl get secret -o json)
        ▼
~/.kloge/
  auth/                                    # CLIProxyAPI auth files (type-tagged)
    codex-1.json codex-2.json codex-3.json
    claude-1.json claude-2.json claude-3.json
  config.yaml                              # CLIProxyAPI config (api key: loge-internal)
  management-key                          # generated management bearer key (mode 0600)
  compose.yaml                             # docker: maintained model-aware image, mounts the above
        │  kloge up            │  kloge push user@box
        ▼                      ▼
  docker @ 127.0.0.1:8317   docker @ box 127.0.0.1:8317
```

CLIProxyAPI runs **only in Docker**. The default image is the locally built,
pinned `kloge-cliproxy:patched` fork of
`github.com/router-for-me/CLIProxyAPI`; set `KLOGE_IMAGE` to the upstream image
only as an explicit rollback. The container mounts `./auth` at
`/root/.cli-proxy-api` and `./config.yaml` at `/CLIProxyAPI/config.yaml`. The
port is bound to `127.0.0.1` on whichever host it runs on.

## Usage

```bash
kloge build                    # build the default maintained image with claude-opus-5
kloge pull                     # pull creds + render config/compose (kubectl, ctx eks-llm-us-east-1)
kloge pull -c <other-context>  # pull from a different kube context
kloge up                       # start the container locally -> http://127.0.0.1:8317
kloge status                   # data dir, creds, container state, served models
kloge logs -f                  # follow container logs
kloge down                     # stop the local container

kloge push user@box --no-up    # copy only; build/load the maintained image there, then start it
```

Point a client at it (real upstream model IDs — this CLIProxyAPI version does
not alias to `fable-5`/`opus-4.8`):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_API_KEY=loge-internal
# models: claude-fable-5, claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5-20251001
# codex/openai: gpt-5.5
```

To reach a box's proxy from here, tunnel it (it's bound to the box's localhost):

```bash
ssh -N -L 8317:127.0.0.1:8317 user@box
```

## Config / env knobs

- `KLOGE_DIR` — data dir (default `~/.kloge`).
- `KLOGE_PORT` — fallback port when `config.yaml` is absent (default `8317`);
  the rendered `config.yaml` is the source of truth once it exists.
- `KLOGE_IMAGE` — override the CLIProxyAPI image (default
  `kloge-cliproxy:patched`; use `eceasy/cli-proxy-api:latest` for rollback).
- `KLOGE_API_KEY` — client-facing placeholder key (default `loge-internal`).
- `KLOGE_HOME_MANAGER_DIR` — checkout containing `kfleet/config.yaml`,
  `secrets.yaml`, and `scripts/secrets/{decrypt,encrypt}.sh` (default
  `$HM_CONFIG_DIR` or `~/.config/home-manager`). During `kloge pull`, Claude
  slots 1–6 are additionally written to the `secrets-file` keys declared by
  their kfleet agents. Kloge edits the decrypted `secrets.yaml`, invokes the
  repository encrypt script, and retains all existing CLIProxyAPI auth files.
  Run `hms` afterwards to materialize the refreshed values into `~/.secrets`.
- `KLOGE_MANAGEMENT_KEY` — optional management-key import/rotation value. On
  render, kloge persists it to `~/.kloge/management-key` with mode `0600`;
  otherwise it generates a durable random key there. This key is separate from
  the client API key. Point kfleet's matching source at it with
  `usage.cliProxy[].managementKeyFile` and never put provider credentials there.

The rendered compose publishes the proxy only on host loopback. CLIProxyAPI's
`remote-management.allow-remote` is enabled because Docker presents host-local
requests as bridge-peer traffic inside the container; the bearer key is still
required, the control panel is disabled, and kfleet consumes only
`GET /v0/management/auth-files`. A
management outage is reported as unknown by kfleet; it never fabricates quota or
auth failure from an unreachable proxy. The vanilla auth-files response is not
model-aware, so aggregate availability remains unknown. The maintained image
adds a redacted per-model state projection; with that image, kfleet marks a
wrapper down only when every enabled credential is blocked for the wrapper's
served primary model. Missing or sparse model state remains unknown.

## Maintained model-catalog image

Upstream's embedded catalog can lag newly released models and its management
response omits model-scoped availability. This repository contains a pinned,
auditable build recipe under `cliproxy-fork/` that applies a small model-catalog
overlay plus a redacted model-state response patch and builds
`kloge-cliproxy:patched`. It is the rendered default so the configured kfleet
probe is not silently left on an availability-blind upstream image:

```bash
kloge build
kloge render
kloge up
```

For this image, the rendered compose uses `pull_policy: never` and starts the
binary with `--local-model`, preventing the three-hour remote catalog refresh
from replacing maintained additions. Because the tag is local and compose uses
`pull_policy: never`, `kloge up` fails visibly if `kloge build` has not produced
it. To roll back, explicitly render the upstream image and run `kloge up`:

```bash
KLOGE_IMAGE=eceasy/cli-proxy-api:latest kloge render
kloge up
```

The patched tag exists only in the Docker store where `kloge build` ran.
`kloge push` therefore refuses to auto-start the default patched compose on a
remote host. Build or load `kloge-cliproxy:patched` on that host first, use
`kloge push <host> --no-up`, then start the copied compose there manually.

## Notes

- Requires `kubectl` (creds pull) with a valid kubeconfig + AWS auth for the
  context, `docker` (compose v2 or v1), and for `push`, `rsync` + `ssh`.
  `kloge build` additionally uses `git` to fetch the pinned upstream source and
  `jq` to validate the patched model catalog before compiling it.
- **Auth: `kloge pull` needs the DevOps role.** The LLM cluster
  (`eks-llm-us-east-1`) only authorizes `vungle2-DevOpsRole` — the default
  `vungle2-EngineeringRole` gets 401 for every read there. kloge shells plain
  `kubectl`, so make sure that context's AWS credentials are the DevOps role
  before pulling (e.g. via `loctl ops role vungle2-DevOpsRole`, which regenerates
  the kubeconfig, then switch back after). `pull` only does a read-only `get`.
- The pool is not fixed at 1..3 — kloge writes a file per `CODEX_OAUTH_TOKEN_PE_LLM_N`
  and `CLAUDE_CODE_OAUTH_TOKEN_PE_LLM_N` key it finds (14 as of this writing).
- Token normalization mirrors loge's `src/config.ts` so the auth files are
  byte-compatible with what loge renders. If loge changes, update `src/tokens.ts`.
- The pulled snapshot drifts: raw `sk-ant-oat…` Claude tokens don't refresh and
  expire; re-run `kloge pull` (and `kloge push`) to refresh.
