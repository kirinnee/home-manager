import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserError } from './browser-types';
import { BrowserProfile, compareChromeVersions, createBrowserProfile } from './browser-profile';

const roots: string[] = [];

async function profile(options: ConstructorParameters<typeof BrowserProfile>[1] = {}): Promise<BrowserProfile> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kteam-browser-profile-'));
  roots.push(root);
  return new BrowserProfile(path.join(root, 'daemon'), { daemonPid: 10_001, hostname: 'test-host', ...options });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('shared browser profile', () => {
  test('uses the daemon directory, creates an empty private profile, and stays unprimed despite cookie-like files', async () => {
    const browser = await profile();
    const lease = await browser.acquire({ sessionId: 'first', chromeVersion: 'Chrome 150.0.1.0' });
    expect(lease.profile).toBe(path.join(browser.browserDirectory, 'profile'));
    expect((await stat(browser.browserDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(lease.profile)).mode & 0o777).toBe(0o700);
    await writeFile(path.join(lease.profile, 'Cookies'), 'not inspected');
    expect(await browser.isPrimed()).toBe(false);
    expect(JSON.stringify(await readFile(path.join(lease.profile, 'Cookies'), 'utf8'))).toContain('not inspected');
  });

  test('is idempotent for one session/daemon, refuses a live lease, and reclaims a dead lease', async () => {
    const browser = await profile({ isProcessAlive: pid => pid === 10_001 });
    const first = await browser.acquire({ sessionId: 'first' });
    expect((await browser.acquire({ sessionId: 'first' })).profile).toBe(first.profile);
    await first.updateChromePid(4_242);
    expect(JSON.parse(await readFile(browser.leaseFile, 'utf8'))).toMatchObject({ chromePid: 4_242 });

    const other = new BrowserProfile(path.dirname(browser.browserDirectory), {
      daemonPid: 20_002,
      hostname: 'test-host',
      isProcessAlive: pid => pid === 10_001,
    });
    await expect(other.acquire({ sessionId: 'second' })).rejects.toMatchObject({
      code: 'profile_busy',
      reason: 'unknown',
      status: 409,
    });
    expect(await first.release()).toBe(true);
    expect(await first.release()).toBe(false);

    await writeFile(
      browser.leaseFile,
      JSON.stringify({ sessionId: 'crashed', daemonPid: 99_999, acquiredAt: new Date(0).toISOString() }),
    );
    const reclaimed = await browser.acquire({ sessionId: 'first' });
    expect(reclaimed.recoveredDeadOwner).toBe(true);
    expect(JSON.parse(await readFile(browser.leaseFile, 'utf8'))).toMatchObject({
      sessionId: 'first',
      daemonPid: 10_001,
    });
  });

  test('never reclaims a dead daemon lease while its recorded Chrome child is still alive', async () => {
    const browser = await profile({ isProcessAlive: pid => pid === 77_777 });
    await browser.acquire({ sessionId: 'seed' });
    await writeFile(
      browser.leaseFile,
      JSON.stringify({
        sessionId: 'crashed',
        daemonPid: 99_999,
        chromePid: 77_777,
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    await expect(browser.acquire({ sessionId: 'next' })).rejects.toMatchObject({
      code: 'profile_busy',
      reason: 'chrome',
      status: 409,
    });
    expect(JSON.parse(await readFile(browser.leaseFile, 'utf8'))).toMatchObject({ chromePid: 77_777 });
  });

  test('refuses a live local SingletonLock and only cleans stale lock material while leased', async () => {
    const browser = await profile({ isProcessAlive: pid => pid === 44 });
    const initial = await browser.acquire({ sessionId: 'first' });
    await initial.release();
    await symlink('test-host-44', path.join(browser.profile, 'SingletonLock'));
    await expect(browser.acquire({ sessionId: 'first' })).rejects.toMatchObject({ code: 'profile_busy', status: 409 });

    const stale = await profile({ isProcessAlive: () => false });
    await stale.acquire({ sessionId: 'first' });
    await symlink('test-host-55', path.join(stale.profile, 'SingletonLock'));
    await Promise.all(
      ['SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'].map(name =>
        writeFile(path.join(stale.profile, name), 'stale'),
      ),
    );
    const held = await stale.acquire({ sessionId: 'first' });
    expect(await held.cleanupStaleChromeLocks()).toEqual([
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie',
      'DevToolsActivePort',
    ]);
    await expect(lstat(path.join(stale.profile, 'SingletonLock'))).rejects.toThrow();
  });

  test('never removes Chrome lock material without an explicit proof that its owner died', async () => {
    const browser = await profile();
    const lease = await browser.acquire({ sessionId: 'first' });
    const devTools = path.join(lease.profile, 'DevToolsActivePort');
    await writeFile(devTools, 'not proven stale');
    expect(await lease.cleanupStaleChromeLocks()).toEqual([]);
    expect(await readFile(devTools, 'utf8')).toBe('not proven stale');
  });

  test('writes an explicit primed marker and records profile Chrome versions without inferring sign-in', async () => {
    const browser = await profile();
    const lease = await browser.acquire({ sessionId: 'first', chromeVersion: 'Chrome 150.0.1.0' });
    expect(await browser.isPrimed()).toBe(false);
    await lease.markPrimed('Chrome 151.2.3.4');
    expect(await browser.isPrimed()).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(browser.browserDirectory, 'profile.metadata.json'), 'utf8')),
    ).toMatchObject({
      createdChromeVersion: 'Chrome 150.0.1.0',
      primedChromeVersion: 'Chrome 151.2.3.4',
      latestChromeVersion: 'Chrome 151.2.3.4',
    });
  });

  test('does not trust malformed or incomplete primed markers', async () => {
    const browser = await profile();
    const lease = await browser.acquire({ sessionId: 'first' });
    const marker = path.join(browser.browserDirectory, 'profile.primed.json');
    for (const value of [{}, null, { version: 150 }, { version: 'Chrome 150', primedAt: 'not-a-date' }]) {
      await writeFile(marker, `${JSON.stringify(value)}\n`);
      expect(await browser.isPrimed()).toBe(false);
    }
    await lease.markPrimed('Chrome 150.0.1.0');
    expect(await browser.isPrimed()).toBe(true);
  });

  test('compares Chrome majors and refuses a downgrade before Chrome can alter the profile', async () => {
    expect(compareChromeVersions('Chrome 149.0.1.0', 'Chrome 150.0.1.0')).toBe(-1);
    expect(compareChromeVersions('Chrome 150.2.0.0', 'Chrome 150.0.1.0')).toBe(0);
    expect(compareChromeVersions('Chrome 151.0.0.0', 'Chrome 150.0.1.0')).toBe(1);
    expect(compareChromeVersions('unknown', 'Chrome 150.0.1.0')).toBeUndefined();
    const browser = await profile();
    const lease = await browser.acquire({ sessionId: 'first', chromeVersion: 'Chrome 150.0.1.0' });
    await expect(browser.assertChromeVersionCompatible('Chrome 149.0.1.0')).rejects.toMatchObject({
      code: 'launch_failed',
      status: 409,
    } satisfies Partial<BrowserError>);
    await expect(browser.assertChromeVersionCompatible('Chrome 150.0.1.0')).resolves.toBeUndefined();
    await lease.markPrimed('Chrome 151.0.1.0');
    await expect(browser.assertChromeVersionCompatible('Chrome 150.0.1.0')).rejects.toMatchObject({
      code: 'launch_failed',
      status: 409,
    });
    await lease.updateChromePid(42_424, 'Chrome 152.0.1.0');
    await expect(browser.assertChromeVersionCompatible('Chrome 151.0.1.0')).rejects.toMatchObject({
      code: 'launch_failed',
      status: 409,
    });
  });

  test('constructs from KTeam paths without touching session directories', () => {
    const browser = createBrowserProfile({ daemon: '/tmp/kteam/daemon' });
    expect(browser.profile).toBe('/tmp/kteam/daemon/browser/profile');
  });
});
