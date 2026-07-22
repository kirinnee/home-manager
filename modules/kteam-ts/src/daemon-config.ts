import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { KTeamPaths } from './paths';
import { atomicJson, readJson } from './io';

export interface WardenConfig {
  /** Deterministic detection always runs; this only gates LLM escalation. */
  enabled: boolean;
  /** Cheap auto-mode wrapper the escalation warden session runs under. */
  wrapper: string;
  /** Fleet sweep cadence, minutes. */
  intervalMinutes: number;
  /** A waiting session idle this long is an unanswered question. */
  unattendedMinutes: number;
  /** Minimum gap between escalation spawns (rate limit). */
  minSpawnGapMinutes: number;
}

export interface DaemonConfig {
  host: string;
  port: number;
  publicUrl: string;
  transcriptReconcileSeconds: number;
  healthIntervalSeconds: number;
  quotaUrl: string;
  warden: WardenConfig;
}

export const defaultWardenConfig = (): WardenConfig => ({
  enabled: false,
  wrapper: 'claude-auto-glm52a',
  intervalMinutes: 5,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 60,
});

export const defaultDaemonConfig = (): DaemonConfig => ({
  host: '127.0.0.1',
  port: 7337,
  publicUrl: 'http://127.0.0.1:7337',
  // Native file notifications are primary; this short reconciliation interval
  // closes gaps from coalesced or dropped FSEvents/inotify notifications.
  transcriptReconcileSeconds: 2,
  healthIntervalSeconds: 5,
  quotaUrl: 'http://127.0.0.1:47318/usage',
  warden: defaultWardenConfig(),
});

export async function loadDaemonConfig(paths: KTeamPaths): Promise<DaemonConfig> {
  await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.daemonConfig)) await atomicJson(paths.daemonConfig, defaultDaemonConfig());
  const onDisk = await readJson<Partial<DaemonConfig>>(paths.daemonConfig);
  // Deep-merge warden so a partial `{ warden: { enabled: true } }` keeps the
  // default wrapper/interval rather than replacing the whole object.
  const merged: DaemonConfig = {
    ...defaultDaemonConfig(),
    ...onDisk,
    warden: { ...defaultWardenConfig(), ...(onDisk.warden ?? {}) },
  };
  if (process.env.KTEAM_HOST) merged.host = process.env.KTEAM_HOST;
  if (process.env.KTEAM_PORT) merged.port = Number(process.env.KTEAM_PORT);
  if (process.env.KTEAM_URL) merged.publicUrl = process.env.KTEAM_URL;
  else if (process.env.KTEAM_HOST || process.env.KTEAM_PORT) merged.publicUrl = `http://${merged.host}:${merged.port}`;
  if (process.env.KTEAM_QUOTA_URL) merged.quotaUrl = process.env.KTEAM_QUOTA_URL;
  return merged;
}

export async function ensureDaemonToken(paths: KTeamPaths): Promise<string> {
  return ensureTokenFile(paths.daemon, paths.token);
}

/** The warden's capability-scoped token. Distinct from the admin token so the
 *  api-server can enforce a narrow allowlist against it. Generated the same way,
 *  0600, and — since it lives beside the admin token under the same user — it
 *  provides an AUDIT/authorization boundary, NOT OS-level isolation: a determined
 *  prompt-injection inside the warden pane could still read the admin token file
 *  off disk. The scoped token raises the bar and makes normal warden traffic
 *  attributable and un-privileged. */
export async function ensureWardenToken(paths: KTeamPaths): Promise<string> {
  return ensureTokenFile(paths.daemon, paths.wardenToken);
}

async function ensureTokenFile(daemonDir: string, file: string): Promise<string> {
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    await writeFile(file, `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}\n`, { mode: 0o600 });
  }
  await chmod(file, 0o600);
  return (await readFile(file, 'utf8')).trim();
}
