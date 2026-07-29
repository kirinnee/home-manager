import { open, chmod, lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserError } from './browser-types';
import type { KTeamPaths } from './paths';

const LEASE_FILE = 'profile.lock';
const RECLAIM_FILE = 'profile.lock.reclaim';
const METADATA_FILE = 'profile.metadata.json';
const PRIMED_FILE = 'profile.primed.json';
const STALE_CHROME_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'] as const;

export interface BrowserProfileLeaseRecord {
  sessionId: string;
  daemonPid: number;
  chromePid?: number;
  acquiredAt: string;
}

export interface BrowserProfileMetadata {
  createdChromeVersion?: string;
  createdAt?: string;
  primedChromeVersion?: string;
  primedAt?: string;
  /** Greatest Chrome major that has actually been spawned on this profile. */
  latestChromeVersion?: string;
  latestAt?: string;
}

export interface BrowserProfileOptions {
  daemonPid?: number;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export interface BrowserProfileAcquireOptions {
  sessionId: string;
  chromeVersion?: string;
}

export interface BrowserProfileLease {
  readonly profile: string;
  readonly sessionId: string;
  readonly daemonPid: number;
  readonly acquiredAt: string;
  /** The lease was recovered from a daemon whose recorded pid was dead. */
  readonly recoveredDeadOwner: boolean;
  updateChromePid(chromePid?: number, chromeVersion?: string): Promise<void>;
  /** Removes only demonstrably stale Chrome lock material. */
  cleanupStaleChromeLocks(): Promise<string[]>;
  markPrimed(chromeVersion: string): Promise<void>;
  /** Returns true only when this lease still owned and removed the lease. */
  release(): Promise<boolean>;
}

type SingletonLockState =
  | { kind: 'missing' }
  | { kind: 'stale'; pid: number }
  | { kind: 'live'; pid: number }
  | { kind: 'unknown'; detail: string };

export type BrowserProfileBusyReason = 'lease' | 'chrome' | 'unknown';

export class BrowserProfileBusyError extends BrowserError {
  constructor(
    message: string,
    readonly reason: BrowserProfileBusyReason,
  ) {
    super('profile_busy', message.slice(0, 500), 409);
  }
}

function profileBusy(message: string, reason: BrowserProfileBusyReason = 'chrome'): BrowserProfileBusyError {
  return new BrowserProfileBusyError(message, reason);
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseLease(value: string): BrowserProfileLeaseRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<BrowserProfileLeaseRecord>;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId || !validPid(parsed.daemonPid)) return undefined;
    if (parsed.chromePid !== undefined && !validPid(parsed.chromePid)) return undefined;
    if (typeof parsed.acquiredAt !== 'string') return undefined;
    return {
      sessionId: parsed.sessionId,
      daemonPid: parsed.daemonPid,
      ...(parsed.chromePid === undefined ? {} : { chromePid: parsed.chromePid }),
      acquiredAt: parsed.acquiredAt,
    };
  } catch {
    return undefined;
  }
}

function parseChromeMajor(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = version.match(/(?:^|\D)(\d{1,4})(?:\.\d+){0,3}(?:\D|$)/);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major >= 0 ? major : undefined;
}

/** Returns -1 when running Chrome is older, 0 when equal, and 1 when newer. */
export function compareChromeVersions(running: string, recorded: string): -1 | 0 | 1 | undefined {
  const runningMajor = parseChromeMajor(running);
  const recordedMajor = parseChromeMajor(recorded);
  if (runningMajor === undefined || recordedMajor === undefined) return undefined;
  return runningMajor === recordedMajor ? 0 : runningMajor < recordedMajor ? -1 : 1;
}

function highestRecordedChromeVersion(metadata: BrowserProfileMetadata | undefined): string | undefined {
  let highest: { version: string; major: number } | undefined;
  for (const version of [
    metadata?.createdChromeVersion,
    metadata?.primedChromeVersion,
    metadata?.latestChromeVersion,
  ]) {
    const major = parseChromeMajor(version);
    if (version && major !== undefined && (!highest || major > highest.major)) highest = { version, major };
  }
  return highest?.version;
}

/**
 * Daemon-global durable Chrome profile lifecycle. It deliberately knows nothing
 * about cookies: signed-in state is the explicit primed marker only.
 */
export class BrowserProfile {
  readonly browserDirectory: string;
  readonly profile: string;
  readonly leaseFile: string;
  private readonly daemonPid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly now: () => Date;

  constructor(daemonDirectory: string, options: BrowserProfileOptions = {}) {
    this.browserDirectory = path.join(daemonDirectory, 'browser');
    this.profile = path.join(this.browserDirectory, 'profile');
    this.leaseFile = path.join(this.browserDirectory, LEASE_FILE);
    this.daemonPid = options.daemonPid ?? process.pid;
    this.hostname = options.hostname ?? os.hostname();
    this.isProcessAlive =
      options.isProcessAlive ??
      (pid => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      });
    this.now = options.now ?? (() => new Date());
  }

  async acquire(options: BrowserProfileAcquireOptions): Promise<BrowserProfileLease> {
    if (!options.sessionId) throw new BrowserError('bad_request', 'a browser profile session id is required', 400);
    await this.ensureProfile(options.chromeVersion);

    let recoveredDeadOwner = false;
    for (;;) {
      const desired: BrowserProfileLeaseRecord = {
        sessionId: options.sessionId,
        daemonPid: this.daemonPid,
        acquiredAt: this.now().toISOString(),
      };
      try {
        await this.createExclusive(this.leaseFile, desired);
        try {
          const singleton = await this.singletonLockState();
          if (singleton.kind === 'live') {
            await this.releaseRecord(desired);
            throw profileBusy(`shared browser profile is in use by Chrome pid ${singleton.pid}`);
          }
          if (singleton.kind === 'unknown') {
            await this.releaseRecord(desired);
            throw profileBusy(`shared browser profile lock cannot be verified: ${singleton.detail}`);
          }
          return this.lease(desired, recoveredDeadOwner || singleton.kind === 'stale');
        } catch (error) {
          if (error instanceof BrowserError) throw error;
          await this.releaseRecord(desired);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const current = await this.readLease();
      if (!current) {
        // A concurrent releaser/reclaimer changed the file; retry O_EXCL.
        continue;
      }
      if (current.sessionId === options.sessionId && current.daemonPid === this.daemonPid) {
        return this.lease(current, false);
      }
      if (this.isProcessAlive(current.daemonPid)) {
        throw profileBusy(
          `shared browser profile is leased by session ${current.sessionId} (daemon pid ${current.daemonPid})`,
          current.daemonPid === this.daemonPid ? 'lease' : 'unknown',
        );
      }
      if (current.chromePid && this.isProcessAlive(current.chromePid)) {
        throw profileBusy(`shared browser profile still has a live orphaned Chrome pid ${current.chromePid}`, 'chrome');
      }
      await this.reclaimDeadLease(current);
      recoveredDeadOwner = true;
    }
  }

  async isPrimed(): Promise<boolean> {
    const marker = await this.readJson<unknown>(path.join(this.browserDirectory, PRIMED_FILE));
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const value = marker as Record<string, unknown>;
    return (
      typeof value['version'] === 'string' &&
      value['version'].trim().length > 0 &&
      typeof value['primedAt'] === 'string' &&
      Number.isFinite(Date.parse(value['primedAt']))
    );
  }

  async assertChromeVersionCompatible(runningChromeVersion: string): Promise<void> {
    const metadata = await this.readJson<BrowserProfileMetadata>(path.join(this.browserDirectory, METADATA_FILE));
    const recorded = highestRecordedChromeVersion(metadata);
    if (!recorded || compareChromeVersions(runningChromeVersion, recorded) !== -1) return;
    throw new BrowserError(
      'launch_failed',
      `Chrome ${runningChromeVersion.slice(0, 160)} is older than shared-profile Chrome ${recorded.slice(0, 160)}; refusing to risk profile data`,
      409,
    );
  }

  private lease(record: BrowserProfileLeaseRecord, recoveredDeadOwner: boolean): BrowserProfileLease {
    return {
      profile: this.profile,
      sessionId: record.sessionId,
      daemonPid: this.daemonPid,
      acquiredAt: record.acquiredAt,
      recoveredDeadOwner,
      updateChromePid: async (chromePid, chromeVersion) => await this.updateChromePid(record, chromePid, chromeVersion),
      cleanupStaleChromeLocks: async () => await this.cleanupStaleChromeLocks(record, recoveredDeadOwner),
      markPrimed: async chromeVersion => await this.markPrimed(record, chromeVersion),
      release: async () => await this.release(record),
    };
  }

  private async ensureProfile(chromeVersion?: string): Promise<void> {
    await mkdir(this.browserDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    await chmod(this.browserDirectory, 0o700);
    await chmod(this.profile, 0o700);
    const metadataFile = path.join(this.browserDirectory, METADATA_FILE);
    const existing = await this.readJson<BrowserProfileMetadata>(metadataFile);
    if (!existing && chromeVersion?.trim()) {
      await this.writeJson(metadataFile, {
        createdChromeVersion: chromeVersion.trim(),
        createdAt: this.now().toISOString(),
      });
    }
  }

  private async updateChromePid(
    expected: BrowserProfileLeaseRecord,
    chromePid?: number,
    chromeVersion?: string,
  ): Promise<void> {
    if (chromePid !== undefined && !validPid(chromePid)) {
      throw new BrowserError('bad_request', 'browser Chrome pid must be a positive integer', 400);
    }
    const current = await this.requireOwner(expected);
    if (chromeVersion !== undefined) await this.recordChromeVersion(chromeVersion);
    const updated: BrowserProfileLeaseRecord = { ...current, ...(chromePid === undefined ? {} : { chromePid }) };
    if (chromePid === undefined) delete updated.chromePid;
    await this.replaceLease(updated);
  }

  private async markPrimed(expected: BrowserProfileLeaseRecord, chromeVersion: string): Promise<void> {
    await this.requireOwner(expected);
    const version = chromeVersion.trim();
    if (!version)
      throw new BrowserError('bad_request', 'the Chrome version used to prime the profile is required', 400);
    const metadataFile = path.join(this.browserDirectory, METADATA_FILE);
    const metadata = (await this.readJson<BrowserProfileMetadata>(metadataFile)) ?? {};
    const previousLatest = highestRecordedChromeVersion(metadata);
    const latestChromeVersion =
      previousLatest && compareChromeVersions(version, previousLatest) === -1 ? previousLatest : version;
    await this.writeJson(metadataFile, {
      ...metadata,
      ...(metadata.createdChromeVersion ? {} : { createdChromeVersion: version, createdAt: this.now().toISOString() }),
      primedChromeVersion: version,
      primedAt: this.now().toISOString(),
      latestChromeVersion,
      latestAt: this.now().toISOString(),
    });
    await this.writeJson(path.join(this.browserDirectory, PRIMED_FILE), {
      version,
      primedAt: this.now().toISOString(),
    });
  }

  private async recordChromeVersion(chromeVersion: string): Promise<void> {
    const version = chromeVersion.trim();
    if (parseChromeMajor(version) === undefined) {
      throw new BrowserError('launch_failed', 'Chrome returned an unreadable version for the shared profile', 503);
    }
    const metadataFile = path.join(this.browserDirectory, METADATA_FILE);
    const metadata = (await this.readJson<BrowserProfileMetadata>(metadataFile)) ?? {};
    const previous = highestRecordedChromeVersion(metadata);
    if (previous && compareChromeVersions(version, previous) !== 1) return;
    await this.writeJson(metadataFile, {
      ...metadata,
      latestChromeVersion: version,
      latestAt: this.now().toISOString(),
    });
  }

  private async cleanupStaleChromeLocks(
    expected: BrowserProfileLeaseRecord,
    recoveredDeadOwner: boolean,
  ): Promise<string[]> {
    await this.requireOwner(expected);
    const singleton = await this.singletonLockState();
    if (singleton.kind === 'live') {
      throw profileBusy(`shared browser profile is in use by Chrome pid ${singleton.pid}`);
    }
    if (singleton.kind === 'unknown') {
      throw profileBusy(`shared browser profile lock cannot be verified: ${singleton.detail}`);
    }
    // A dead SingletonLock pid proves these files are stale. With no singleton,
    // only a reclaimed dead daemon lease supplies that proof for DevTools metadata.
    if (singleton.kind !== 'stale' && !recoveredDeadOwner) return [];
    const removed: string[] = [];
    for (const name of STALE_CHROME_FILES) {
      const file = path.join(this.profile, name);
      try {
        await lstat(file);
        await rm(file);
        removed.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  private async release(expected: BrowserProfileLeaseRecord): Promise<boolean> {
    const current = await this.readLease();
    if (!current) return false;
    if (!this.sameLease(current, expected)) return false;
    await rm(this.leaseFile, { force: true });
    return true;
  }

  private async requireOwner(expected: BrowserProfileLeaseRecord): Promise<BrowserProfileLeaseRecord> {
    const current = await this.readLease();
    if (current && this.sameLease(current, expected)) return current;
    throw profileBusy('shared browser profile lease is no longer owned by this session', 'lease');
  }

  private sameLease(current: BrowserProfileLeaseRecord, expected: BrowserProfileLeaseRecord): boolean {
    return (
      current.sessionId === expected.sessionId &&
      current.daemonPid === expected.daemonPid &&
      current.acquiredAt === expected.acquiredAt
    );
  }

  private async reclaimDeadLease(expected: BrowserProfileLeaseRecord): Promise<void> {
    const reclaimFile = path.join(this.browserDirectory, RECLAIM_FILE);
    try {
      await this.createExclusive(reclaimFile, {
        sessionId: `reclaim-${this.daemonPid}`,
        daemonPid: this.daemonPid,
        acquiredAt: this.now().toISOString(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // The reclaim guard itself may have been left by a crashed reclaimer.
        // It is safe to clear only when *its* owner pid is dead; otherwise the
        // live reclaimer has the exclusive right to finish this recovery.
        const reclaimer = await this.readReclaimer(reclaimFile);
        if (!reclaimer || !this.isProcessAlive(reclaimer.daemonPid)) {
          await rm(reclaimFile, { force: true });
          return;
        }
        await Bun.sleep(10);
        return;
      }
      throw error;
    }
    try {
      const current = await this.readLease();
      if (!current) return;
      if (current.sessionId !== expected.sessionId || current.daemonPid !== expected.daemonPid) return;
      if (this.isProcessAlive(current.daemonPid)) return;
      if (current.chromePid && this.isProcessAlive(current.chromePid)) return;
      await rm(this.leaseFile, { force: true });
    } finally {
      await rm(reclaimFile, { force: true });
    }
  }

  private async singletonLockState(): Promise<SingletonLockState> {
    let target: string;
    try {
      target = await readlink(path.join(this.profile, 'SingletonLock'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unknown', detail: 'not a readable symlink' };
    }
    const match = path.basename(target).match(/^(.+)-(\d+)$/);
    if (!match || match[1] !== this.hostname || !validPid(Number(match[2]))) {
      return { kind: 'unknown', detail: 'owner hostname or pid is not local and parseable' };
    }
    const pid = Number(match[2]);
    return this.isProcessAlive(pid) ? { kind: 'live', pid } : { kind: 'stale', pid };
  }

  private async readLease(): Promise<BrowserProfileLeaseRecord | undefined> {
    try {
      const record = parseLease(await readFile(this.leaseFile, 'utf8'));
      if (!record)
        throw profileBusy('shared browser profile lease is malformed and cannot be safely reclaimed', 'unknown');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readReclaimer(file: string): Promise<BrowserProfileLeaseRecord | undefined> {
    try {
      return parseLease(await readFile(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async createExclusive(file: string, value: BrowserProfileLeaseRecord): Promise<void> {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
    } finally {
      await handle.close();
    }
  }

  private async replaceLease(value: BrowserProfileLeaseRecord): Promise<void> {
    const temporary = `${this.leaseFile}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await rename(temporary, this.leaseFile);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async releaseRecord(record: BrowserProfileLeaseRecord): Promise<void> {
    const current = await this.readLease();
    if (current && this.sameLease(current, record)) {
      await rm(this.leaseFile, { force: true });
    }
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function createBrowserProfile(
  paths: Pick<KTeamPaths, 'daemon'>,
  options?: BrowserProfileOptions,
): BrowserProfile {
  return new BrowserProfile(paths.daemon, options);
}
