import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from './paths';
import { defaultWardenConfig, loadDaemonConfig } from './daemon-config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function pathsWithConfig(config: unknown) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kteam-daemon-config-'));
  temporaryDirectories.push(home);
  const paths = createPaths(home);
  await mkdir(paths.daemon, { recursive: true, mode: 0o700 });
  if (config !== undefined) await writeFile(paths.daemonConfig, JSON.stringify(config));
  return paths;
}

describe('warden config merge (failover fields)', () => {
  test('an OLD config file with only a wrapper loads unchanged and gains failover defaults', async () => {
    const paths = await pathsWithConfig({ warden: { enabled: true, wrapper: 'claude-auto-old' } });
    const config = await loadDaemonConfig(paths);
    expect(config.warden.wrapper).toBe('claude-auto-old');
    expect(config.warden.enabled).toBe(true);
    expect(config.warden.accounts).toBeUndefined();
    expect(config.warden.failover).toEqual({ policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 });
    // The legacy model field stays absent — never resurrected by defaults.
    expect(config.warden.model).toBeUndefined();
  });

  test('a partial failover block deep-merges with its defaults', async () => {
    const paths = await pathsWithConfig({
      warden: { accounts: ['claude-auto-a', 'claude-auto-b'], failover: { policy: 'round_robin' } },
    });
    const config = await loadDaemonConfig(paths);
    expect(config.warden.accounts).toEqual(['claude-auto-a', 'claude-auto-b']);
    expect(config.warden.failover).toEqual({ policy: 'round_robin', failureThreshold: 2, cooldownMinutes: 30 });
  });

  test('accounts survive the merge with per-account model overrides intact', async () => {
    const paths = await pathsWithConfig({
      warden: { accounts: [{ wrapper: 'claude-auto-a', model: 'opus' }, 'claude-auto-b'] },
    });
    const config = await loadDaemonConfig(paths);
    expect(config.warden.accounts).toEqual([{ wrapper: 'claude-auto-a', model: 'opus' }, 'claude-auto-b']);
  });

  test('defaults ship fallback failover and NO model field', async () => {
    const warden = defaultWardenConfig();
    expect(warden.failover).toEqual({ policy: 'fallback', failureThreshold: 2, cooldownMinutes: 30 });
    expect(warden.model).toBeUndefined();
    expect(warden.accounts).toBeUndefined();
  });
});
