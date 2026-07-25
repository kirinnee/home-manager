import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KTEAM_OWNED_ENTRIES,
  isKteamOwned,
  reclaimScratch,
  scanScratch,
  scratchEligibility,
  trimSnapshots,
} from './scratch-gc';

// `~/.kteam` reached 8.9 GB, and almost none of it was kteam's: teammates leave
// working checkouts and build output inside their session directory (one held
// 411 MB + 377 MB of `cyanprint-tmp-*`). These tests pin the two halves of the
// contract — WHAT may be deleted (never kteam's own record) and WHEN.

const temporaryDirs: string[] = [];

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kteam-scratch-gc-test-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temporaryDirs.splice(0)) {
    // The read-only-tree case leaves modes that defeat rm; relax first.
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const HOUR = 3_600_000;
const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const TTL = 24 * HOUR;

const baseline = {
  status: 'completed',
  finishedAt: new Date(NOW - 48 * HOUR).toISOString(),
  newestMtimeMs: NOW - 48 * HOUR,
  nowMs: NOW,
  ttlMs: TTL,
  hasMonitor: false,
  hasLivePane: false,
  launching: false,
  wardenTarget: false,
};

describe('eligibility truth table', () => {
  test('terminal and older than the TTL is eligible', () => {
    expect(scratchEligibility(baseline)).toEqual({ eligible: true });
  });

  for (const status of ['completed', 'failed', 'stopped', 'stalled']) {
    test(`${status} counts as terminal`, () => {
      expect(scratchEligibility({ ...baseline, status }).eligible).toBe(true);
    });
  }

  for (const status of ['running', 'thinking', 'tool_running', 'waiting', 'starting', 'rate_limited']) {
    test(`${status} is NOT terminal — never eligible`, () => {
      const verdict = scratchEligibility({ ...baseline, status });
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toBe('not terminal');
    });
  }

  test('terminal but RECENT is not eligible', () => {
    const verdict = scratchEligibility({
      ...baseline,
      finishedAt: new Date(NOW - 2 * HOUR).toISOString(),
      newestMtimeMs: NOW - 2 * HOUR,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain('under the TTL');
  });

  test('a live monitor blocks the reclaim', () => {
    expect(scratchEligibility({ ...baseline, hasMonitor: true })).toEqual({
      eligible: false,
      reason: 'a monitor is still attached',
    });
  });

  test('a live pane blocks the reclaim', () => {
    expect(scratchEligibility({ ...baseline, hasLivePane: true }).eligible).toBe(false);
  });

  test('an in-flight launch claim blocks the reclaim', () => {
    expect(scratchEligibility({ ...baseline, launching: true }).eligible).toBe(false);
  });

  test('a live warden assigned to the session blocks the reclaim', () => {
    expect(scratchEligibility({ ...baseline, wardenTarget: true }).eligible).toBe(false);
  });

  test('belt and braces: a file touched inside the TTL blocks it even when finishedAt is old', () => {
    const verdict = scratchEligibility({ ...baseline, newestMtimeMs: NOW - 1 * HOUR });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain('changed inside the TTL');
  });

  test('no finishedAt falls back to the newest file mtime', () => {
    expect(scratchEligibility({ ...baseline, finishedAt: undefined }).eligible).toBe(true);
    expect(scratchEligibility({ ...baseline, finishedAt: undefined, newestMtimeMs: NOW - HOUR }).eligible).toBe(false);
  });

  test('nothing to age from is refused, not guessed', () => {
    const verdict = scratchEligibility({ ...baseline, finishedAt: undefined, newestMtimeMs: undefined });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain('no finishedAt');
  });
});

describe('the whitelist decides what is scratch', () => {
  test('every kteam-owned entry is recognised, plus its atomic-write temp files', () => {
    for (const name of KTEAM_OWNED_ENTRIES) expect(isKteamOwned(name)).toBe(true);
    expect(isKteamOwned('state.json.tmp.1234.9f14-abcd')).toBe(true);
    expect(isKteamOwned('cyanprint-tmp-9931')).toBe(false);
    expect(isKteamOwned('node_modules')).toBe(false);
  });

  test('scanScratch classifies only non-kteam entries, largest first', async () => {
    const dir = await temporaryDir();
    await writeFile(path.join(dir, 'config.json'), '{}');
    await writeFile(path.join(dir, 'events.jsonl'), 'x'.repeat(500));
    await mkdir(path.join(dir, 'snapshots'), { recursive: true });
    await writeFile(path.join(dir, 'snapshots', 'a.txt'), 'x'.repeat(2_000));
    await mkdir(path.join(dir, 'checkout'), { recursive: true });
    await writeFile(path.join(dir, 'checkout', 'big.bin'), 'x'.repeat(4_000));
    await writeFile(path.join(dir, 'scratch.log'), 'x'.repeat(100));

    const scan = await scanScratch(dir);
    expect(scan.entries.map(entry => entry.name)).toEqual(['checkout', 'scratch.log']);
    expect(scan.entries[0]!.kind).toBe('directory');
    expect(scan.bytes).toBeGreaterThan(4_000);
  });

  test('a reclaim never removes a kteam-owned entry, even if asked to', async () => {
    const dir = await temporaryDir();
    await writeFile(path.join(dir, 'events.jsonl'), 'journal');
    await mkdir(path.join(dir, 'snapshots'), { recursive: true });
    await writeFile(path.join(dir, 'junk'), 'junk');

    const result = await reclaimScratch(dir, [
      { name: 'events.jsonl', bytes: 7, kind: 'file' },
      { name: 'snapshots', bytes: 0, kind: 'directory' },
      { name: 'junk', bytes: 4, kind: 'file' },
    ]);
    expect(result.removed).toEqual(['junk']);
    expect(result.failures.map(failure => failure.entry).sort()).toEqual(['events.jsonl', 'snapshots']);
    expect(await lstat(path.join(dir, 'events.jsonl')).then(() => true)).toBe(true);
    expect(await lstat(path.join(dir, 'snapshots')).then(() => true)).toBe(true);
  });
});

describe('reclaim robustness', () => {
  test('a read-only tree is chmod-ed and removed rather than skipped', async () => {
    const dir = await temporaryDir();
    const build = path.join(dir, 'bin', 'Debug');
    await mkdir(build, { recursive: true });
    await writeFile(path.join(build, 'app.dll'), 'binary');
    // Exactly the case that failed by hand: read-only files in a read-only dir.
    await chmod(path.join(build, 'app.dll'), 0o444);
    await chmod(build, 0o500);

    const scan = await scanScratch(dir);
    const result = await reclaimScratch(dir, scan.entries);
    expect(result.failures).toEqual([]);
    expect(result.removed).toEqual(['bin']);
    expect(await lstat(path.join(dir, 'bin')).catch(() => undefined)).toBeUndefined();
  });

  test('a symlink out of the session dir is unlinked, never followed', async () => {
    const dir = await temporaryDir();
    const outside = await temporaryDir();
    const treasure = path.join(outside, 'do-not-delete.txt');
    await writeFile(treasure, 'precious');
    await symlink(outside, path.join(dir, 'escape'));

    const scan = await scanScratch(dir);
    expect(scan.entries.map(entry => entry.kind)).toEqual(['symlink']);
    const result = await reclaimScratch(dir, scan.entries);

    expect(result.removed[0]).toContain('escape ->');
    // The link is gone; everything it pointed at survives untouched.
    expect(await lstat(path.join(dir, 'escape')).catch(() => undefined)).toBeUndefined();
    expect(await lstat(treasure).then(() => true)).toBe(true);
  });

  test('a path escaping the session directory is refused outright', async () => {
    const dir = await temporaryDir();
    const outside = await temporaryDir();
    await writeFile(path.join(outside, 'victim.txt'), 'precious');

    const result = await reclaimScratch(dir, [
      { name: '../victim.txt', bytes: 8, kind: 'file' },
      { name: path.join('nested', 'deep'), bytes: 8, kind: 'file' },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]!.message).toContain('refused');
  });

  test('one unremovable entry does not abort the rest of the pass', async () => {
    const dir = await temporaryDir();
    await writeFile(path.join(dir, 'good-a'), 'a');
    await writeFile(path.join(dir, 'good-b'), 'b');

    const result = await reclaimScratch(dir, [
      { name: 'good-a', bytes: 1, kind: 'file' },
      { name: '../nope', bytes: 1, kind: 'file' },
      { name: 'good-b', bytes: 1, kind: 'file' },
    ]);
    expect(result.removed).toEqual(['good-a', 'good-b']);
    expect(result.failures).toHaveLength(1);
  });

  test('scanning alone frees nothing — a dry run is genuinely read-only', async () => {
    const dir = await temporaryDir();
    await mkdir(path.join(dir, 'checkout'), { recursive: true });
    await writeFile(path.join(dir, 'checkout', 'file'), 'x'.repeat(1_000));

    const before = await scanScratch(dir);
    expect(before.bytes).toBeGreaterThan(1_000);
    const after = await scanScratch(dir);
    expect(after.bytes).toBe(before.bytes);
    expect(await lstat(path.join(dir, 'checkout')).then(() => true)).toBe(true);
  });
});

describe('snapshot retention', () => {
  test('trims to maxSnapshots, keeping the newest', async () => {
    const dir = await temporaryDir();
    await mkdir(path.join(dir, 'snapshots'), { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      await writeFile(path.join(dir, 'snapshots', `2026-07-25T00-00-0${index}.txt`), 'frame');
    }
    const result = await trimSnapshots(dir, 4);
    expect(result.removed).toBe(6);
    const scan = await scanScratch(dir);
    // snapshots/ is kteam-owned, so it never appears as scratch.
    expect(scan.entries).toEqual([]);
    expect(await lstat(path.join(dir, 'snapshots', '2026-07-25T00-00-09.txt')).then(() => true)).toBe(true);
    expect(await lstat(path.join(dir, 'snapshots', '2026-07-25T00-00-00.txt')).catch(() => undefined)).toBeUndefined();
  });

  test('a retention of zero or nonsense is ignored, never a wipe', async () => {
    const dir = await temporaryDir();
    await mkdir(path.join(dir, 'snapshots'), { recursive: true });
    await writeFile(path.join(dir, 'snapshots', 'a.txt'), 'frame');
    expect((await trimSnapshots(dir, 0)).removed).toBe(0);
    expect((await trimSnapshots(dir, Number.NaN)).removed).toBe(0);
    expect(await lstat(path.join(dir, 'snapshots', 'a.txt')).then(() => true)).toBe(true);
  });
});
