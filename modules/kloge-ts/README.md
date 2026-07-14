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
  compose.yaml                             # docker: eceasy/cli-proxy-api, mounts the above
        │  kloge up            │  kloge push user@box
        ▼                      ▼
  docker @ 127.0.0.1:8317   docker @ box 127.0.0.1:8317
```

CLIProxyAPI runs **only in Docker** (image `eceasy/cli-proxy-api`, upstream
`github.com/router-for-me/CLIProxyAPI`). The container mounts `./auth` at
`/root/.cli-proxy-api` and `./config.yaml` at `/CLIProxyAPI/config.yaml`. The
port is bound to `127.0.0.1` on whichever host it runs on.

## Usage

```bash
kloge pull                     # pull creds + render config/compose (kubectl, ctx eks-llm-us-east-1)
kloge pull -c <other-context>  # pull from a different kube context
kloge up                       # start the container locally -> http://127.0.0.1:8317
kloge status                   # data dir, creds, container state, served models
kloge logs -f                  # follow container logs
kloge down                     # stop the local container

kloge push user@box            # rsync ~/.kloge to the box and start it there
kloge push user@box --no-up    # copy only, don't start
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
- `KLOGE_IMAGE` — pin the CLIProxyAPI image (default `eceasy/cli-proxy-api:latest`).
- `KLOGE_API_KEY` — client-facing placeholder key (default `loge-internal`).

## Notes

- Requires `kubectl` (creds pull) with a valid kubeconfig + AWS auth for the
  context, `docker` (compose v2 or v1), and for `push`, `rsync` + `ssh`.
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
