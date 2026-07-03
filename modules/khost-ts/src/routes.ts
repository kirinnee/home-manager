// Route-manager: the `routes` list from ~/.khost/config.yaml reconciled onto the
// khost Cloudflare Tunnel — tunnel ingress + DNS CNAME + Access apps. No state
// file: the live API is the truth; ownership is marked per resource (DNS comment,
// Access tag) so prune only ever touches khost's own resources.
import pc from 'picocolors';
import { config, type Route } from './config';
import { accessPolicyName, machineId, ownerComment, ownerTag, tunnelName } from './deps';
import { die, log, need, ok, warn } from './exec';
import {
  cfConfigured,
  deleteAccessApp,
  deleteDns,
  ensureAccessTag,
  findReusablePolicyByName,
  findTunnel,
  findZoneForHostname,
  getTunnelIngress,
  type IngressRule,
  listAccessApps,
  listCnames,
  listIdps,
  putTunnelIngress,
  upsertAccessApp,
  upsertCname,
  verifyAccount,
  verifyToken,
} from './cloudflare';

export type { Route };

/** Expand the `{machine}` token in route hostnames so config.yaml stays
 *  machine-agnostic and a clone on a new box namespaces its hostnames under
 *  that box's id. Pure (machine passed in) so it's unit-testable. */
export function expandMachine(routes: Route[], machine: string): Route[] {
  return routes.map(r => ({ ...r, hostname: r.hostname.replaceAll('{machine}', machine) }));
}

function loadRoutes(): Route[] {
  return expandMachine(config.routes, machineId);
}

function accessEnabled(access: Route['access']): boolean {
  return access !== false;
}

function policyNameForRoute(route: Route): string {
  return typeof route.access === 'string' ? route.access : accessPolicyName;
}

/** Build the cloudflared ingress array: managed routes first, then any manual
 *  rules we don't own (preserved unless pruning), then the required catch-all. */
export function buildIngress(routes: Route[], existing: IngressRule[], prune: boolean): IngressRule[] {
  const desired: IngressRule[] = routes.map(r => ({ hostname: r.hostname, service: r.service }));
  const desiredHosts = new Set(routes.map(r => r.hostname));
  const preserved = prune ? [] : existing.filter(r => r.hostname && !desiredHosts.has(r.hostname));
  return [...desired, ...preserved, { service: 'http_status:404' }];
}

export interface SyncOpts {
  prune?: boolean;
  dryRun?: boolean;
}

/** Reconcile live Cloudflare state to config.yaml routes. Self-guards: no-op when no
 *  routes or no Cloudflare creds, so it's safe to call from `khost up`. */
export async function routeSync(opts: SyncOpts = {}): Promise<void> {
  const routes = await loadRoutes();
  if (routes.length === 0) {
    log('no routes defined (config.yaml) — nothing to sync');
    return;
  }
  if (!cfConfigured()) {
    warn('Cloudflare not configured — route sync skipped.');
    return;
  }
  await need('cloudflared');
  const dry = opts.dryRun ?? false;
  const prune = opts.prune ?? false;

  // Preflight creds.
  const tok = await verifyToken();
  if (!tok.ok) die(`Cloudflare token check failed: ${tok.detail}`);
  const acct = await verifyAccount();
  if (!acct.ok) die(`Cloudflare account check failed: ${acct.detail}`);

  // Tunnel must already exist.
  const tunnel = await findTunnel(tunnelName);
  if (!tunnel) die(`tunnel ${tunnelName} not found — run 'khost tunnel up' first`);
  const tunnelTarget = `${tunnel.id}.cfargotunnel.com`;

  // Access needs an IdP; warn+skip if none (routes + DNS still apply).
  let accessOk = routes.some(r => accessEnabled(r.access));
  if (accessOk && (await listIdps()).length === 0) {
    warn('no Access identity provider configured — skipping Access apps (routes + DNS still applied)');
    accessOk = false;
  }

  const plan: string[] = [];

  // 1. Tunnel ingress (single whole-array PUT).
  const ingress = buildIngress(routes, await getTunnelIngress(tunnel.id), prune);
  plan.push(
    `ingress → ${ingress
      .filter(i => i.hostname)
      .map(i => `${i.hostname}=${i.service}`)
      .join(', ')}`,
  );
  if (!dry) {
    await putTunnelIngress(tunnel.id, ingress);
    ok('tunnel ingress updated');
  }

  // Resolve zones once per zone.
  const zoneCache = new Map<string, { id: string; name: string }>();
  const zoneFor = async (hostname: string): Promise<{ id: string; name: string }> => {
    for (const [name, zone] of zoneCache) if (hostname === name || hostname.endsWith(`.${name}`)) return zone;
    const zone = await findZoneForHostname(hostname);
    zoneCache.set(zone.name, zone);
    return zone;
  };

  // Shared externally-managed policy lookup + ownership tag (once, before the
  // per-route loop). Per-route string overrides can name a different reusable
  // policy; all lookups remain read-only.
  const policyIds = new Map<string, string>();
  if (accessOk) {
    if (!dry) await ensureAccessTag(ownerTag);
    for (const name of new Set(routes.filter(r => accessEnabled(r.access)).map(policyNameForRoute))) {
      policyIds.set(name, await findReusablePolicyByName(name));
    }
  }
  if (accessOk) {
    const names = [...new Set(routes.filter(r => accessEnabled(r.access)).map(policyNameForRoute))];
    plan.push(`policy → ${names.join(', ')}`);
  }

  // 2/3. Per-route DNS + Access.
  for (const r of routes) {
    const zone = await zoneFor(r.hostname);
    plan.push(`dns → ${r.hostname} CNAME ${tunnelTarget} (zone ${zone.name})`);
    if (!dry) {
      const { action } = await upsertCname(zone.id, r.hostname, tunnelTarget, ownerComment);
      ok(`dns ${action}: ${r.hostname}`);
    }
    if (accessEnabled(r.access) && accessOk) {
      const policyName = policyNameForRoute(r);
      const appType = r.service.startsWith('ssh://') ? 'ssh' : 'self_hosted';
      plan.push(`access → ${appType === 'ssh' ? 'browser-SSH' : 'app'} ${r.hostname} (${policyName})`);
      const policyId = policyIds.get(policyName);
      if (!dry && policyId) {
        const { created } = await upsertAccessApp(r.hostname, `khost: ${r.hostname}`, policyId, ownerTag, appType);
        ok(`access ${created ? 'created' : 'ok'}: ${r.hostname} (${appType})`);
      }
    }
  }

  // 4. Prune (only resources carrying khost's markers).
  if (prune) {
    const desiredHosts = new Set(routes.map(r => r.hostname));
    for (const [, zone] of zoneCache) {
      for (const rec of await listCnames(zone.id)) {
        if (rec.comment === ownerComment && rec.content === tunnelTarget && !desiredHosts.has(rec.name)) {
          plan.push(`PRUNE dns → ${rec.name}`);
          if (!dry) {
            await deleteDns(zone.id, rec.id);
            ok(`pruned dns: ${rec.name}`);
          }
        }
      }
    }
    for (const app of await listAccessApps()) {
      if (app.name?.startsWith('khost: ') && app.domain && !desiredHosts.has(app.domain)) {
        plan.push(`PRUNE access → ${app.domain}`);
        if (!dry) {
          await deleteAccessApp(app.id);
          ok(`pruned access: ${app.domain}`);
        }
      }
    }
  }

  if (dry) {
    console.log(pc.bold('plan (dry-run, no changes made):'));
    for (const p of plan) console.log(`  ${p}`);
  } else {
    ok('route sync complete');
  }
}

/** Show desired routes (config.yaml) vs the live tunnel ingress. */
export async function routeLs(): Promise<void> {
  const routes = await loadRoutes();
  console.log(pc.bold('config routes (desired):'));
  if (routes.length === 0) console.log('  (none)');
  for (const r of routes) {
    const access = accessEnabled(r.access) ? `  (access: ${policyNameForRoute(r)})` : '  (no access)';
    console.log(`  ${r.hostname} → ${r.service}${access}`);
  }

  if (!cfConfigured()) {
    warn('Cloudflare not configured — cannot show live state');
    return;
  }
  const tunnel = await findTunnel(tunnelName);
  if (!tunnel) {
    warn(`tunnel ${tunnelName} not created yet — run 'khost tunnel up'`);
    return;
  }
  console.log(pc.bold('\nlive tunnel ingress:'));
  for (const i of await getTunnelIngress(tunnel.id)) {
    console.log(`  ${i.hostname ?? '(catch-all)'} → ${i.service}`);
  }
}
