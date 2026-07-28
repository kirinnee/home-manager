import { describe, expect, test } from 'bun:test';
import { createPaths } from './paths';
import { BrowserService, type BrowserServiceClock, type ManagedBrowserRuntime } from './browser-service';
import type { BrowserInputEvent, BrowserScreencastFrame, BrowserViewport } from './browser-types';

class FakeClock implements BrowserServiceClock {
  value = 1_000_000;
  callback: (() => void) | undefined;
  now = () => this.value;
  setInterval = (callback: () => void) => {
    this.callback = callback;
    return 1;
  };
  clearInterval = () => {
    this.callback = undefined;
  };
}

class FakeRuntime implements ManagedBrowserRuntime {
  viewport: BrowserViewport = { width: 1280, height: 800 };
  closed = 0;
  calls: string[] = [];
  private failRuntime!: (failure: { component: 'chrome' | 'playwright'; code: number }) => void;
  unexpectedExit = new Promise<{ component: 'chrome' | 'playwright'; code: number }>(resolve => {
    this.failRuntime = resolve;
  });
  resize = async (viewport: BrowserViewport) => {
    this.viewport = viewport;
    this.calls.push(`resize:${viewport.width}x${viewport.height}`);
  };
  navigate = async (url: string) => {
    this.calls.push(`navigate:${url}`);
    return { url, title: 'page' };
  };
  click = async (selector: string) => {
    this.calls.push(`click:${selector}`);
    return { url: 'https://example.test/', title: 'page' };
  };
  type = async (selector: string, text: string) => {
    this.calls.push(`type:${selector}:${text}`);
    return { url: 'https://example.test/', title: 'page' };
  };
  read = async (selector?: string) => {
    this.calls.push(`read:${selector ?? 'body'}`);
    return { url: 'https://example.test/', title: 'page', text: 'body' };
  };
  screenshot = async () => ({ url: 'https://example.test/', title: 'page', screenshotBase64: 'cG5n' });
  back = async () => ({ url: 'https://example.test/old', title: 'old' });
  forward = async () => {
    this.calls.push('forward');
    return { url: 'https://example.test/new', title: 'new' };
  };
  reload = async () => {
    this.calls.push('reload');
    return { url: 'https://example.test/reloaded', title: 'reloaded' };
  };
  location = async () => ({ url: 'about:blank', title: '' });
  startScreencast = async (_listener: (frame: BrowserScreencastFrame) => void) => {};
  stopScreencast = async () => {};
  dispatchInput = async (_input: BrowserInputEvent) => {};
  close = async () => {
    this.closed += 1;
  };
  fail(component: 'chrome' | 'playwright', code = 1) {
    this.failRuntime({ component, code });
  }
}

function harness(maximumInstances = 3, idleTimeoutMs = 1_000) {
  const clock = new FakeClock();
  const runtimes = new Map<string, FakeRuntime>();
  const roots = new Map<string, string>();
  const aliases = new Map([
    ['one', 's1'],
    ['two', 's2'],
    ['three', 's3'],
  ]);
  const service = new BrowserService(
    createPaths('/tmp/kteam-browser-service-test'),
    { resolve: async ref => aliases.get(ref) ?? (['s1', 's2', 's3'].includes(ref) ? ref : undefined) },
    {
      maximumInstances,
      idleTimeoutMs,
      clock,
      runtimeFactory: async (id, root) => {
        const runtime = new FakeRuntime();
        runtimes.set(id, runtime);
        roots.set(id, root);
        return runtime;
      },
    },
  );
  return { service, clock, runtimes, roots };
}

describe('browser lifecycle', () => {
  test('one runtime per canonical session, persistent root, and a hard fleet cap', async () => {
    const { service, runtimes, roots } = harness(2);
    await service.start('one', 'agent');
    await service.start('s1', 'agent');
    expect(runtimes.size).toBe(1);
    expect(roots.get('s1')).toEndWith('/s1/browser');
    await service.start('s2', 'human');
    await expect(service.start('s3', 'agent')).rejects.toMatchObject({ code: 'capacity', status: 429 });
    await service.close();
  });

  test('viewer detach never stops Chrome; no-viewer idle expiry does', async () => {
    const { service, clock, runtimes } = harness(3, 1_000);
    await service.start('s1', 'agent');
    const viewer = await service.attachViewer('s1', () => undefined);
    clock.value += 5_000;
    expect(await service.sweepIdle()).toBe(0);
    expect(runtimes.get('s1')?.closed).toBe(0);
    viewer.detach();
    clock.value += 999;
    expect(await service.sweepIdle()).toBe(0);
    clock.value += 1;
    expect(await service.sweepIdle()).toBe(1);
    expect(runtimes.get('s1')?.closed).toBe(1);
    await service.close();
  });

  test('explicit stop keeps the profile contract but closes processes', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    const stopped = await service.stop('s1', 'human');
    expect(stopped.state).toBe('stopped');
    expect(stopped.persistentProfile).toBe(true);
    expect(runtimes.get('s1')?.closed).toBe(1);
    await service.close();
  });

  test('unexpected child death frees capacity, closes siblings, and reports a coarse failure', async () => {
    const { service, runtimes } = harness(1);
    await service.start('s1', 'agent');
    const terminals: Array<{ code: number; reason: string }> = [];
    await service.attachViewer(
      's1',
      () => undefined,
      terminal => terminals.push(terminal),
    );
    runtimes.get('s1')?.fail('chrome', 17);
    await Bun.sleep(0);
    const failed = await service.status('s1');
    expect(failed).toMatchObject({ state: 'error', capacity: { running: 0, maximum: 1 } });
    expect(failed.error).toContain('chrome process exited unexpectedly (code 17)');
    expect(runtimes.get('s1')?.closed).toBe(1);
    expect(terminals).toEqual([{ code: 1011, reason: 'remote browser exited' }]);
    await service.start('s2', 'agent');
    await service.close();
  });

  test('shutdown during session resolution prevents a late runtime launch', async () => {
    let release!: (value: string) => void;
    const resolution = new Promise<string>(resolve => {
      release = resolve;
    });
    let launches = 0;
    const service = new BrowserService(
      createPaths('/tmp/kteam-browser-service-race-test'),
      { resolve: async () => await resolution },
      {
        runtimeFactory: async () => {
          launches += 1;
          return new FakeRuntime();
        },
      },
    );
    const start = service.start('one', 'agent');
    await Bun.sleep(0);
    await service.close();
    release('s1');
    await expect(start).rejects.toMatchObject({ code: 'not_running', status: 503 });
    expect(launches).toBe(0);
  });

  test('rejects an unsafe canonical id returned by alias resolution', async () => {
    const service = new BrowserService(
      createPaths('/tmp/kteam-browser-service-path-test'),
      { resolve: async () => '../escape' },
      { runtimeFactory: async () => new FakeRuntime() },
    );
    await expect(service.start('alias', 'agent')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await service.close();
  });
});

describe('shared Playwright actions', () => {
  test('agent verbs and human activity update provenance without arbitration', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'agent');
    const clicked = await service.act('s1', { action: 'click', selector: '#continue' }, 'agent');
    expect(clicked.status.lastActor).toMatchObject({ kind: 'agent', action: 'click' });
    expect(runtimes.get('s1')?.calls).toContain('click:#continue');
    const human = await service.noteHumanActivity('s1', 'keyboard');
    expect(human.lastActor).toMatchObject({ kind: 'human', action: 'keyboard' });
    await service.act('s1', { action: 'type', selector: '#password', text: 'secret' }, 'agent');
    expect(runtimes.get('s1')?.calls).toContain('type:#password:secret');
    await service.close();
  });

  test('open starts and navigates atomically while forward and reload reuse the same runtime', async () => {
    const { service, runtimes } = harness();
    const opened = await service.act('s1', { action: 'open', url: 'example.test/login' }, 'human');
    expect(opened.status.state).toBe('running');
    expect(runtimes.get('s1')?.calls).toContain('navigate:example.test/login');
    const forwarded = await service.act('s1', { action: 'forward' }, 'human');
    expect(forwarded.status.lastActor).toMatchObject({ kind: 'human', action: 'forward' });
    const reloaded = await service.act('s1', { action: 'reload' }, 'human');
    expect(reloaded.status.lastActor).toMatchObject({ kind: 'human', action: 'reload' });
    expect(runtimes.get('s1')?.calls).toEqual(['navigate:example.test/login', 'forward', 'reload']);
    await service.close();
  });

  test('resize is bounded before reaching CDP', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    const resized = await service.act('s1', { action: 'resize', width: 100, height: 5_000 }, 'human');
    expect(resized.status.viewport).toEqual({ width: 320, height: 1_200 });
    expect(runtimes.get('s1')?.calls).toContain('resize:320x1200');
    await service.close();
  });

  test('status samples the shared page identity without extending idle activity', async () => {
    const { service, clock } = harness();
    await service.start('s1', 'agent');
    clock.value += 500;
    const status = await service.status('s1');
    expect(status).toMatchObject({ url: 'about:blank', title: '' });
    clock.value += 500;
    expect(await service.sweepIdle()).toBe(1);
    await service.close();
  });
});
