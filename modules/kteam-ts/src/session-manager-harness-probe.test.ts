import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './session-manager';

type Loose = Record<string, any>;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function startHarness(mode: 'auto' | 'interactive') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kteam-start-probe-test-'));
  temporaryDirectories.push(root);
  const binary = 'claude-auto-test';
  const wrapper = path.join(root, binary);
  await writeFile(wrapper, '#!/bin/sh\nexport CLAUDE_CONFIG_DIR="$HOME/.claude-auto-test"\n');
  await chmod(wrapper, 0o755);

  const manager = Object.create(SessionManager.prototype) as Loose;
  manager.paths = { home: root, sessions: root, daemon: root, kfleetBin: root };
  manager.options = { remoteControl: false };
  manager.store = { listSessions: () => [] };
  manager.list = async () => [];

  return {
    manager,
    binary,
    request: { prompt: 'do work', agent: binary, cwd: root, mode },
  };
}

describe('SessionManager autonomous harness preflight', () => {
  test('rejects a failed probe with wrapper and reason before quota or persistence work', async () => {
    const { manager, binary, request } = await startHarness('auto');
    let quotaCalls = 0;
    manager.probeHarness = async () => ({
      binary,
      up: false,
      cached: false,
      ms: 12,
      checkedAt: '2026-07-30T20:00:00.000Z',
      failureKind: 'rate_limited',
      error: 'rate/quota limited: HTTP 429',
    });
    manager.fetchQuota = async () => {
      quotaCalls += 1;
      throw new Error('quota should not run');
    };

    await expect(manager.start(request)).rejects.toThrow(
      'wrapper claude-auto-test is unavailable for autonomous work: harness probe failed (rate_limited): rate/quota limited: HTTP 429; harness process was not spawned',
    );
    expect(quotaCalls).toBe(0);
  });

  test('gates auto resumes, retries, and migrations at their shared launch seam', async () => {
    const { manager, binary } = await startHarness('auto');
    let launches = 0;
    manager.probeHarness = async () => ({
      binary,
      up: false,
      cached: false,
      ms: 5,
      checkedAt: '2026-07-30T20:00:00.000Z',
      failureKind: 'authentication',
      error: 'authentication failed: token expired',
    });
    manager.tmux = { launch: async () => void launches++ };

    await expect(
      manager.launchWithRetry({
        id: 'existing-session',
        binary,
        harness: 'claude',
        mode: 'auto',
        tmuxSession: 'kteam-existing-session-agent',
      }),
    ).rejects.toThrow('authentication failed: token expired');
    expect(launches).toBe(0);
  });

  test('continues past a successful auto probe', async () => {
    const { manager, binary, request } = await startHarness('auto');
    let probeCalls = 0;
    manager.probeHarness = async () => {
      probeCalls += 1;
      return {
        binary,
        up: true,
        cached: false,
        ms: 8,
        checkedAt: '2026-07-30T20:00:00.000Z',
      };
    };
    manager.fetchQuota = async () => {
      throw new Error('reached quota preflight');
    };

    await expect(manager.start(request)).rejects.toThrow('reached quota preflight');
    expect(probeCalls).toBe(1);
  });

  test('leaves interactive starts unprobed', async () => {
    const { manager, request } = await startHarness('interactive');
    let probeCalls = 0;
    manager.probeHarness = async () => {
      probeCalls += 1;
      throw new Error('interactive mode must not probe');
    };
    manager.fetchQuota = async () => {
      throw new Error('reached quota preflight');
    };

    await expect(manager.start(request)).rejects.toThrow('reached quota preflight');
    expect(probeCalls).toBe(0);
  });
});
