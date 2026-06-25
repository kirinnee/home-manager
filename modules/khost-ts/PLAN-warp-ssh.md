# PLAN — khost SSH over WARP Mesh (single-plane redesign)

> Status: **design / plan only.** Most of the full-migration runbook below is NOT
> being implemented (see FINAL DECISION).
>
> **FINAL DECISION (2026-06-25): keep status quo + move only SSH to the mesh.**
> Dashboards stay on the cloudflared tunnel (free HTTPS + SSO; `requireWarp`
> posture removed). SSH additionally listens on the mesh endpoint `172.16.0.2`
> (`src/ssh.ts`), tunnel SSH route kept. NO Caddy, NO tunnel-down, NO full
> migration — because the custom mesh IP isn't auto-detectable (API hides it) +
> churns on re-enroll, and all-mesh+Caddy just rebuilds the free HTTPS the tunnel
> already gives. The runbook below is retained as reference only.

## Locked decisions (latest)

- **Single mesh = the atomi org.** No multi-org / switching. Every client and
  destination enrolls in atomi WARP; Access policy guards who-reaches-what.
- **MacBook joins the atomi mesh AND keeps Tailscale** — both VPNs run at once.
  Deconflict by setting a **custom WARP mesh device-IP range OUTSIDE
  `100.64.0.0/10`**. **LOCKED: `10.213.37.0/24`** — VERIFIED clear vs atomi
  (primordial) ranges, the work Tailscale tailnet's advertised routes
  (`10.0–10.4/16`, `10.102/16`, `10.128/20`, many `172.x/16`, `192.168.248/21`),
  home LAN, and Docker. Plus WARP split-tunnel excludes Tailscale's range + DNS
  fallback for `*.ts.net`. Coexistence on the Mac is still the fragile part — test it.
- **Access policy: PER-TARGET, not shared** (user decision). Each host gets its
  own policy so access/unix-users can differ per box; reuse the existing
  `auth0_saml_idp_id` + `gateway_posture_rule_id`.
- **Phone reaches MacBook + atomi servers together** via WARP atomi (the phone's
  single VPN). Mobile is back IN scope (earlier "ignore mobile" reversed).
  **Constraint: the phone CANNOT run Tailscale** — so its only path is WARP atomi
  (this is exactly why the MacBook must join the atomi mesh). Whole phone path
  depends on the phone being able to run WARP atomi — confirm that's allowed.
- **Mobile auth caveat:** Access-for-Infrastructure short-lived certs on iOS are
  uncertain (docs mixed; cert minting is WARP-side). **Plan a key-based fallback
  for the phone** — i.e. sshd trusts the CA _and_ keeps an `authorized_keys`
  entry for the phone's SSH app — OR verify certs work on the phone first. WARP
  mesh _connectivity_ on mobile is fine; only the cert step is in question.
- **sshd binds to the mesh IP** (not loopback). On macOS, run khost's own sshd
  bound to the WARP mesh IP (Remote Login binds all interfaces — avoid that).

## Goal

SSH **from** other laptops, iPad, Android phone (browser dropped as a hard
requirement) **to** macbooks and linux boxes, with a **stable URL per
destination**, no passwords and no SSH-key juggling.

## Decision summary

- **One plane: WARP everywhere.** Every client and every destination runs the
  Cloudflare One (WARP) client enrolled in the AtomiCloud Zero Trust org.
- **Auth: Access for Infrastructure** — short-lived SSH certificates from a
  Cloudflare-managed SSH CA that each destination's `sshd` trusts. No passwords,
  no `authorized_keys`, no key distribution. (Fallback option: plain WARP mesh +
  your own keys — simpler, but you manage keys and lose SSO/audit.)
- **Browser dropped** → no public SSH hostnames, no tunnel ingress for SSH, no
  browser-render Access app, no loopback-only sshd trick.
- **Cost:** every client must run WARP. No zero-install / borrowed-machine path.

## Does Access policy still apply? — YES

Access policies are _central_ to this design, not lost:

- Each infrastructure target is an **Access (non-HTTP) application** gated by an
  Access **policy** — the same model as today's `only-ernest`. The policy decides
  **who** may connect, under **what device posture / WARP enrollment**, and
  **which UNIX user(s)** the issued cert is valid for (`valid_principals`).
- All WARP-to-WARP / Mesh traffic flows through Cloudflare Gateway, so Gateway
  network policies + device posture apply to every SSH connection.
- So the existing intent (only-ernest, require-WARP posture) carries straight
  over — re-expressed as an Access policy on the infra target(s).

## Architecture

```
client (WARP)  ──►  Cloudflare (mesh + Access policy)  ──►  destination (WARP)
  laptop / iPad / Android                                     Mac / Linux box
            ssh user@mbp.ssh.internal  →  cert minted  →  logged in
```

- Each enrolled device gets a stable **Mesh IP** (`100.96.0.0/12`).
- A **stable internal hostname** per destination resolves to its Mesh IP for
  WARP devices (e.g. `mbp.ssh.internal`, `box1.ssh.internal`).
- Connect with a plain native `ssh` — WARP routes it, Access mints a 3-minute
  cert, sshd (trusting the CA) lets you in.

## What stays / what goes

| Component                                                 | Fate                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cloudflared tunnel — SSH ingress                          | **removed**                                                                                                                                                                                |
| public SSH hostname (`ssh.ernest.atomi.cloud`)            | **removed**                                                                                                                                                                                |
| browser-render SSH Access app                             | **removed**                                                                                                                                                                                |
| loopback-only sshd on :2222                               | **replaced** (sshd listens on Mesh IP)                                                                                                                                                     |
| password auth / `authorized_keys`                         | **removed** (certs; phone-key fallback only)                                                                                                                                               |
| cloudflared tunnel — **everything incl. HTTP dashboards** | **removed** (DECIDED: dashboards go WARP-only too)                                                                                                                                         |
| **HTTP dashboards** (kauto/kloop/blog)                    | **mesh-only** — reach via `http://<host>.ssh.internal:<port>`; bind the service to the mesh IP (not localhost); gate by mesh membership + optional Gateway HTTP policy (no SSO login page) |
| **khost-ts**                                              | **fully retired** — no tunnel, no sshd; nothing left for it to do                                                                                                                          |

## Components & setup

### Zero Trust org (dashboard, one-time)

1. Enable **"Assign a unique IP address to each device"** (so each box gets its
   own stable Mesh IP).
2. Enable **"Allow all Cloudflare One traffic to reach enrolled devices"**
   (WARP-to-WARP).
3. **Generate the SSH CA** (Access controls → Service credentials → SSH) — note
   the CA public key.
4. **Device profile / split tunnel:** ensure `100.96.0.0/12` routes _through_
   WARP. In default Exclude mode it's hidden inside the excluded `100.64.0.0/10`
   — remove that and re-add only the non-Cloudflare sub-ranges, or switch the
   relevant profile to Include mode with `100.96.0.0/12` listed.
5. **Internal DNS:** a Gateway **resolver policy** (or private-hostname route)
   mapping `*.ssh.internal` → the destinations' Mesh IPs. Use FQDNs (search
   suffixes aren't inherited on the WARP interface).
6. **Access application + policy** per target (or one shared policy): identity =
   only-ernest, posture = WARP enrolled; set allowed UNIX users.

### Destinations

**Mac (e.g. this machine):**

- WARP app enrolled (already installed + connected).
- `sshd`: trust the CA — `TrustedUserCAKeys /etc/ssh/cloudflare_ca.pub`,
  `PubkeyAuthentication yes`; put these **above** any `Include`. Drop
  `PasswordAuthentication`. Listen on the Mesh IP (or all interfaces — Mesh IP
  is fine since LAN can't route the CGNAT range).
- Register as an infrastructure **target** (label + Mesh IP + vnet).

**Linux box:**

- Headless WARP via **service token + `/var/lib/cloudflare-warp/mdm.xml`**
  (`auth_client_id`, `auth_client_secret`, `organization`, `auto_connect=1`,
  `service_mode=warp`). ⚠️ Fix split-tunnel _before_ connecting so you don't drop
  the SSH session you're enrolling over.
- Same CA-trust sshd config + target registration.

### Clients (laptop / iPad / Android)

- WARP enrolled in the org. Then `ssh user@<host>.ssh.internal` with any native
  SSH app (Termius, Blink [iOS], JuiceSSH/ConnectBot, OpenSSH). No ProxyCommand,
  no keys, no password.

## Task list (by repo)

The Cloudflare org side lives in **`primordial`** (`~/Workspace/atomi/primordial`)
— it already manages the atomi Zero Trust org in OpenTofu
(`infra/cloudflare/tofu/`): `posture.tf` (`cloudflare_zero_trust_device_posture_rule`
"gateway" → output `gateway_posture_rule_id`), `identity.tf`
(`cloudflare_zero_trust_access_identity_provider` "auth0_saml" → output
`auth0_saml_idp_id`), plus `variables.tf` (`cloudflare_account_id`,
`cloudflare_api_token`), `providers.tf`, `backend.tf`. The new SSH resources are
added as sibling `.tf` files there and **reuse those two outputs** (IdP for
identity, posture rule for the WARP-enrolled requirement).

Legend: 🟣 **primordial** (atomi infra) · 🏠 **home-manager** (personal machines)
· ✋ **manual** (dashboard / per-device sign-in)

| #   | Task                                                                                                                                                          | Repo / where                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | **SSH CA** (Gateway CA, `POST /access/gateway_ca`) — no tofu resource                                                                                         | 🟣 `cli/cloudflare`                   |
| 2   | **Infra targets** (one per host: label + mesh IP + vnet)                                                                                                      | 🟣 `infra/cloudflare/tofu/targets.tf` |
| 3   | **Infra SSH app** (type=infrastructure, target_criteria SSH)                                                                                                  | 🟣 `…/ssh-app.tf`                     |
| 4   | **Access policy — PER-TARGET** (one per host; reuse `auth0_saml_idp_id` + `gateway_posture_rule_id`; allowed unix users via `connection_rules.ssh.usernames`) | 🟣 `…/ssh-app.tf`                     |
| 5   | **Custom mesh IP range** `10.213.37.0/24` (device IP subnet)                                                                                                  | 🟣 `…/device-profile.tf`              |
| 6   | **Split-tunnel**: exclude Tailscale (`100.64.0.0/10` + v6, control/DERP)                                                                                      | 🟣 `…/device-profile.tf`              |
| 7   | **DNS fallback** `*.ts.net` → `100.100.100.100`                                                                                                               | 🟣 `…/device-profile.tf`              |
| 8   | **Internal DNS** `*.ssh.internal` → mesh IPs (resolver policy + internal view)                                                                                | 🟣 `…/dns.tf`                         |
| 9   | **Service token** for headless Linux enroll (Service-Auth perm)                                                                                               | 🟣 `…/service-token.tf` + sops        |
| 10  | **atomi-owned Linux boxes** as destinations: WARP enroll + sshd CA trust                                                                                      | 🟣 `infra/box` ansible                |
| 11  | Toggle **"allow CF One traffic reach devices"** (warp_to_warp)                                                                                                | ✋ dashboard                          |
| 12  | Toggle **"assign unique IP per device"** (master)                                                                                                             | ✋ dashboard                          |
| 13  | **Sign WARP into atomi** on each personal Mac/laptop/phone                                                                                                    | ✋ per-device                         |
| 14  | WARP **install** on personal Macs/laptops (login = #13)                                                                                                       | 🏠 nix/homebrew                       |
| 15  | **sshd trusts the CA** + listens on **mesh IP** (personal Macs)                                                                                               | 🏠 nix                                |
| 16  | **Phone-key** `authorized_keys` entry (mobile cert fallback)                                                                                                  | 🏠 nix                                |
| 17  | ssh **Host aliases** for `*.ssh.internal` (optional)                                                                                                          | 🏠 nix                                |
| 18  | **Retire old khost SSH bits** (loopback sshd, public ssh hostname, browser app)                                                                               | 🏠 khost-ts + 🟣 remove route         |

**Cross-repo handoff:** #1's CA **public key** (an output of primordial) must reach
🏠 #15 and 🟣 #10. It's public, not secret — output it from primordial and read it
in home-manager (commit it or fetch via the CLI).

**khost-ts's fate:** **fully retired.** SSH (loopback sshd, tunnel ingress, browser
app) AND the HTTP dashboards both move to the mesh — so the cloudflared tunnel is
gone entirely and khost has nothing left to run. Dashboards instead bind to the
mesh IP and are reached at `http://<host>.ssh.internal:<port>`. The Cloudflare
reconcile khost used to do moves to primordial's tofu. (#18 becomes "decommission
khost-ts" rather than "trim it".)

## Caveats / verify first

- **iPad is now load-bearing on WARP** (no browser fallback). Docs are mixed on
  iOS routing private traffic; Mesh IPs _should_ route (they're not physical
  LAN). **Test on the real iPad before committing.**
- Short-lived cert auth window is **3 minutes** (the session itself can run
  long); WARP renews invisibly.
- Headless Linux WARP without an IdP login uses a service token →
  identity-based policies/logging are limited for that device; gate via
  device/service-token rules.

## Open questions

- ~~Keep the HTTP dashboards public (tunnel) or move them WARP-only too?~~
  **DECIDED: WARP-only.** Tunnel fully removed; dashboards reached over the mesh
  (bind to mesh IP; gate via mesh membership + optional Gateway HTTP policy).
- ~~Do the dashboards need identity gating, or is mesh membership enough?~~
  **DECIDED: Gateway HTTP policy** scoped to ernest's identity covering
  `*.ssh.internal` (atomi is a shared org, so mesh-membership alone would expose
  dashboards to all coworkers' devices). Verify exact Gateway-policy setup for
  private HTTP.
- ~~One shared Access policy for all targets, or per-target?~~ **DECIDED:
  per-target** (granular per-host access; reuse the shared IdP + posture outputs).
- ~~Single internal zone (`*.ssh.internal`) vs split-horizon on
  `*.ernest.atomi.cloud`?~~ **DECIDED: `*.ssh.internal`** (dedicated internal-only
  zone; no public/private confusion, no leak risk; `.internal` is ICANN-reserved).

**All four open questions are now decided.** Remaining items are verification
tasks, not design choices (see Caveats: test iPad certs, Mac VPN coexistence).

## Runbook (step by step)

Tags: ✋ dashboard (manual) · 🟣 primordial · 🏠 home-manager. Do phases in order;
**verify (✓) before moving on.** Keep the existing tunnel SSH alive as a safety
net until Phase 7 proves the mesh path.

### Phase 0 — Prep

- Confirm you're atomi Zero Trust admin (ernest@atomi.cloud). ✋
- Pick a low-impact window (coworkers re-enroll in Phase 9).

### Phase 1 — Org network foundation

1. Device IP subnets → **Add new IP subnet** `10.213.0.0/16`, **set as default**. ✋
   (Leave the old `100.96/12` for now — needed during migration.)
2. Enable **"Assign a unique IP per device."** ✋
3. Enable **"Allow all Cloudflare One traffic to reach enrolled devices"** (mesh). ✋

- ✓ New `10.213.0.0/16` shows Default = Yes.

### Phase 2 — SSH CA + server trust

4. Generate the **Gateway SSH CA** via `cli/cloudflare`; capture the CA **public key**. 🟣
5. On each destination: install CA pubkey + sshd drop-in — `TrustedUserCAKeys`,
   `PubkeyAuthentication yes`, **above any Include**; keep a **fallback key in
   authorized_keys** (phone + recovery); bind sshd to the **mesh IP**.
   - personal Macs 🏠 · atomi boxes 🟣 (ansible)

- ✓ `sshd -t` valid on each; old tunnel SSH still works.

### Phase 3 — Targets + per-target Access policy

6. Register each destination as an **infra target** (label + mesh IP + vnet). 🟣
7. Per target: **infra SSH app** + **per-target Access policy** (reuse
   `auth0_saml_idp_id` + `gateway_posture_rule_id`; set allowed unix users). 🟣

- ✓ `tofu plan` clean; `tofu apply`.

### Phase 4 — Internal DNS

8. Internal zone/view + records **`*.ssh.internal` → mesh IPs** + resolver policy. 🟣

- ✓ From a WARP device: `dig mbp.ssh.internal` → its `10.213.x` IP.

### Phase 5 — Tailscale coexistence (your Mac) — REWRITTEN after live testing

**Hard-won finding (2026-06-24):** the conflict is NOT the CGNAT/subnet overlap
(WARP already excludes all Tailscale ranges) — it's that **WARP is full-tunnel and
swallows Tailscale's UDP + DERP relay traffic** (proof: `tailscale netcheck` →
`UDP: false`, no DERP; even `argocd.ops.vungle.io` stopped resolving). Excluding
Tailscale's DERP IPs is whack-a-mole (30+ ranges, change often, and direct-peer
endpoints are unpredictable). **The fix is to stop WARP full-tunneling.** 9. **WARP → split-tunnel INCLUDE mode, routing ONLY `10.213.0.0/16`** (the mesh),
scoped to your device profile. Everything else (internet, Tailscale) bypasses
WARP. (Requires the `10.213` re-IP first — `100.96` can't be included, it's
inside Tailscale's `100.64/10`.) ✋ 10. **DNS — KEEP MAGICDNS (user decision).** Don't make WARP own DNS + enumerate
work domains (unsustainable — unlimited work domains). Instead, on this Mac:
**`accept-dns=true`** (Tailscale owns ALL DNS — MagicDNS + every work split-DNS
domain, no enumeration) **+ turn WARP's DNS OFF** ("don't override local DNS" /
tunnel-only DNS). WARP still connects via its hard-coded bootstrap resolvers
(`162.159.x`), so it doesn't need to own DNS; the earlier `CF_DNS_LOOKUP_FAILURE`
was WARP's DNS _proxy_ fighting Tailscale — gone once WARP DNS is off. ✋ - **Trade-off:** `*.ssh.internal` won't resolve _on this Mac_. Reach mesh hosts
here via **stable mesh IPs** or **`~/.ssh/config` Host aliases** (🏠). No DNS
needed for SSH. - **Scope:** this DNS-off + IP/alias approach is ONLY for this dual-VPN Mac.
All other devices (phone/laptops/boxes — no Tailscale) keep WARP DNS, so
`*.ssh.internal` works normally for them.

- ✓ Both VPNs ON: `tailscale netcheck` shows `UDP: true`; **litmus** `curl
https://argocd.ops.vungle.io/` → `200`; AND a `10.213.x` mesh device reachable
  (by IP/alias on this Mac); AND a non-Tailscale device resolves `*.ssh.internal`.

**Verified working baseline:** with WARP **off**, Tailscale + work is perfect
(litmus `http=200`). Coexistence hinges entirely on WARP NOT full-tunneling AND
WARP NOT owning DNS on this Mac.

### Phase 6 — Enroll devices (re-enroll for new IP)

11. Your Mac: **delete WARP registration + reconnect** → gets `10.213.x`. ✋
12. Other personal devices (laptops, phone): enroll in atomi WARP. ✋
13. Headless Linux boxes: WARP via **service token + `mdm.xml`** (fix split-tunnel
    BEFORE connecting so you don't drop the session). 🏠/🟣

- ✓ Each device shows a `10.213.x` mesh IP.

### Phase 7 — Test SSH end-to-end

14. Laptop: `ssh user@mbp.ssh.internal` → **cert** auth → in.
15. Phone (Termius/RootShell): **key** fallback → in.

- ✓ Every client type reaches every destination. NOW the mesh path is proven.

### Phase 8 — Move dashboards to mesh + decommission tunnel

16. Bind kauto/kloop/blog to the **mesh IP**; reach `http://<host>.ssh.internal:<port>`. 🏠
17. **Gateway HTTP policy** gating `*.ssh.internal` dashboards to your identity. 🟣
18. Remove the **cloudflared tunnel + public hostnames**; **decommission khost-ts**. 🏠/🟣

- ✓ Dashboards work over mesh; nothing else needs the tunnel.

### Phase 9 — Migrate coworkers, then clean up

19. Coworkers **re-enroll WARP** → pick up `10.213.x` (so you can reach them). ✋
20. Once all migrated: **delete the old `100.96/12`** default subnet. ✋

- ✓ Whole org on `10.213`; `100.x` belongs to Tailscale alone.

### Safety nets / rollback

- Tunnel SSH stays up until Phase 7 — if mesh SSH fails, you still have a way in.
- `authorized_keys` fallback key = recovery if cert trust is misconfigured.
- Re-IP is per-device on re-enroll → you can migrate one device, verify, then roll.

## Sources

- Access for Infrastructure (SSH): https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-infrastructure-access/
- Infrastructure apps: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/infrastructure-apps/
- SSH CA on server: https://developers.cloudflare.com/access/ssh/short-live-cert-server
- Cloudflare Mesh / WARP-to-WARP: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/private-net/warp-to-warp/
- Resolver policies / internal DNS: https://developers.cloudflare.com/cloudflare-one/traffic-policies/resolver-policies/
- Split tunnels: https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/
- Headless Linux WARP: https://developers.cloudflare.com/cloudflare-one/tutorials/deploy-client-headless-linux/
