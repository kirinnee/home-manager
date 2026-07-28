import { describe, expect, test } from 'bun:test';
import { createPaths } from './paths';
import { BrowserService, type BrowserServiceClock, type ManagedBrowserRuntime } from './browser-service';
import {
  BrowserError,
  type BrowserInputEvent,
  type BrowserPageActionSnapshot,
  type BrowserPageSnapshot,
  type BrowserScreencastFrame,
  type BrowserViewport,
} from './browser-types';

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
  inputs: BrowserInputEvent[] = [];
  locationCalls = 0;
  screencastStarts = 0;
  screencastStops = 0;
  private pages = [{ id: 'page-1', url: 'about:blank', title: '' }];
  private activePageId = 'page-1';
  private pageState: BrowserPageSnapshot['pageState'] = 'ready';
  private pageError: string | undefined;
  private canGoBack = false;
  private canGoForward = false;
  private pageSerial = 1;
  private nextClickActedPageId: string | undefined;
  private malformedNextAction = false;
  private malformedNextLocation = false;
  private rejectNextScreencastStart = false;
  private nextNavigation:
    | { gate: Promise<void>; release(): void; started: Promise<void>; markStarted(): void }
    | undefined;
  private nextLocation:
    | { gate: Promise<void>; release(): void; started: Promise<void>; markStarted(): void }
    | undefined;
  private failRuntime!: (failure: { component: 'chrome' | 'playwright'; code: number }) => void;
  unexpectedExit = new Promise<{ component: 'chrome' | 'playwright'; code: number }>(resolve => {
    this.failRuntime = resolve;
  });

  private currentPage() {
    const page = this.pages.find(item => item.id === this.activePageId);
    if (!page) throw new Error('the fake active page disappeared');
    return page;
  }

  private snapshot(extra: Record<string, unknown> = {}): BrowserPageSnapshot {
    const page = this.currentPage();
    return {
      url: page.url,
      title: page.title,
      pages: this.pages.map(item => ({ ...item })),
      activePageId: page.id,
      pageState: this.pageState,
      ...(this.pageError ? { pageError: this.pageError } : {}),
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      ...extra,
    } as BrowserPageSnapshot;
  }

  private actionSnapshot(actedPageId: string, extra: Record<string, unknown> = {}): BrowserPageActionSnapshot {
    const snapshot = { ...this.snapshot(extra), actedPageId };
    if (!this.malformedNextAction) return snapshot;
    this.malformedNextAction = false;
    return { ...snapshot, activePageId: 'missing-page' };
  }

  pauseNextNavigation(): { release(): void; started: Promise<void> } {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    this.nextNavigation = { gate, release, started, markStarted };
    return { release, started };
  }

  pauseNextLocation(): { release(): void; started: Promise<void> } {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    this.nextLocation = { gate, release, started, markStarted };
    return { release, started };
  }

  setActivePageState(
    pageState: BrowserPageSnapshot['pageState'],
    options: { pageError?: string; canGoBack?: boolean; canGoForward?: boolean } = {},
  ): void {
    this.pageState = pageState;
    this.pageError = options.pageError;
    if (options.canGoBack !== undefined) this.canGoBack = options.canGoBack;
    if (options.canGoForward !== undefined) this.canGoForward = options.canGoForward;
  }

  setActivePageIdentity(url: string, title: string): void {
    const page = this.currentPage();
    page.url = url;
    page.title = title;
  }

  returnMalformedNextAction(): void {
    this.malformedNextAction = true;
  }

  returnMalformedNextLocation(): void {
    this.malformedNextLocation = true;
  }

  failNextScreencastStart(): void {
    this.rejectNextScreencastStart = true;
  }

  setNextClickActedPageId(pageId: string): void {
    this.nextClickActedPageId = pageId;
  }

  private async settleNavigation(): Promise<void> {
    const pending = this.nextNavigation;
    this.nextNavigation = undefined;
    if (!pending) return;
    pending.markStarted();
    await pending.gate;
  }

  private async settleLocation(): Promise<void> {
    const pending = this.nextLocation;
    this.nextLocation = undefined;
    if (!pending) return;
    pending.markStarted();
    await pending.gate;
  }

  private createPage(url = 'about:blank', title = ''): string {
    this.pageSerial += 1;
    const id = `page-${this.pageSerial}`;
    this.pages.push({ id, url, title });
    this.activePageId = id;
    return id;
  }

  resize = async (viewport: BrowserViewport) => {
    this.viewport = viewport;
    this.calls.push(`resize:${viewport.width}x${viewport.height}`);
    return this.actionSnapshot(this.activePageId);
  };
  navigate = async (url: string) => {
    const actedPageId = this.activePageId;
    this.calls.push(`navigate:${url}`);
    this.pageState = 'loading';
    this.pageError = undefined;
    await this.settleNavigation();
    const page = this.currentPage();
    page.url = url;
    page.title = 'page';
    this.pageState = 'ready';
    this.canGoBack = true;
    this.canGoForward = false;
    return this.actionSnapshot(actedPageId);
  };
  click = async (selector: string) => {
    const actedPageId = this.nextClickActedPageId ?? this.activePageId;
    this.nextClickActedPageId = undefined;
    this.calls.push(`click:${selector}`);
    if (selector === '#popup') {
      this.createPage('https://popup.test/', 'popup');
      this.pageState = 'ready';
      return this.actionSnapshot(actedPageId);
    }
    const page = this.currentPage();
    page.url = 'https://example.test/';
    page.title = 'page';
    return this.actionSnapshot(actedPageId);
  };
  type = async (selector: string, text: string) => {
    const actedPageId = this.activePageId;
    this.calls.push(`type:${selector}:${text}`);
    return this.actionSnapshot(actedPageId);
  };
  read = async (selector?: string) => {
    const actedPageId = this.activePageId;
    this.calls.push(`read:${selector ?? 'body'}`);
    return { ...this.actionSnapshot(actedPageId), text: 'body' };
  };
  screenshot = async () => ({ ...this.actionSnapshot(this.activePageId), screenshotBase64: 'cG5n' });
  back = async () => {
    const actedPageId = this.activePageId;
    this.calls.push('back');
    const page = this.currentPage();
    page.url = 'https://example.test/old';
    page.title = 'old';
    this.pageState = 'ready';
    this.pageError = undefined;
    this.canGoBack = false;
    this.canGoForward = true;
    return this.actionSnapshot(actedPageId);
  };
  forward = async () => {
    const actedPageId = this.activePageId;
    this.calls.push('forward');
    const page = this.currentPage();
    page.url = 'https://example.test/new';
    page.title = 'new';
    this.pageState = 'ready';
    this.canGoBack = true;
    this.canGoForward = false;
    return this.actionSnapshot(actedPageId);
  };
  reload = async () => {
    const actedPageId = this.activePageId;
    this.calls.push('reload');
    const page = this.currentPage();
    page.url = 'https://example.test/reloaded';
    page.title = 'reloaded';
    this.pageState = 'ready';
    this.pageError = undefined;
    return this.actionSnapshot(actedPageId);
  };
  newPage = async (url?: string) => {
    this.calls.push(`new-page:${url ?? 'about:blank'}`);
    const actedPageId = this.createPage(url ?? 'about:blank', url ? 'new page' : '');
    this.pageState = 'ready';
    this.pageError = undefined;
    this.canGoBack = false;
    this.canGoForward = false;
    return this.actionSnapshot(actedPageId);
  };
  activatePage = async (pageId: string) => {
    this.calls.push(`activate-page:${pageId}`);
    if (!this.pages.some(page => page.id === pageId)) {
      throw new BrowserError('upstream_failed', 'that page is no longer open', 502);
    }
    this.activePageId = pageId;
    return this.actionSnapshot(pageId);
  };
  closePage = async (pageId: string) => {
    this.calls.push(`close-page:${pageId}`);
    const index = this.pages.findIndex(page => page.id === pageId);
    if (index < 0) throw new BrowserError('upstream_failed', 'that page is no longer open', 502);
    const wasActive = this.activePageId === pageId;
    this.pages.splice(index, 1);
    if (this.pages.length === 0) this.createPage();
    else if (wasActive) this.activePageId = this.pages[Math.min(index, this.pages.length - 1)]!.id;
    this.pageState = 'ready';
    this.pageError = undefined;
    return this.actionSnapshot(pageId);
  };
  location = async () => {
    this.locationCalls += 1;
    await this.settleLocation();
    const snapshot = this.snapshot();
    if (!this.malformedNextLocation) return snapshot;
    this.malformedNextLocation = false;
    return { ...snapshot, activePageId: 'missing-page' };
  };
  startScreencast = async (_listener: (frame: BrowserScreencastFrame) => void) => {
    this.screencastStarts += 1;
    if (!this.rejectNextScreencastStart) return;
    this.rejectNextScreencastStart = false;
    throw new Error('fixture screencast start failed');
  };
  stopScreencast = async () => {
    this.screencastStops += 1;
  };
  dispatchInput = async (input: BrowserInputEvent) => {
    this.inputs.push(input);
  };
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
    const first = await service.start('one', 'agent');
    expect(first.capacity).toEqual({ running: 1, maximum: 2 });
    const same = await service.start('s1', 'agent');
    expect(same.capacity).toEqual({ running: 1, maximum: 2 });
    expect(runtimes.size).toBe(1);
    expect(roots.get('s1')).toEndWith('/s1/browser');
    const second = await service.start('s2', 'human');
    expect(second.capacity).toEqual({ running: 2, maximum: 2 });
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

  test('failed screencast startup is defensively stopped when no viewers remain', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'agent');
    const runtime = runtimes.get('s1')!;
    runtime.failNextScreencastStart();

    await expect(service.attachViewer('s1', () => undefined)).rejects.toThrow('fixture screencast start failed');
    expect(runtime.screencastStarts).toBe(1);
    expect(runtime.screencastStops).toBe(1);
    expect((await service.status('s1')).viewers).toBe(0);
    await service.close();
  });

  test('explicit stop keeps the profile contract but closes processes', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    const stopped = await service.stop('s1', 'human');
    expect(stopped.state).toBe('stopped');
    expect(stopped.persistentProfile).toBe(true);
    expect(stopped.pages).toEqual([]);
    expect(stopped.activePageId).toBeUndefined();
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

  test('status re-reads the live entry when the runtime exits during a sample', async () => {
    const { service, runtimes } = harness(1);
    await service.start('s1', 'agent');
    const runtime = runtimes.get('s1')!;
    const gate = runtime.pauseNextLocation();
    const sampling = service.status('s1');
    await gate.started;

    runtime.fail('playwright', 23);
    await Bun.sleep(0);
    gate.release();
    const failed = await sampling;
    expect(failed).toMatchObject({ state: 'error', capacity: { running: 0, maximum: 1 } });
    expect(failed.error).toContain('playwright process exited unexpectedly (code 23)');
    await service.close();
  });

  test('redundant start re-reads the live entry when the runtime exits during its sample', async () => {
    const { service, runtimes } = harness(1);
    await service.start('s1', 'human');
    const runtime = runtimes.get('s1')!;
    const gate = runtime.pauseNextLocation();
    const restarting = service.start('s1', 'agent');
    await gate.started;

    runtime.fail('chrome', 24);
    await Bun.sleep(0);
    gate.release();
    const failed = await restarting;
    expect(failed).toMatchObject({ state: 'error', capacity: { running: 0, maximum: 1 } });
    expect(failed.error).toContain('chrome process exited unexpectedly (code 24)');
    await service.close();
  });

  test('published launch failures keep only a bounded first line', async () => {
    const clock = new FakeClock();
    const service = new BrowserService(
      createPaths('/tmp/kteam-browser-service-failure-test'),
      { resolve: async () => 's1' },
      {
        clock,
        runtimeFactory: async () => {
          throw new Error(`${'f'.repeat(600)}\r\nlocator snapshot\nsecret page text`);
        },
      },
    );

    await expect(service.start('s1', 'agent')).rejects.toBeInstanceOf(Error);
    const failed = await service.status('s1');
    expect(failed.error).toBe('f'.repeat(500));
    expect(failed.error).not.toContain('\n');
    expect(failed.error).not.toContain('secret page text');
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
    await service.start('s1', 'human');
    const clicked = await service.act('s1', { action: 'click', selector: '#continue' }, 'agent');
    expect(clicked.status.lastActor).toMatchObject({ kind: 'agent', action: 'click' });
    expect(clicked.status.agentPage).toMatchObject({ kind: 'agent', pageId: 'page-1', action: 'click' });
    expect(runtimes.get('s1')?.calls).toContain('click:#continue');
    const human = await service.noteHumanActivity('s1', 'keyboard');
    expect(human.lastActor).toMatchObject({ kind: 'human', action: 'keyboard' });
    expect(human.agentPage).toMatchObject({ kind: 'agent', pageId: 'page-1', action: 'click' });
    await service.act('s1', { action: 'type', selector: '#password', text: 'secret' }, 'agent');
    expect(runtimes.get('s1')?.calls).toContain('type:#password:secret');
    await service.close();
  });

  test('start records activity without inventing or clobbering agent page provenance', async () => {
    const { service } = harness();
    const started = await service.start('s1', 'agent');
    expect(started.agentPage).toBeUndefined();

    const clicked = await service.act('s1', { action: 'click', selector: '#popup' }, 'agent');
    expect(clicked.status.agentPage).toMatchObject({ pageId: 'page-1', action: 'click', kind: 'agent' });
    const restarted = await service.start('s1', 'agent');
    expect(restarted.lastActor).toMatchObject({ kind: 'agent', action: 'start' });
    expect(restarted.agentPage).toMatchObject({ pageId: 'page-1', action: 'click', kind: 'agent' });
    await service.close();
  });

  test('an action re-reads the live entry when the runtime exits while it is pending', async () => {
    const { service, runtimes } = harness(1);
    await service.start('s1', 'human');
    const runtime = runtimes.get('s1')!;
    const gate = runtime.pauseNextNavigation();
    const navigating = service.act('s1', { action: 'navigate', url: 'https://exit.test/' }, 'agent');
    await gate.started;

    runtime.fail('chrome', 25);
    await Bun.sleep(0);
    gate.release();
    const result = await navigating;
    expect(result.result).toMatchObject({ actedPageId: 'page-1', url: 'https://exit.test/' });
    expect(result.status).toMatchObject({ state: 'error', capacity: { running: 0, maximum: 1 } });
    expect(result.status.error).toContain('chrome process exited unexpectedly (code 25)');
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
    const resized = await service.act('s1', { action: 'resize', width: 100, height: 5_000 }, 'agent');
    expect(resized.status.viewport).toEqual({ width: 320, height: 1_200 });
    expect(resized.result).toMatchObject({ activePageId: 'page-1', actedPageId: 'page-1' });
    expect(resized.status.agentPage).toMatchObject({ pageId: 'page-1', action: 'resize', kind: 'agent' });
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

describe('live page snapshots and provenance', () => {
  test('swallows an incoherent status sample and keeps the last truthful snapshot', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    const runtime = runtimes.get('s1')!;
    runtime.setActivePageIdentity('https://fresh.test/', 'fresh');
    runtime.returnMalformedNextLocation();

    const stale = await service.status('s1');
    expect(stale).toMatchObject({ state: 'running', activePageId: 'page-1', url: 'about:blank', title: '' });
    const refreshed = await service.status('s1');
    expect(refreshed).toMatchObject({ activePageId: 'page-1', url: 'https://fresh.test/', title: 'fresh' });
    await service.close();
  });

  test('propagates an incoherent action snapshot as an upstream failure', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    runtimes.get('s1')!.returnMalformedNextAction();

    await expect(service.act('s1', { action: 'click', selector: '#continue' }, 'agent')).rejects.toMatchObject({
      code: 'upstream_failed',
      status: 502,
    });
    const recovered = await service.status('s1');
    expect(recovered).toMatchObject({ state: 'running', url: 'https://example.test/' });
    expect(recovered.lastActor).toMatchObject({ kind: 'human', action: 'start' });
    await service.close();
  });

  test('routes real tab actions and keeps top-level identity coherent with the active page', async () => {
    const { service, runtimes } = harness();
    const started = await service.start('s1', 'human');
    expect(started).toMatchObject({
      url: 'about:blank',
      title: '',
      pages: [{ id: 'page-1', url: 'about:blank', title: '' }],
      activePageId: 'page-1',
      pageState: 'ready',
      canGoBack: false,
      canGoForward: false,
    });

    const created = await service.act('s1', { action: 'new-page', url: 'https://new.test/' }, 'agent');
    const newPageId = created.result?.activePageId;
    expect(created.result).toMatchObject({
      activePageId: newPageId,
      url: 'https://new.test/',
      title: 'new page',
      pages: expect.arrayContaining([{ id: newPageId, url: 'https://new.test/', title: 'new page' }]),
    });
    expect(created.status.agentPage).toMatchObject({ pageId: newPageId, action: 'new-page' });

    const activated = await service.act('s1', { action: 'activate-page', pageId: 'page-1' }, 'agent');
    expect(activated.status).toMatchObject({ activePageId: 'page-1', url: 'about:blank', title: '' });
    expect(activated.status.agentPage).toMatchObject({ pageId: 'page-1', action: 'activate-page' });

    const closed = await service.act('s1', { action: 'close-page', pageId: 'page-1' }, 'agent');
    expect(closed.status).toMatchObject({ activePageId: newPageId, url: 'https://new.test/', title: 'new page' });
    expect(closed.status.pages.map(page => page.id)).not.toContain('page-1');
    expect(closed.status.agentPage).toMatchObject({ pageId: 'page-1', action: 'close-page' });
    expect(runtimes.get('s1')?.calls).toEqual([
      'new-page:https://new.test/',
      'activate-page:page-1',
      'close-page:page-1',
    ]);
    await service.close();
  });

  test('anchors agent provenance to the popup opener and preserves it through automatic human input and resize', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    const popup = await service.act('s1', { action: 'click', selector: '#popup' }, 'agent');
    expect(popup.result).toMatchObject({ activePageId: 'page-2', actedPageId: 'page-1', url: 'https://popup.test/' });
    expect(popup.status.agentPage).toMatchObject({ pageId: 'page-1', action: 'click', kind: 'agent' });

    const runtime = runtimes.get('s1')!;
    const locationCallsBeforeKeyDown = runtime.locationCalls;
    await service.dispatchHumanInput('s1', { kind: 'key', type: 'keyDown', key: 'k', code: 'KeyK' });
    expect(runtime.locationCalls).toBe(locationCallsBeforeKeyDown);
    const afterInput = await service.status('s1');
    expect(afterInput.lastActor).toMatchObject({ kind: 'human', action: 'keyboard' });
    expect(afterInput.agentPage).toMatchObject({ pageId: 'page-1', action: 'click', kind: 'agent' });

    const afterResize = await service.act('s1', { action: 'resize', width: 800, height: 600 }, 'human');
    expect(afterResize.status.lastActor).toMatchObject({ kind: 'human', action: 'resize' });
    expect(afterResize.status.agentPage).toMatchObject({ pageId: 'page-1', action: 'click', kind: 'agent' });
    await service.close();
  });

  test('keeps the honest closed agent page id instead of relabelling it as the new active page', async () => {
    const { service } = harness();
    await service.start('s1', 'human');
    const created = await service.act('s1', { action: 'new-page' }, 'agent');
    const agentPageId = created.result?.activePageId;
    expect(agentPageId).toBe('page-2');

    const closed = await service.act('s1', { action: 'close-page', pageId: agentPageId! }, 'human');
    expect(closed.status.activePageId).toBe('page-1');
    expect(closed.status.pages.map(page => page.id)).not.toContain(agentPageId!);
    expect(closed.status.lastActor).toMatchObject({ kind: 'human', action: 'close-page' });
    expect(closed.status.agentPage).toMatchObject({ pageId: agentPageId, action: 'new-page', kind: 'agent' });
    await service.close();
  });

  test('keeps read and screenshot payloads out of the cached status snapshot', async () => {
    const { service } = harness();
    await service.start('s1', 'human');
    const cache = () =>
      (service as unknown as { entries: Map<string, { snapshot?: Record<string, unknown> }> }).entries.get('s1')
        ?.snapshot;

    const read = await service.act('s1', { action: 'read', selector: '#secret' }, 'agent');
    expect(read.result?.text).toBe('body');
    expect(cache()).not.toHaveProperty('text');
    expect(cache()).not.toHaveProperty('screenshotBase64');
    expect(cache()).not.toHaveProperty('actedPageId');

    const screenshot = await service.act('s1', { action: 'screenshot' }, 'agent');
    expect(screenshot.result?.screenshotBase64).toBe('cG5n');
    expect(cache()).not.toHaveProperty('text');
    expect(cache()).not.toHaveProperty('screenshotBase64');
    expect(cache()).not.toHaveProperty('actedPageId');
    await service.close();
  });

  test('uses the worker atomic acted page id rather than a cached active page for agent provenance', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    await service.act('s1', { action: 'new-page' }, 'human');
    // The cached service snapshot now names page-2. The action result models
    // a worker-serialized click that actually targeted page-1 and landed on a
    // popup page-3; attribution must trust actedPageId, not either active id.
    runtimes.get('s1')!.setNextClickActedPageId('page-1');
    const popup = await service.act('s1', { action: 'click', selector: '#popup' }, 'agent');
    expect(popup.result).toMatchObject({ activePageId: 'page-3', actedPageId: 'page-1', url: 'https://popup.test/' });
    expect(popup.status).toMatchObject({ activePageId: 'page-3', agentPage: { pageId: 'page-1', action: 'click' } });
    await service.close();
  });

  test('reports a pending navigation as loading, then refreshes error and history state including back', async () => {
    const { service, runtimes } = harness();
    await service.start('s1', 'human');
    const runtime = runtimes.get('s1')!;
    runtime.setActivePageState('error', {
      pageError: `${'s'.repeat(250)}\r\nlocator snapshot\nsecret page text`,
      canGoBack: false,
      canGoForward: false,
    });
    const cachedFailure = await service.status('s1');
    expect(cachedFailure.pageError).toBe('s'.repeat(200));

    const gate = runtime.pauseNextNavigation();
    const navigating = service.act('s1', { action: 'navigate', url: 'https://loading.test/' }, 'agent');
    await gate.started;

    const busy = await service.status('s1');
    expect(busy).toMatchObject({
      activePageId: 'page-1',
      url: 'about:blank',
      pageState: 'loading',
      canGoBack: false,
      canGoForward: false,
    });
    expect(busy.pageError).toBeUndefined();

    gate.release();
    const navigated = await navigating;
    expect(navigated.status).toMatchObject({
      url: 'https://loading.test/',
      pageState: 'ready',
      canGoBack: true,
      canGoForward: false,
    });

    runtime.setActivePageState('error', {
      pageError: 'fixture navigation failed\nlocator snapshot\nsecret page text',
      canGoBack: true,
      canGoForward: false,
    });
    const failed = await service.status('s1');
    expect(failed).toMatchObject({
      pageState: 'error',
      pageError: 'fixture navigation failed',
      canGoBack: true,
      canGoForward: false,
    });

    const backed = await service.act('s1', { action: 'back' }, 'agent');
    expect(backed.result).toMatchObject({
      url: 'https://example.test/old',
      title: 'old',
      pageState: 'ready',
      canGoBack: false,
      canGoForward: true,
    });
    expect(backed.status).toMatchObject({ url: 'https://example.test/old', canGoBack: false, canGoForward: true });
    expect(runtime.calls).toContain('back');
    await service.close();
  });
});
