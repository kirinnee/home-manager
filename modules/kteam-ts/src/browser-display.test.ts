import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserDisplayService, type BrowserDisplayChild, type SpawnXvfb } from './browser-display';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeChild(pid = 7001): {
  child: BrowserDisplayChild;
  exit: (code: number) => void;
  signals: Array<NodeJS.Signals | number | undefined>;
} {
  const exited = deferred<number>();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  return {
    child: {
      pid,
      exited: exited.promise,
      kill: signal => {
        signals.push(signal);
        exited.resolve(0);
      },
    },
    exit: exited.resolve,
    signals,
  };
}

describe('BrowserDisplayService', () => {
  test('coalesces concurrent Linux starts and exposes one explicit display', async () => {
    const socketDirectory = await mkdtemp(path.join(tmpdir(), 'kteam-xvfb-test-'));
    const process = fakeChild();
    const argv: string[][] = [];
    const spawn: SpawnXvfb = command => {
      argv.push(command);
      queueMicrotask(() => void writeFile(path.join(socketDirectory, 'X101'), 'ready'));
      return process.child;
    };
    const service = new BrowserDisplayService({
      platform: 'linux',
      which: command => (command === 'Xvfb' ? '/nix/store/bin/Xvfb' : undefined),
      spawn,
      socketDirectory,
      firstDisplay: 101,
      lastDisplay: 101,
      pollIntervalMs: 1,
    });

    try {
      const [first, second] = await Promise.all([service.start(), service.start()]);
      expect(first).toBe(second);
      expect(first.display).toBe(':101');
      expect(argv).toEqual([['/nix/store/bin/Xvfb', ':101', '-screen', '0', '1920x1280x24', '-nolisten', 'tcp']]);
      await Promise.all([service.close(), service.close(), first.close()]);
      expect(process.signals).toEqual(['SIGTERM']);
    } finally {
      await rm(socketDirectory, { recursive: true, force: true });
    }
  });

  test('fails specifically when Xvfb exits before creating its socket', async () => {
    const socketDirectory = await mkdtemp(path.join(tmpdir(), 'kteam-xvfb-test-'));
    const process = fakeChild();
    process.exit(1);
    const service = new BrowserDisplayService({
      platform: 'linux',
      which: () => '/fake/Xvfb',
      spawn: () => process.child,
      socketDirectory,
      firstDisplay: 102,
      lastDisplay: 102,
      pollIntervalMs: 1,
    });

    try {
      await expect(service.start()).rejects.toMatchObject({ code: 'launch_failed', status: 503 });
      expect(process.signals).toEqual([]);
    } finally {
      await rm(socketDirectory, { recursive: true, force: true });
    }
  });

  test('returns a bounded 503 and terminates only its own child on readiness timeout', async () => {
    const socketDirectory = await mkdtemp(path.join(tmpdir(), 'kteam-xvfb-test-'));
    const process = fakeChild();
    const service = new BrowserDisplayService({
      platform: 'linux',
      which: () => '/fake/Xvfb',
      spawn: () => process.child,
      socketDirectory,
      firstDisplay: 103,
      lastDisplay: 103,
      readyTimeoutMs: 20,
      pollIntervalMs: 1,
    });

    try {
      const startedAt = Date.now();
      await expect(service.start()).rejects.toMatchObject({ code: 'launch_failed', status: 503 });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(process.signals).toEqual(['SIGTERM']);
    } finally {
      await rm(socketDirectory, { recursive: true, force: true });
    }
  });

  test('fails closed when Xvfb cannot be resolved', async () => {
    const service = new BrowserDisplayService({
      platform: 'linux',
      which: () => undefined,
      spawn: () => {
        throw new Error('must not spawn without an executable');
      },
    });
    await expect(service.start()).rejects.toMatchObject({ code: 'launch_failed', status: 503 });
  });

  test('forgets an Xvfb that crashes after readiness and recreates it on the next start', async () => {
    let socketReady = false;
    const processes = [fakeChild(7101), fakeChild(7102)];
    let spawns = 0;
    const service = new BrowserDisplayService({
      platform: 'linux',
      which: () => '/fake/Xvfb',
      spawn: () => {
        const process = processes[spawns++]!;
        queueMicrotask(() => {
          socketReady = true;
        });
        return process.child;
      },
      socketExists: () => socketReady,
      firstDisplay: 104,
      lastDisplay: 104,
      pollIntervalMs: 1,
    });

    const first = await service.start();
    expect(first.display).toBe(':104');
    socketReady = false;
    processes[0]!.exit(1);
    await Bun.sleep(0);

    const second = await service.start();
    expect(second).not.toBe(first);
    expect(second.display).toBe(':104');
    expect(spawns).toBe(2);
    await service.close();
  });

  test('uses no Xvfb on non-Linux platforms', async () => {
    const service = new BrowserDisplayService({
      platform: 'darwin',
      spawn: () => {
        throw new Error('must not spawn Xvfb');
      },
    });
    const display = await service.start();
    expect(display.display).toBeUndefined();
    await display.close();
  });
});
