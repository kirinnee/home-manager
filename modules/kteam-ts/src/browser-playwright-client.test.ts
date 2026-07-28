import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { PlaywrightWorkerClient } from './browser-playwright-client';

const fixture = path.join(import.meta.dir, 'fixtures', 'browser-playwright-client-worker.mjs');

describe('Playwright Node worker client', () => {
  test('waits for readiness and carries typed commands over JSON lines', async () => {
    const client = await PlaywrightWorkerClient.connect('echo', fixture);
    await client.resize({ width: 900, height: 700 });
    expect(await client.location()).toEqual({ url: 'https://fixture.test/', title: '900x700' });
    expect(await client.read()).toMatchObject({ text: 'fixture text' });
    expect(await client.forward()).toEqual({ url: 'https://fixture.test/', title: '900x700' });
    expect(await client.reload()).toEqual({ url: 'https://fixture.test/', title: '900x700' });
    await client.close();
  });

  test('surfaces a bounded startup failure from the worker', async () => {
    await expect(PlaywrightWorkerClient.connect('fatal', fixture)).rejects.toMatchObject({
      code: 'launch_failed',
      status: 503,
    });
  });

  test('does not wait for the full readiness timeout when a worker exits cleanly before ready', async () => {
    const started = performance.now();
    await expect(PlaywrightWorkerClient.connect('exit-before-ready', fixture)).rejects.toMatchObject({
      code: 'launch_failed',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('reports an unexpected post-ready worker exit and refuses later writes', async () => {
    const client = await PlaywrightWorkerClient.connect('exit-after-ready', fixture);
    expect(await client.unexpectedExit).toBe(23);
    await expect(client.location()).rejects.toMatchObject({ code: 'not_running', status: 409 });
  });

  test('isolates a throwing frame listener so later listeners and responses continue', async () => {
    const client = await PlaywrightWorkerClient.connect('frames', fixture);
    let healthyFrames = 0;
    await client.startScreencast({ width: 1280, height: 800 }, () => {
      throw new Error('viewer failed');
    });
    await client.startScreencast({ width: 1280, height: 800 }, () => {
      healthyFrames += 1;
    });
    await expect(client.location()).resolves.toEqual({ url: 'https://fixture.test/', title: '1280x800' });
    expect(healthyFrames).toBe(1);
    await client.close();
  });
});
