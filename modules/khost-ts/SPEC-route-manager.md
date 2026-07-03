# khost route-manager — SPEC

Status: **draft for review** · Owner: kirin · Module: `modules/khost-ts`

## 1. Goal

Turn khost into a **declarative manager of "domains that route to my computer"** over a
**single Cloudflare Tunnel** (one tunnel per host — every hostname is just another entry
in that one tunnel's ingress list; khost never creates a second tunnel). Today khost
creates the tunnel and runs `cloudflared`, but the
actual public-hostname → local-service routing (and the DNS + access gating) is managed
by hand in the Cloudflare dashboard (`config_src: cloudflare`). This feature makes khost
own that routing as committed, idempotent config.

One source of truth (a committed `routes` list) → khost reconciles, per route:

1. **Tunnel ingress** — hostname → a local service (`http://localhost:8317`, `ssh://localhost:22`, …)
2. **DNS** — a proxied CNAME for the hostname → `<tunnel-id>.cfargotunnel.com`
3. **Access application** — a self-hosted Access app bound to the hostname
4. **Access policy** — allow **only me** (a configured email allow-list)

Running `khost up` brings the live Cloudflare state in line with the committed list.

### Non-goals

- Managing the tunnel lifecycle (already done by `tunnel.ts`).
- Creating identity providers (IdP) — khost only **verifies** one exists.
- Managing WARP / device-posture enrollment.
- Multi-account / multi-tunnel routing (one tunnel per host, as today).

## 2. Decisions already made

- **Account:** the **AtomiCloud** Cloudflare account (`177aa484a66427793543c5e958f8d020`,
  user ernest@atomi.cloud). Zone `atomi.cloud` (zone id `41201a882e27c65d82c19455d80b2fed`)
  lives here, as will the tunnel. (Not the earlier `f9bb…` account — that was a wrong turn.)
- **Domain:** routes hang off **`ernest.atomi.cloud`** (e.g. `proxy.ernest.atomi.cloud`,
  `ssh.ernest.atomi.cloud`).
- **Access:** already enabled on this account; IdPs available = **One-time PIN** + Auth0
  SAML, so an email allow-list works with no extra setup.
- **Token:** the `cfut_…` "khost token" in sops has all required scopes (verified). See the
  memory note `khost-cloudflare-token` for the roll procedure.
- **Scope:** khost manages routes, DNS, and Access applications. It **does not**
  manage reusable account-level Access policies; those are externally managed and
  looked up by exact name.
- **Config-driven:** no hostnames or policy contents are hardcoded in the repo.
  Hostnames come from `~/.khost/config.yaml`; the Access policy name comes from
  `access.policy`.
- **Tailscale is out:** it cannot run alongside company Cloudflare WARP.

## 3. Configuration

### 3.1 `~/.khost/config.yaml` → `routes:` (plaintext, in your home dir)

```yaml
# Declarative list of public hostnames that route to this host through the
# khost Cloudflare Tunnel. Reconciled by `khost route sync` / `khost up`.
routes:
  - hostname: kloop.ernest.atomi.cloud
    service: http://localhost:47316 # the kloop dashboard
  - hostname: ssh.ernest.atomi.cloud
    service: ssh://localhost:22 # SSH over the tunnel (browser-rendered)
  # - hostname: foo.ernest.atomi.cloud
  #   service: http://localhost:3000
  #   access: false                  # opt out of an Access app (rare)
  # - hostname: admin.ernest.atomi.cloud
  #   service: http://localhost:3001
  #   access: other-reusable-policy  # per-route policy override
```

Per-route fields:

| field      | required | default | meaning                                                                                        |
| ---------- | -------- | ------- | ---------------------------------------------------------------------------------------------- |
| `hostname` | yes      | —       | FQDN; its zone must exist in the tunnel's account                                              |
| `service`  | yes      | —       | cloudflared service URL (`http://`, `https://`, `ssh://`, `tcp://`)                            |
| `access`   | no       | `true`  | `true` attaches `access.policy`; `false` skips Access; string names a reusable policy override |

### 3.2 Environment (via sops `~/.secrets`)

| env var                 | required | default | meaning                     |
| ----------------------- | -------- | ------- | --------------------------- |
| `CLOUDFLARE_API_TOKEN`  | yes      | —       | **expanded** token (see §6) |
| `CLOUDFLARE_ACCOUNT_ID` | yes      | —       | unchanged                   |

## 4. CLI surface

```
khost route ls            # show desired (routes.yaml) vs live (tunnel/DNS/access) state
khost route sync          # reconcile live state to routes.yaml (idempotent)
khost route sync --prune  # also delete live routes/DNS/apps not in routes.yaml
khost route sync --dry-run  # print the plan, change nothing
```

`khost up` calls `route sync` after `tunnelUp` (self-guards: no-op when routes.yaml is
empty or Cloudflare creds/zone are absent, mirroring `requireCf()`).

## 5. Reconcile algorithm

Preconditions (fail fast with actionable messages):

- Cloudflare creds present + token verifies (reuse `verifyToken` / `verifyAccount`).
- Tunnel exists (reuse `findTunnel`); else tell the user to run `khost tunnel up`.
- At least one Access IdP exists in the account (else Access apps cannot bind) — warn,
  and skip the Access step rather than hard-fail, so routes+DNS still apply.
- The configured reusable Access policy exists by exact name. khost only reads it
  and attaches the returned id to owned apps.

For the whole list:

1. **Resolve zones.** For each unique hostname, find its zone by longest-suffix match
   against `GET /zones`. Cache zone-id per zone name. Unmatched hostname → error naming
   the hostname (zone not in this account / token can't see it).
2. **Tunnel ingress (single PUT).** `GET …/configurations`, rebuild the `ingress` array
   from `routes.yaml` (preserving any manually-added rules **unless** `--prune`), always
   end with the catch-all `{ service: "http_status:404" }`, then `PUT …/configurations`.
   One PUT for all routes (ingress is whole-array).
3. **DNS (per hostname).** Upsert a **proxied CNAME** `hostname → <tunnel-id>.cfargotunnel.com`:
   `GET /zones/{z}/dns_records?type=CNAME&name={hostname}` → `PUT` if present (and content
   differs), else `POST`. With `--prune`, delete CNAMEs that point at this tunnel but whose
   hostname is no longer listed.
4. **Access app (per hostname where `access: true`).** Upsert a self-hosted app:
   `GET …/access/apps` match by `domain == hostname` → `PUT`/`POST`
   `{ name: "khost: <hostname>", domain, type: "self_hosted", session_duration: "24h" }`.
   For `ssh://` routes, additionally enable **browser-rendered SSH** on the app so the
   terminal opens in-browser (no client `cloudflared` needed). The exact app field for
   browser SSH rendering is to be confirmed at implementation time against the live API
   (Zero Trust "Browser rendering: SSH").
5. **Access policy attachment.** Look up the configured externally-managed
   reusable policy by exact name (`GET /access/policies`) and attach its id to
   each Access app via `policies: [id]`. khost must never create, update, or
   delete reusable Access policies during normal reconcile.

Idempotency: every step is GET-then-(PUT|POST) keyed by a stable identifier
(hostname / app domain / policy name), so re-running converges and never duplicates.

Ordering note: DNS and Access can be created before/independently of the ingress PUT;
the only hard dependency is that the **tunnel must exist** before its configuration is set.

## 6. Cloudflare token requirements (action for the user)

The current token is **tunnel-only** — it cannot read zones or touch Access. A new token
is required at https://dash.cloudflare.com/profile/api-tokens with:

| permission                                       | scope             | used for                      |
| ------------------------------------------------ | ----------------- | ----------------------------- |
| Cloudflare Tunnel · Edit                         | Account           | ingress config (already have) |
| Zone · Read                                      | Zone (the domain) | resolve hostname → zone       |
| DNS · Edit                                       | Zone (the domain) | the proxied CNAME             |
| Access: Apps and Policies · Edit                 | Account           | app + policy                  |
| Access: Organizations, Identity Providers · Read | Account           | verify an IdP exists          |

Then set `CLOUDFLARE_API_TOKEN` in sops and `hms`. **All code can be written and unit-tested
before this exists; it only blocks the live `route sync`.**

## 7. Cloudflare API reference (endpoints used)

- Zones: `GET /zones?name=` / `GET /zones`
- DNS: `GET|POST /zones/{z}/dns_records`, `PUT|DELETE /zones/{z}/dns_records/{id}`
- Tunnel config: `GET|PUT /accounts/{a}/cfd_tunnel/{t}/configurations`
- Access apps: `GET|POST /accounts/{a}/access/apps`, `PUT|DELETE …/{appId}`
- Access policies: `GET /accounts/{a}/access/policies` (lookup only)
- IdPs: `GET /accounts/{a}/access/identity_providers`

All wrapped via the existing typed `cfFetch` (zod-validated envelopes) in `cloudflare.ts`.

## 8. Code layout

| file                           | change                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy/routes.yaml`            | **new** — committed routes list (with examples)                                                                                                                  |
| `src/deps.ts`                  | expose configured Access policy name                                                                                                                             |
| `src/cloudflare.ts`            | add `findZoneForHostname`, `getTunnelConfig`, `putTunnelConfig`, `upsertDns`, `pruneDns`, `upsertAccessApp`, `findReusablePolicyByName`, `listIdentityProviders` |
| `src/routes.ts`                | **new** — load+validate routes.yaml (zod), the reconcile engine, `routeLs`/`routeSync`                                                                           |
| `src/index.ts`                 | wire `khost route ls` / `khost route sync` (+ flags), call `routeSync` from `up`                                                                                 |
| `src/__tests__/routes.test.ts` | **new** — zone-suffix matching, ingress array build, prune diff, dry-run plan                                                                                    |

No new runtime deps (`yaml` + `zod` already present; `cloudflared` already on PATH).

## 9. Safety & edge cases

- **Never clobber unknown ingress** unless `--prune` — default merge preserves manual rules.
- **Catch-all** `http_status:404` always last in ingress (cloudflared requirement).
- **SSH route (v1 = web SSH):** ingress `ssh://localhost:22`; the Access app has
  **browser-rendered SSH** enabled, so the user opens `ssh.example.com` in a browser, logs
  in via Access, and gets a terminal — **no client `cloudflared` required**. The configured
  Access policy still applies. (`cloudflared access ssh` from a native client also works
  against the same route, but is not required.)
- **`--dry-run`** prints a per-resource plan (create/update/delete/no-op) and exits 0.
- **Partial failure:** report which routes succeeded; non-zero exit if any failed.
- **Empty routes.yaml** → `route sync` is a clean no-op (so `khost up` is unaffected until
  routes are added).

## 10. Resolved decisions

1. **Session duration / app naming** — ✅ `"24h"` + `"khost: <hostname>"`.
2. **Prune** — ✅ `khost up` syncs **additively**; deletion only via explicit
   `route sync --prune`.
3. **SSH UX** — ✅ **browser-rendered (web) SSH** in v1: open the hostname in a browser,
   Access login, in-browser terminal. No client `cloudflared` needed. Native
   `cloudflared access ssh` remains possible against the same route.
4. **IdP missing** — ✅ **warn + skip** Access (routes+DNS still apply). An IdP is expected
   to already exist; it can't be pre-verified now because the current tunnel-only token
   can't read Access — the runtime preflight will check once the expanded token is in.

## 11. Resolved at implementation

- **Browser SSH** — ✅ the Access app `type` is **`"ssh"`** (confirmed against an existing
  account app, `ssh.kirinnee.atomi.cloud`). khost sets `type: "ssh"` for `ssh://` routes
  (in-browser terminal) and `type: "self_hosted"` for HTTP routes; both pass
  `self_hosted_domains: [hostname]`.
- **Policy shape** — ✅ externally-managed reusable account policy referenced from
  each app's `policies: [id]` array. Normal khost reconcile is read-only for
  reusable Access policies.
