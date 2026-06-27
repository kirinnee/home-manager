// Minimal typed Cloudflare API client for Level-2 tunnel self-provisioning.
import { z } from 'zod';
import { cfAccountId, cfApiBase, cfApiToken } from './deps';

export function cfConfigured(): boolean {
  return cfApiToken.length > 0 && cfAccountId.length > 0;
}

export interface CfVerifyResult {
  ok: boolean;
  detail: string;
}

/** Preflight: confirm the API token is live (GET /user/tokens/verify).
 *  This endpoint is NOT account-scoped, so it bypasses cfFetch's base path. */
export async function verifyToken(): Promise<CfVerifyResult> {
  if (!cfApiToken) return { ok: false, detail: 'CLOUDFLARE_API_TOKEN is empty' };
  let res: Response;
  try {
    res = await fetch(`${cfApiBase}/user/tokens/verify`, {
      headers: { Authorization: `Bearer ${cfApiToken}` },
    });
  } catch (e) {
    return { ok: false, detail: `network error: ${(e as Error).message}` };
  }
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { status?: string };
    errors?: Array<{ code?: number; message: string }>;
  };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, detail: `token rejected (HTTP ${res.status}) — invalid or insufficient permissions` };
  }
  if (!json.success) {
    const msg = json.errors?.map(e => e.message).join('; ') ?? `HTTP ${res.status}`;
    return { ok: false, detail: msg };
  }
  const status = json.result?.status ?? 'unknown';
  // "active" = good; "disabled"/"expired" = unusable.
  return status === 'active' ? { ok: true, detail: 'active' } : { ok: false, detail: `token status: ${status}` };
}

/** Confirm the account id + token scope are usable for tunnel work.
 *  Probes the cfd_tunnel list endpoint (needs Cloudflare Tunnel:Read/Edit) rather
 *  than GET /accounts/{id} — that account-root endpoint requires an Account
 *  Settings:Read permission a tunnel-scoped token legitimately won't have, so it
 *  would 403 on a perfectly valid token. This checks the capability we actually use. */
export async function verifyAccount(): Promise<CfVerifyResult> {
  if (!cfAccountId) return { ok: false, detail: 'CLOUDFLARE_ACCOUNT_ID is empty' };
  let res: Response;
  try {
    res = await fetch(`${cfApiBase}/accounts/${cfAccountId}/cfd_tunnel?per_page=1`, {
      headers: { Authorization: `Bearer ${cfApiToken}` },
    });
  } catch (e) {
    return { ok: false, detail: `network error: ${(e as Error).message}` };
  }
  if (res.ok) return { ok: true, detail: `${cfAccountId} (tunnel scope ok)` };
  if (res.status === 404)
    return { ok: false, detail: `account ${cfAccountId} not found / not accessible by this token` };
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      detail: `tunnel access denied (HTTP ${res.status}) — token needs 'Cloudflare Tunnel:Edit' on account ${cfAccountId}`,
    };
  }
  return { ok: false, detail: `unexpected HTTP ${res.status}` };
}

const envelope = <T extends z.ZodTypeAny>(result: T) =>
  z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number().optional(), message: z.string() })).optional(),
    result,
  });

/** Root-scoped API call ({cfApiBase}{path}). Used for /zones/... which is not
 *  account-scoped. */
async function cfFetchRoot<T extends z.ZodTypeAny>(
  method: string,
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  const res = await fetch(`${cfApiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfApiToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  const parsed = envelope(schema).safeParse(json);
  if (!parsed.success) {
    throw new Error(`Cloudflare API ${method} ${path} -> unexpected response: ${JSON.stringify(json)}`);
  }
  if (!parsed.data.success) {
    const msg = parsed.data.errors?.map(e => e.message).join('; ') ?? 'unknown error';
    throw new Error(`Cloudflare API ${method} ${path} failed: ${msg}`);
  }
  return parsed.data.result;
}

/** Account-scoped API call ({cfApiBase}/accounts/{id}{path}). */
async function cfFetch<T extends z.ZodTypeAny>(
  method: string,
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  return cfFetchRoot(method, `/accounts/${cfAccountId}${path}`, schema, body);
}

const tunnelSchema = z.object({ id: z.string(), name: z.string() });
const tunnelListSchema = z.array(tunnelSchema).nullable();

/** Find a cloudflared tunnel by exact name (not deleted). */
export async function findTunnel(name: string): Promise<{ id: string } | null> {
  const list = await cfFetch('GET', `/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`, tunnelListSchema);
  const hit = (list ?? [])[0];
  return hit ? { id: hit.id } : null;
}

/** Create a remotely-managed tunnel (config_src: cloudflare). */
export async function createTunnel(name: string): Promise<{ id: string }> {
  const r = await cfFetch('POST', '/cfd_tunnel', tunnelSchema, {
    name,
    config_src: 'cloudflare',
  });
  return { id: r.id };
}

/** Fetch the run token used with `cloudflared tunnel run --token`. */
export async function tunnelToken(id: string): Promise<string> {
  return cfFetch('GET', `/cfd_tunnel/${id}/token`, z.string());
}

// --- zones ----------------------------------------------------------------

const zoneSchema = z.object({ id: z.string(), name: z.string() });

/** Pure longest-suffix match of a hostname against candidate zones. Exported
 *  for testing. */
export function selectZone<T extends { name: string }>(hostname: string, zones: T[]): T | undefined {
  return zones
    .filter(z => hostname === z.name || hostname.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/** Find the Cloudflare zone owning a hostname (longest-suffix match). */
export async function findZoneForHostname(hostname: string): Promise<{ id: string; name: string }> {
  const zones = await cfFetchRoot('GET', '/zones?per_page=50', z.array(zoneSchema).nullable());
  const hit = selectZone(hostname, zones ?? []);
  if (!hit) throw new Error(`no Cloudflare zone found for ${hostname} (account ${cfAccountId} / token scope)`);
  return hit;
}

// --- tunnel ingress (the public-hostname routing) -------------------------

export interface IngressRule {
  hostname?: string;
  service: string;
  path?: string;
}

const ingressRuleSchema = z.object({
  hostname: z.string().optional(),
  service: z.string(),
  path: z.string().optional(),
});
const tunnelConfigSchema = z
  .object({ config: z.object({ ingress: z.array(ingressRuleSchema).nullable().optional() }).nullable() })
  .nullable();

export async function getTunnelIngress(tunnelId: string): Promise<IngressRule[]> {
  const r = await cfFetch('GET', `/cfd_tunnel/${tunnelId}/configurations`, tunnelConfigSchema);
  return (r?.config?.ingress ?? []) as IngressRule[];
}

export async function putTunnelIngress(tunnelId: string, ingress: IngressRule[]): Promise<void> {
  await cfFetch('PUT', `/cfd_tunnel/${tunnelId}/configurations`, z.unknown(), { config: { ingress } });
}

// --- tunnel health (for metrics) ------------------------------------------

const tunnelDetailSchema = z.object({ status: z.string().optional() }).nullable();

/** Cloudflare's view of a tunnel's health: "healthy" | "degraded" | "down" |
 *  "inactive" (or "unknown" if absent). */
export async function getTunnelStatus(id: string): Promise<string> {
  const r = await cfFetch('GET', `/cfd_tunnel/${id}`, tunnelDetailSchema);
  return r?.status ?? 'unknown';
}

/** Count of active connector connections for a tunnel. */
export async function getTunnelConnections(id: string): Promise<number> {
  const r = await cfFetch('GET', `/cfd_tunnel/${id}/connections`, z.array(z.unknown()).nullable());
  return (r ?? []).length;
}

// --- DNS ------------------------------------------------------------------

const dnsRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
  comment: z.string().nullable().optional(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

async function findCname(zoneId: string, name: string): Promise<DnsRecord | null> {
  const list = await cfFetchRoot(
    'GET',
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
    z.array(dnsRecordSchema).nullable(),
  );
  return (list ?? [])[0] ?? null;
}

export async function listCnames(zoneId: string): Promise<DnsRecord[]> {
  const list = await cfFetchRoot(
    'GET',
    `/zones/${zoneId}/dns_records?type=CNAME&per_page=100`,
    z.array(dnsRecordSchema).nullable(),
  );
  return list ?? [];
}

/** Upsert a proxied CNAME → content, stamping the ownership comment. Adopts an
 *  existing record only if it already carries our comment; refuses to clobber
 *  an un-owned record. */
export async function upsertCname(
  zoneId: string,
  name: string,
  content: string,
  comment: string,
): Promise<{ action: 'created' | 'updated' | 'unchanged' }> {
  const existing = await findCname(zoneId, name);
  const body = { type: 'CNAME', name, content, proxied: true, comment };
  if (!existing) {
    await cfFetchRoot('POST', `/zones/${zoneId}/dns_records`, dnsRecordSchema, body);
    return { action: 'created' };
  }
  if (existing.comment !== comment) {
    throw new Error(`refusing to overwrite un-owned DNS record ${name} (no '${comment}' marker) — adopt manually`);
  }
  if (existing.content === content && existing.proxied === true) return { action: 'unchanged' };
  await cfFetchRoot('PUT', `/zones/${zoneId}/dns_records/${existing.id}`, dnsRecordSchema, body);
  return { action: 'updated' };
}

export async function deleteDns(zoneId: string, id: string): Promise<void> {
  await cfFetchRoot('DELETE', `/zones/${zoneId}/dns_records/${id}`, z.object({ id: z.string() }));
}

// --- Access (Zero Trust) --------------------------------------------------

const namedSchema = z.object({ name: z.string() });

/** Ensure an account-level Access tag exists (apps reference it by name). */
export async function ensureAccessTag(name: string): Promise<void> {
  const tags = await cfFetch('GET', '/access/tags', z.array(namedSchema).nullable());
  if ((tags ?? []).some(t => t.name === name)) return;
  await cfFetch('POST', '/access/tags', namedSchema, { name });
}

const idpSchema = z.object({ id: z.string(), name: z.string().optional(), type: z.string() });
export async function listIdps(): Promise<Array<{ type: string; name?: string }>> {
  const list = await cfFetch('GET', '/access/identity_providers', z.array(idpSchema).nullable());
  return list ?? [];
}

const policySchema = z.object({ id: z.string(), name: z.string() });

/** Maintain one reusable "allow only these emails" policy; returns its id. When
 *  posturePostureUid is set, also require that device-posture (e.g. WARP enrolled
 *  in the org). */
export async function ensureReusablePolicy(
  name: string,
  emails: string[],
  posturePostureUid?: string,
): Promise<string> {
  const list = await cfFetch('GET', '/access/policies?per_page=100', z.array(policySchema).nullable());
  const body = {
    name,
    decision: 'allow',
    include: emails.map(email => ({ email: { email } })),
    require: posturePostureUid ? [{ device_posture: { integration_uid: posturePostureUid } }] : [],
  };
  const existing = (list ?? []).find(p => p.name === name);
  if (existing) {
    await cfFetch('PUT', `/access/policies/${existing.id}`, policySchema, body);
    return existing.id;
  }
  const created = await cfFetch('POST', '/access/policies', policySchema, body);
  return created.id;
}

const accessAppSchema = z.object({ id: z.string(), name: z.string().optional(), domain: z.string().optional() });
export type AccessApp = z.infer<typeof accessAppSchema>;

export async function listAccessApps(): Promise<AccessApp[]> {
  const list = await cfFetch('GET', '/access/apps?per_page=100', z.array(accessAppSchema).nullable());
  return list ?? [];
}

/** Upsert an Access app on a hostname, tagged + bound to a policy. `type` is
 *  "ssh" for browser-rendered SSH (in-browser terminal) or "self_hosted" for
 *  HTTP apps. */
export async function upsertAccessApp(
  domain: string,
  name: string,
  policyId: string,
  tag: string,
  type: 'self_hosted' | 'ssh' = 'self_hosted',
): Promise<{ created: boolean; id: string }> {
  const body = {
    name,
    domain,
    type,
    self_hosted_domains: [domain],
    session_duration: '24h',
    tags: [tag],
    policies: [policyId],
  };
  const existing = (await listAccessApps()).find(a => a.domain === domain);
  if (existing) {
    await cfFetch('PUT', `/access/apps/${existing.id}`, accessAppSchema, body);
    return { created: false, id: existing.id };
  }
  const created = await cfFetch('POST', '/access/apps', accessAppSchema, body);
  return { created: true, id: created.id };
}

export async function deleteAccessApp(id: string): Promise<void> {
  await cfFetch('DELETE', `/access/apps/${id}`, z.object({ id: z.string() }));
}
