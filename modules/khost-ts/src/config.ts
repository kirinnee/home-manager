// khost config: a single ~/.khost/config.yaml, like kloop (~/.kloop) and
// kautopilot (~/.kautopilot). All knobs, routes, Cloudflare creds and the
// machine id live here — khost reads NOTHING from the monorepo. Secrets are
// plaintext (this file lives in your home dir, never in a repo). Override the
// config dir with KHOST_CONFIG_DIR.
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const configDir = process.env.KHOST_CONFIG_DIR ?? join(homedir(), '.khost');
export const configFile = join(configDir, 'config.yaml');
// Full plaintext Grafana Alloy config (the user-editable observability config).
export const alloyConfigFile = join(configDir, 'alloy.alloy');

function sanitizeLabel(s: string): string {
  return s
    .split('.')[0] // short hostname (drop any domain / .local suffix)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // DNS-label-safe
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

/** Machine id: the configured `machine` (sanitized) else the short hostname. */
export function resolveMachineId(configMachine: string | undefined, host: string): string {
  const fromCfg = sanitizeLabel(configMachine ?? '');
  if (fromCfg) return fromCfg;
  return sanitizeLabel(host ?? '') || 'host';
}

const routeSchema = z.object({
  hostname: z.string().min(1),
  service: z.string().min(1),
  access: z.union([z.boolean(), z.string().min(1)]).default(true),
});
export type Route = z.infer<typeof routeSchema>;

const configSchema = z.object({
  // Drives the tunnel name (khost-<machine>) and the {machine} route token.
  machine: z.string().optional(),
  // NOTE: every object-level .default(...) must be the FULLY-POPULATED value,
  // not {} — zod returns object defaults verbatim (inner field defaults are NOT
  // applied to an absent section), so `.default({})` yields undefined
  // sub-fields and crashes first use on a host without that config section.
  ssh: z
    .object({
      port: z.number().default(2222),
      // mesh IP to also bind sshd to; null/"" = loopback only.
      // 'auto' = detect the live WARP virtual IP (survives re-enrollment); a literal
      // IP pins it; '' / null binds loopback only. See mesh.ts:resolveMeshListen.
      mesh_listen: z.string().nullable().default('auto'),
    })
    .default({ port: 2222, mesh_listen: 'auto' }),
  tunnel: z.object({ protocol: z.string().default('http2') }).default({ protocol: 'http2' }),
  cloudflare: z
    .object({
      account_id: z.string().default(''),
      api_token: z.string().default(''),
      api_base: z.string().default('https://api.cloudflare.com/client/v4'),
    })
    .default({ account_id: '', api_token: '', api_base: 'https://api.cloudflare.com/client/v4' }),
  access: z
    .object({
      policy: z.string().default('primordial-ernestOnly'),
    })
    .default({ policy: 'primordial-ernestOnly' }),
  routes: z.array(routeSchema).default([]),
  // khost's own Prometheus self-metrics exporter (`khost metrics serve`).
  metrics: z
    .object({
      port: z.number().default(47319),
    })
    .default({ port: 47319 }),
  alloy: z
    .object({
      // Grafana Alloy UI / HTTP port (also where Alloy's own metrics live).
      port: z.number().default(12345),
      container: z.string().default('khost-alloy'),
      image: z.string().default('grafana/alloy:latest'),
      // remote_write destination. Env wins (see deps.ts: ALLOY_REMOTE_WRITE_*),
      // so the token can stay out of this plaintext file. Injected into the
      // container; the alloy.alloy config reads them via sys.env(...).
      remote_write: z
        .object({
          url: z.string().default(''),
          username: z.string().default(''),
          password: z.string().default(''),
        })
        .default({ url: '', username: '', password: '' }),
    })
    .default({
      port: 12345,
      container: 'khost-alloy',
      image: 'grafana/alloy:latest',
      remote_write: { url: '', username: '', password: '' },
    }),
});
export type KhostConfig = z.infer<typeof configSchema>;

function load(): KhostConfig {
  if (!existsSync(configFile)) return configSchema.parse({}); // all defaults — run `khost init`
  const parsed = configSchema.safeParse(parse(readFileSync(configFile, 'utf8')) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid ${configFile}: ${issues}`);
  }
  return parsed.data;
}

export const config = load();
export const machineId = resolveMachineId(config.machine, hostname());
