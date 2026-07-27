import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { KTeamPaths } from './paths';
import { atomicJson, readJson } from './io';
import { defaultLearningConfig, type LearningConfig } from './learning-types';

/** One configured warden account. String shorthand `"claude-auto-glm52a"` is
 *  accepted anywhere a WardenAccount is and normalizes to `{ wrapper }`. */
export interface WardenAccount {
  /** Auto-mode wrapper name (must exist in ~/.kfleet/bin at spawn time; a
   *  missing wrapper is skipped, not fatal). */
  wrapper: string;
  /** Optional model override for THIS wrapper only. Same caveat as the legacy
   *  top-level `model`: never pin a raw claude id on a provider-backed wrapper
   *  (a `claude-*`/`[1m]` value 400s the z.ai API) — leave unset so the
   *  wrapper's own KTEAM_MODEL alias resolves. */
  model?: string;
}

export type WardenFailoverPolicy = 'fallback' | 'round_robin';

export interface WardenFailoverConfig {
  /** fallback: always prefer the earliest healthy entry in `accounts` (fails
   *  back automatically when it recovers). round_robin: rotate spawns across
   *  healthy entries to spread token burn. */
  policy: WardenFailoverPolicy;
  /** Consecutive UNCORROBORATED failures (generic launch errors) before a
   *  wrapper is demoted. Feed-corroborated evidence (atLimit/authOk from
   *  kfleet, which already triple-probes at the source since c409fd5) demotes
   *  in ONE strike — adding hysteresis there would re-add the latency that
   *  commit removed. */
  failureThreshold: number;
  /** How long a demoted wrapper stays ineligible before being retried. A
   *  positive feed signal (atLimit===false && authOk!==false) clears the
   *  demotion EARLY, so a quota reset never waits out the cooldown. */
  cooldownMinutes: number;
}

export interface WardenConfig {
  /** Deterministic detection always runs; this only gates LLM escalation. */
  enabled: boolean;
  /** LEGACY single wrapper. Kept so existing config.json files keep working;
   *  normalized into `accounts[0]` when `accounts` is absent/empty. */
  wrapper: string;
  /** @deprecated Legacy top-level model — applies to the legacy `wrapper`
   *  only. Prefer the per-account `model` on `accounts` entries. Same z.ai
   *  caveat as WardenAccount.model. */
  model?: string;
  /** Ordered warden account list. Position = preference under `fallback`;
   *  string entries are wrapper-name shorthand. Absent/empty => the legacy
   *  single `wrapper`/`model` pair, byte-for-byte today's behavior. */
  accounts?: (WardenAccount | string)[];
  /** Failover policy + hysteresis knobs. Absent => defaults
   *  (fallback / 2 strikes / 30 min cooldown). */
  failover?: WardenFailoverConfig;
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
  /** Fleet-wide cap on concurrently-live warden sessions — BOTH per-session
   *  assigned wardens AND the fleet-sweep warden count against it. `1` (the
   *  default) means only ever one warden at a time across the whole fleet;
   *  raise it to allow more. Kept the name `maxAssignedWardens` for config
   *  back-compat; it now bounds the sweep warden too. */
  maxAssignedWardens: number;
  /** After an assigned warden finishes for a session, don't respawn one for
   *  that same session within this cooldown (minutes). */
  assignedCooldownMinutes: number;
  /** When a warden CLEARS a session (LEAVE verdict), bless it for this many
   *  minutes: the sweep skips re-investigating the SAME flags until the blessing
   *  lapses, so a healthy-but-sus session is not re-judged by a fresh warden
   *  session every interval. Narrow (per-flag) and dropped on any status change. */
  blessMinutes: number;
}

export interface ScratchConfig {
  /** Reclaim agent scratch from long-terminal sessions. */
  enabled: boolean;
  /** How long a session must have been TERMINAL before its scratch expires. */
  ttlHours: number;
  /** Sessions reclaimed per sweep pass — rate limit, so GC never competes
   *  with launches or event delivery. */
  perSweep: number;
}

/** Hot-store retention (B3). Archives (never deletes) aged terminal sessions out
 *  of the in-process metadata cache so boot/sweep cost stops scaling with total
 *  history. Ships OFF by default: this is data lifecycle on the live store, so
 *  it is opt-in and only ever moves cache membership — journals stay on disk and
 *  an archived session is transparently revived when it is resolved or resumed. */
export interface RetentionConfig {
  /** Master switch. False ⇒ the archival pass is skipped entirely. */
  enabled: boolean;
  /** A terminal session is eligible once its last activity is older than this. */
  retentionDays: number;
  /** Sessions archived per pass — rate limit, mirroring scratch.perSweep. */
  perSweep: number;
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
  /** Fleet-wide default for Remote Control on claude sessions (`kteam start`
   *  without `--rc`/`--no-rc`, and every UI/API start that omits the field).
   *  True: every claude teammate is also visible/steerable in the user's RC
   *  surface. Set false to make RC strictly opt-in. */
  remoteControl: boolean;
  warden: WardenConfig;
  scratch: ScratchConfig;
  retention: RetentionConfig;
  learning: LearningConfig;
  /** Context-window overrides for transcript-based context accounting:
   *  substring pattern → window size, longest match wins. Built-ins: `[1m]`
   *  ⇒ 1M, default 200k (codex reports its own window in token_count). */
  contextWindows?: Record<string, number>;
}

export const defaultWardenFailoverConfig = (): WardenFailoverConfig => ({
  policy: 'fallback',
  failureThreshold: 2,
  cooldownMinutes: 30,
});

export const defaultWardenConfig = (): WardenConfig => ({
  enabled: false,
  // Wardens JUDGE sus sessions (A6): understand the task, deep-dive the process,
  // verdict leave/nudge/resume/kill. That verdict work is triage — the mechanical
  // tier per CLAUDE.md's routing — so wardens default to GLM-5.2 to save tokens
  // rather than burning an Opus-class session per sweep.
  //
  // GLM caveat: this account resolves the `opus`/`fable` aliases to `glm-5.2` via
  // its own env; leave `model` UNSET so KTEAM_MODEL=opus resolves correctly. Never
  // pin `model` to a raw claude id here — a `claude-*`/`[1m]` suffix 400s the z.ai
  // API (kfleet/config.yaml documents this).
  wrapper: 'claude-auto-glm52a',
  // `accounts` is deliberately left unset: the legacy single-wrapper path IS
  // the default. Listing accounts (in config.json or via the settings surface)
  // opts into failover; the failover knobs below then govern selection.
  failover: defaultWardenFailoverConfig(),
  intervalMinutes: 5,
  unattendedMinutes: 30,
  minSpawnGapMinutes: 15,
  susThinkingSeconds: 900,
  susSubprocessSeconds: 900,
  maxAssignedWardens: 1,
  assignedCooldownMinutes: 30,
  // A LEAVE verdict blesses the session for 15 minutes (per-flag, dropped on any
  // status change) so the next sweep skips it instead of re-judging it.
  blessMinutes: 15,
});

export const defaultScratchConfig = (): ScratchConfig => ({
  enabled: true,
  ttlHours: 24,
  perSweep: 5,
});

export const defaultRetentionConfig = (): RetentionConfig => ({
  // OFF by default — hot-store archival is opt-in until it has run on a real
  // fleet. Flip `enabled` (and tune retentionDays) once vetted.
  enabled: false,
  retentionDays: 14,
  perSweep: 50,
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
  // RC on by default: the flags are additive (they change nothing about how the
  // TUI is driven from kteam) and the user's stated intent is to see every
  // teammate in their remote-control surface.
  remoteControl: true,
  warden: defaultWardenConfig(),
  scratch: defaultScratchConfig(),
  retention: defaultRetentionConfig(),
  learning: defaultLearningConfig(),
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
    warden: {
      ...defaultWardenConfig(),
      ...(onDisk.warden ?? {}),
      // One level deeper for failover so a partial `{ failover: { policy } }`
      // keeps the default threshold/cooldown rather than dropping them.
      failover: { ...defaultWardenFailoverConfig(), ...(onDisk.warden?.failover ?? {}) },
    },
    scratch: { ...defaultScratchConfig(), ...(onDisk.scratch ?? {}) },
    retention: { ...defaultRetentionConfig(), ...(onDisk.retention ?? {}) },
    learning: { ...defaultLearningConfig(), ...(onDisk.learning ?? {}) },
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
