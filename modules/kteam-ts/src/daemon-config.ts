import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { KTeamPaths } from './paths';
import { atomicJson, readJson } from './io';

export interface WardenConfig {
  /** Deterministic detection always runs; this only gates LLM escalation. */
  enabled: boolean;
  /** Auto-mode wrapper warden sessions run under (judgment work — use an
   *  Opus-class account, not a mass-chore model). */
  wrapper: string;
  /** Optional model override for warden session starts (e.g. run the loge
   *  wrapper but pin wardens to claude-opus-4-8[1m] instead of the wrapper's
   *  KTEAM_MODEL default). */
  model?: string;
  /** Fleet sweep cadence, minutes. */
  intervalMinutes: number;
  /** A waiting session idle this long is an unanswered question. */
  unattendedMinutes: number;
  /** Minimum gap between fleet-triage escalation spawns (rate limit). */
  minSpawnGapMinutes: number;
  /** Sus list: thinking (counters advancing) with no transcript growth this
   *  long is sus_thinking. */
  susThinkingSeconds: number;
  /** Sus list: a subprocess episode running continuously this long is
   *  sus_subprocess. */
  susSubprocessSeconds: number;
  /** Max concurrently-live assigned (per-session) warden sessions. */
  maxAssignedWardens: number;
  /** After an assigned warden finishes for a session, don't respawn one for
   *  that same session within this cooldown (minutes). */
  assignedCooldownMinutes: number;
}

export interface DaemonConfig {
  host: string;
  port: number;
  publicUrl: string;
  transcriptReconcileSeconds: number;
  healthIntervalSeconds: number;
  quotaUrl: string;
  /** Roots scanned by GET /v1/projects for git repos (New-session picker +
   *  list grouping). `~`/`$HOME` are expanded. */
  projectRoots: string[];
  warden: WardenConfig;
  /** Context-window overrides for transcript-based context accounting:
   *  substring pattern → window size, longest match wins. Built-ins: `[1m]`
   *  ⇒ 1M, default 200k (codex reports its own window in token_count). */
  contextWindows?: Record<string, number>;
}

export const defaultWardenConfig = (): WardenConfig => ({
  enabled: false,
  // Wardens JUDGE sus sessions (A6): understand the task, deep-dive the
  // process, verdict leave/nudge/resume/kill — judgment work that needs an
  // Opus-class account. The lead sets the live wrapper at ship time.
  wrapper: 'claude-auto-atomi',
  intervalMinutes: 5,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 15,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 900,
  maxAssignedWardens: 3,
  assignedCooldownMinutes: 30,
});

export const defaultDaemonConfig = (): DaemonConfig => ({
  host: '127.0.0.1',
  port: 7337,
  publicUrl: 'http://127.0.0.1:7337',
  // Native file notifications are primary; this short reconciliation interval
  // closes gaps from coalesced or dropped FSEvents/inotify notifications.
  transcriptReconcileSeconds: 2,
  // Reflex/monitor tick. The nudge/kill thresholds are wall-clock seconds
  // (180/300), so 30 s granularity is acceptable and 6x cheaper than 5 s.
  healthIntervalSeconds: 30,
  quotaUrl: 'http://127.0.0.1:47318/usage',
  projectRoots: ['~/Workspace', '~/.config'],
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
