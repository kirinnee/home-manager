import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { KTeamPaths } from './paths';
import { atomicJson, readJson } from './io';

export interface DaemonConfig {
  host: string;
  port: number;
  publicUrl: string;
  transcriptReconcileSeconds: number;
  healthIntervalSeconds: number;
  quotaUrl: string;
}

export const defaultDaemonConfig = (): DaemonConfig => ({
  host: '127.0.0.1',
  port: 7337,
  publicUrl: 'http://127.0.0.1:7337',
  // Native file notifications are primary; this short reconciliation interval
  // closes gaps from coalesced or dropped FSEvents/inotify notifications.
  transcriptReconcileSeconds: 2,
  healthIntervalSeconds: 5,
  quotaUrl: 'http://127.0.0.1:47318/usage',
});

export async function loadDaemonConfig(paths: KTeamPaths): Promise<DaemonConfig> {
  await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.daemonConfig)) await atomicJson(paths.daemonConfig, defaultDaemonConfig());
  const merged = { ...defaultDaemonConfig(), ...(await readJson<Partial<DaemonConfig>>(paths.daemonConfig)) };
  if (process.env.KTEAM_HOST) merged.host = process.env.KTEAM_HOST;
  if (process.env.KTEAM_PORT) merged.port = Number(process.env.KTEAM_PORT);
  if (process.env.KTEAM_URL) merged.publicUrl = process.env.KTEAM_URL;
  else if (process.env.KTEAM_HOST || process.env.KTEAM_PORT) merged.publicUrl = `http://${merged.host}:${merged.port}`;
  if (process.env.KTEAM_QUOTA_URL) merged.quotaUrl = process.env.KTEAM_QUOTA_URL;
  return merged;
}

export async function ensureDaemonToken(paths: KTeamPaths): Promise<string> {
  await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.token)) {
    await writeFile(paths.token, `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}\n`, { mode: 0o600 });
  }
  await chmod(paths.token, 0o600);
  return (await readFile(paths.token, 'utf8')).trim();
}
