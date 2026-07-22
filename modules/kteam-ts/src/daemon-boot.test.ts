import { describe, expect, test } from 'bun:test';
import { bindWithRetry, probeExistingDaemon } from './daemon-boot';

const addressInUse = () =>
  Object.assign(new Error('Failed to start server. Is port 7337 in use?'), {
    code: 'EADDRINUSE',
  });

describe('probeExistingDaemon', () => {
  test('any HTTP response means a live daemon holds the port', async () => {
    const healthy = await probeExistingDaemon({
      url: 'http://127.0.0.1:7337',
      token: 'secret',
      fetcher: async () => Response.json({ ok: true }),
    });
    expect(healthy).toBe(true);
    // Even an unauthorized answer proves something is listening.
    const unauthorized = await probeExistingDaemon({
      url: 'http://127.0.0.1:7337',
      fetcher: async () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    });
    expect(unauthorized).toBe(true);
  });

  test('a connection failure means the port is free', async () => {
    const result = await probeExistingDaemon({
      url: 'http://127.0.0.1:7337',
      fetcher: async () => {
        throw new Error('Unable to connect');
      },
    });
    expect(result).toBe(false);
  });

  test('sends the bearer token and hits /v1/health without a double slash', async () => {
    let seenUrl = '';
    let seenAuth: string | undefined;
    await probeExistingDaemon({
      url: 'http://127.0.0.1:7337/',
      token: 'secret',
      fetcher: async (url: string | URL | Request, init?: RequestInit) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>).authorization;
        return Response.json({ ok: true });
      },
    });
    expect(seenUrl).toBe('http://127.0.0.1:7337/v1/health');
    expect(seenAuth).toBe('Bearer secret');
  });
});

describe('bindWithRetry', () => {
  test('returns the first successful bind without sleeping', async () => {
    const sleeps: number[] = [];
    const server = await bindWithRetry(() => 'server', { sleep: async ms => void sleeps.push(ms) });
    expect(server).toBe('server');
    expect(sleeps).toEqual([]);
  });

  test('retries EADDRINUSE with backoff until the port frees up', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const server = await bindWithRetry(
      () => {
        attempts++;
        if (attempts < 4) throw addressInUse();
        return 'server';
      },
      { backoffMs: 500, totalMs: 30_000, sleep: async ms => void sleeps.push(ms) },
    );
    expect(server).toBe('server');
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([500, 500, 500]);
  });

  test('gives up after the total deadline and rethrows EADDRINUSE', async () => {
    let clock = 0;
    let attempts = 0;
    await expect(
      bindWithRetry(
        () => {
          attempts++;
          throw addressInUse();
        },
        {
          backoffMs: 500,
          totalMs: 2_000,
          clock: () => clock,
          sleep: async ms => void (clock += ms),
        },
      ),
    ).rejects.toThrow(/port 7337 in use/);
    // 2000ms budget / 500ms backoff → the initial try plus 4 retries.
    expect(attempts).toBe(5);
  });

  test('rethrows non-EADDRINUSE errors immediately', async () => {
    let attempts = 0;
    await expect(
      bindWithRetry(
        () => {
          attempts++;
          throw new Error('permission denied');
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow('permission denied');
    expect(attempts).toBe(1);
  });

  test('recognizes EADDRINUSE from the message when no code is set', async () => {
    let attempts = 0;
    const server = await bindWithRetry(
      () => {
        attempts++;
        if (attempts === 1) throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:7337');
        return 'server';
      },
      { sleep: async () => undefined },
    );
    expect(server).toBe('server');
    expect(attempts).toBe(2);
  });
});
