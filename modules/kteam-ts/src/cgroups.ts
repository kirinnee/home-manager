import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { availableParallelism, totalmem } from 'os';
import { run } from './io';

export interface CgroupLimit {
  /** Percentage of all host CPU capacity (90 on 8 CPUs => CPUQuota=720%). */
  cpuPercent: number;
  /** Percentage of host physical RAM. */
  memoryPercent: number;
}

export interface CgroupConfig {
  /** Master switch. False bypasses systemd-run for new/relaunched agents. */
  enabled: boolean;
  /** Aggregate ceiling shared by every managed agent. */
  fleet: CgroupLimit;
  /** Ceiling applied independently to every managed agent. */
  perAgent: CgroupLimit;
}

export interface CgroupTarget {
  sessionId: string;
  panePid?: number;
}

export interface CgroupConfigView {
  config: CgroupConfig;
  supported: boolean;
  fleetSlice: string;
  effective: {
    cpus: number;
    memoryBytes: number;
    fleet: { cpuQuota: string; memoryMax: string };
    perAgent: { cpuQuota: string; memoryMax: string };
  };
  /** Live sessions that must be relaunched to enter or leave managed scopes. */
  restartRequiredSessions: string[];
  warnings: string[];
}

export type CgroupConfigPatch = Partial<Omit<CgroupConfig, 'fleet' | 'perAgent'>> & {
  fleet?: Partial<CgroupLimit>;
  perAgent?: Partial<CgroupLimit>;
};

type Runner = typeof run;
type ProcReader = (pid: number) => Promise<string>;
type ScopePlacement = {
  scope?: string;
  warning?: string;
};

export interface CgroupControllerOptions {
  platform?: NodeJS.Platform;
  runner?: Runner;
  procReader?: ProcReader;
  cpus?: number;
  memoryBytes?: number;
  fleetSlice?: string;
  nonce?: () => string;
  cgroupV2?: boolean;
}

export const KTEAM_FLEET_SLICE = 'kteam-fleet.slice';

export const defaultCgroupConfig = (platform: NodeJS.Platform = process.platform): CgroupConfig => ({
  // Linux is the deployment target for this feature. Keep launchd hosts on the
  // established direct-exec path unless an implementation exists there.
  enabled: platform === 'linux',
  fleet: { cpuPercent: 90, memoryPercent: 90 },
  perAgent: { cpuPercent: 25, memoryPercent: 25 },
});

export function mergeCgroupConfig(base: CgroupConfig, patch: CgroupConfigPatch): CgroupConfig {
  return {
    ...base,
    ...patch,
    fleet: { ...base.fleet, ...(patch.fleet ?? {}) },
    perAgent: { ...base.perAgent, ...(patch.perAgent ?? {}) },
  };
}

export function validateCgroupConfig(config: CgroupConfig): void {
  const bad = (message: string): never => {
    throw new Error(`invalid cgroup config: ${message}`);
  };
  if (typeof config.enabled !== 'boolean') bad('enabled must be a boolean');
  for (const [name, limits] of [
    ['fleet', config.fleet],
    ['perAgent', config.perAgent],
  ] as const) {
    for (const field of ['cpuPercent', 'memoryPercent'] as const) {
      const value = limits?.[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100)
        bad(`${name}.${field} must be a finite number in (0, 100]`);
    }
  }
  if (config.perAgent.cpuPercent > config.fleet.cpuPercent) bad('perAgent.cpuPercent must not exceed fleet.cpuPercent');
  if (config.perAgent.memoryPercent > config.fleet.memoryPercent)
    bad('perAgent.memoryPercent must not exceed fleet.memoryPercent');
}

export function agentScopeFromCgroup(cgroup: string): string | undefined {
  for (const line of cgroup.split('\n')) {
    const path = line.slice(line.indexOf('/') >= 0 ? line.indexOf('/') : 0);
    const match = path.match(/(?:^|\/)(kteam-agent-[^/]+\.scope)(?:\/|$)/);
    if (match) return match[1];
  }
  return undefined;
}

function safeUnitPart(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9_-]/g, '-').replaceAll(/^-+|-+$/g, '');
  return (safe || 'session').slice(0, 96);
}

export class CgroupController {
  private configValue: CgroupConfig;
  private readonly platform: NodeJS.Platform;
  private readonly runner: Runner;
  private readonly procReader: ProcReader;
  private readonly cpus: number;
  private readonly memoryBytes: number;
  private readonly fleetSlice: string;
  private readonly nonce: () => string;
  private readonly cgroupV2: boolean;
  private preparedFingerprint?: string;
  private lastWarnings: string[] = [];

  constructor(config: CgroupConfig, options: CgroupControllerOptions = {}) {
    validateCgroupConfig(config);
    this.configValue = config;
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? run;
    this.procReader = options.procReader ?? (async pid => await readFile(`/proc/${pid}/cgroup`, 'utf8'));
    this.cpus = Math.max(1, Math.floor(options.cpus ?? availableParallelism()));
    this.memoryBytes = Math.max(1, Math.floor(options.memoryBytes ?? totalmem()));
    this.fleetSlice = options.fleetSlice ?? KTEAM_FLEET_SLICE;
    this.nonce = options.nonce ?? (() => crypto.randomUUID().slice(0, 8));
    this.cgroupV2 = options.cgroupV2 ?? existsSync('/sys/fs/cgroup/cgroup.controllers');
  }

  get config(): CgroupConfig {
    return this.configValue;
  }

  get supported(): boolean {
    return this.platform === 'linux' && this.cgroupV2;
  }

  setConfig(config: CgroupConfig): void {
    validateCgroupConfig(config);
    this.requireSupported(config);
    this.configValue = config;
    if (!config.enabled) {
      this.preparedFingerprint = undefined;
      this.lastWarnings = [];
    }
  }

  private properties(limits: CgroupLimit): { cpuQuota: string; memoryMax: string } {
    return {
      cpuQuota: `${Math.max(1, Math.round(limits.cpuPercent * this.cpus))}%`,
      memoryMax: String(Math.max(1, Math.floor((limits.memoryPercent / 100) * this.memoryBytes))),
    };
  }

  private effective(config = this.configValue): CgroupConfigView['effective'] {
    return {
      cpus: this.cpus,
      memoryBytes: this.memoryBytes,
      fleet: this.properties(config.fleet),
      perAgent: this.properties(config.perAgent),
    };
  }

  private requireSupported(config = this.configValue): void {
    if (config.enabled && !this.supported)
      throw new Error(`cgroup limits require Linux with cgroup v2 (current platform: ${this.platform})`);
  }

  private async command(argv: string[], message: string): Promise<void> {
    const result = await this.runner(argv);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || message);
  }

  async prepareFleet(config = this.configValue): Promise<void> {
    if (!config.enabled) return;
    this.requireSupported(config);
    const fleet = this.properties(config.fleet);
    const fingerprint = `${fleet.cpuQuota}:${fleet.memoryMax}`;
    if (this.preparedFingerprint === fingerprint) return;
    try {
      await this.command(
        [
          'systemctl',
          '--user',
          'set-property',
          '--runtime',
          this.fleetSlice,
          `CPUQuota=${fleet.cpuQuota}`,
          `MemoryMax=${fleet.memoryMax}`,
        ],
        `could not configure ${this.fleetSlice}`,
      );
      this.preparedFingerprint = fingerprint;
      this.lastWarnings = [];
    } catch (error) {
      this.lastWarnings = [error instanceof Error ? error.message : String(error)];
      throw error;
    }
  }

  /**
   * Return the exact argv the generated pane launcher should exec. Disabled
   * means byte-for-byte direct execution: no systemd-run and no probe.
   */
  async agentCommand(sessionId: string, command: string[]): Promise<string[]> {
    if (!this.configValue.enabled) return command;
    await this.prepareFleet();
    const agent = this.properties(this.configValue.perAgent);
    const scope = `kteam-agent-${safeUnitPart(sessionId)}-${safeUnitPart(this.nonce())}.scope`;
    return [
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${scope}`,
      `--slice=${this.fleetSlice}`,
      `--property=CPUQuota=${agent.cpuQuota}`,
      `--property=MemoryMax=${agent.memoryMax}`,
      '--',
      ...command,
    ];
  }

  private async scopeFor(target: CgroupTarget): Promise<ScopePlacement> {
    if (target.panePid === undefined)
      return { warning: `could not determine cgroup placement for ${target.sessionId}: pane pid unavailable` };
    try {
      return { scope: agentScopeFromCgroup(await this.procReader(target.panePid)) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        warning: `could not determine cgroup placement for ${target.sessionId} (pid ${target.panePid}): ${detail}`,
      };
    }
  }

  /**
   * Apply a settings update. Managed scopes take new limits live. Processes
   * cannot safely be adopted into, or moved out of, a transient user scope, so
   * those transitions are returned explicitly for relaunch.
   */
  async apply(config: CgroupConfig, targets: readonly CgroupTarget[]): Promise<CgroupConfigView> {
    this.setConfig(config);
    const placements = await Promise.all(
      targets.map(async target => ({ target, placement: await this.scopeFor(target) })),
    );
    const restartRequiredSessions: string[] = [];
    const warnings = placements.flatMap(({ placement }) => (placement.warning ? [placement.warning] : []));

    if (config.enabled) {
      await this.prepareFleet(config);
      const agent = this.properties(config.perAgent);
      for (const {
        target,
        placement: { scope },
      } of placements) {
        if (!scope) {
          restartRequiredSessions.push(target.sessionId);
          continue;
        }
        try {
          await this.command(
            [
              'systemctl',
              '--user',
              'set-property',
              '--runtime',
              scope,
              `CPUQuota=${agent.cpuQuota}`,
              `MemoryMax=${agent.memoryMax}`,
            ],
            `could not update ${scope}`,
          );
        } catch (error) {
          restartRequiredSessions.push(target.sessionId);
          warnings.push(error instanceof Error ? error.message : String(error));
        }
      }
    } else {
      // A real bypass means no "infinity" write. Existing scoped processes
      // retain their old settings until relaunched through the direct path.
      // Unknown placement is also restart-required: never claim a cap was
      // removed when /proc could not prove that.
      for (const { target, placement } of placements) {
        if (placement.scope || placement.warning) restartRequiredSessions.push(target.sessionId);
      }
      this.preparedFingerprint = undefined;
    }

    this.lastWarnings = warnings;
    return this.describe(
      placements.map(({ target }) => target),
      restartRequiredSessions,
      warnings,
    );
  }

  async describe(
    targets: readonly CgroupTarget[] = [],
    knownRestartRequired?: string[],
    warnings: string[] = [],
  ): Promise<CgroupConfigView> {
    const observed =
      knownRestartRequired === undefined
        ? await Promise.all(targets.map(async target => ({ target, placement: await this.scopeFor(target) })))
        : [];
    const observedWarnings = observed.flatMap(({ placement }) => (placement.warning ? [placement.warning] : []));
    const restartRequiredSessions =
      knownRestartRequired ??
      observed.flatMap(({ target, placement }) => {
        if (placement.warning) return [target.sessionId];
        const managed = placement.scope !== undefined;
        return managed === this.configValue.enabled ? [] : [target.sessionId];
      });
    return {
      config: this.configValue,
      supported: this.supported,
      fleetSlice: this.fleetSlice,
      effective: this.effective(),
      restartRequiredSessions: [...new Set(restartRequiredSessions)].sort(),
      warnings: [...new Set([...this.lastWarnings, ...warnings, ...observedWarnings])],
    };
  }

  async daemonOutsideFleet(pid: number): Promise<boolean | undefined> {
    const cgroup = await this.procReader(pid).catch(() => undefined);
    if (cgroup === undefined) return undefined;
    return !cgroup.split('\n').some(line => line.includes(`/${this.fleetSlice}`));
  }
}
