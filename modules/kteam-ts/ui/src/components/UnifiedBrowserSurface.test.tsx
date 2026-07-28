import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browserDestination, InAppBrowserFrame } from './InAppBrowser';
import {
  browserEngineForSession,
  createPreviewHistory,
  movePreviewHistory,
  pushPreviewHistory,
  rememberBrowserEngine,
  resetBrowserSurfaceSessions,
  resolveBrowserAddress,
  UnifiedBrowserSurface,
  type UnifiedBrowserDependencies,
} from './UnifiedBrowserSurface';

afterEach(() => resetBrowserSurfaceSessions());

describe('browser address policy', () => {
  test('fixes bare hosts and local development ports', () => {
    expect(resolveBrowserAddress('github.com/openai', 'https://team.example.test/')).toEqual({
      kind: 'url',
      destination: {
        href: 'https://github.com/openai',
        hostname: 'github.com',
        scope: 'cross-origin',
      },
    });
    expect(resolveBrowserAddress('localhost:5173', 'https://team.example.test/')).toEqual({
      kind: 'url',
      destination: {
        href: 'http://localhost:5173/',
        hostname: 'localhost',
        scope: 'device-loopback',
      },
    });
  });

  test('resolves site-relative addresses against the current page', () => {
    expect(resolveBrowserAddress('../api', 'https://docs.example.test/guide/start')).toEqual({
      kind: 'url',
      destination: {
        href: 'https://docs.example.test/api',
        hostname: 'docs.example.test',
        scope: 'same-origin',
      },
    });
    expect(resolveBrowserAddress('?page=2', 'https://docs.example.test/guide/start?old=1#top')).toEqual({
      kind: 'url',
      destination: {
        href: 'https://docs.example.test/guide/start?page=2',
        hostname: 'docs.example.test',
        scope: 'same-origin',
      },
    });
    expect(resolveBrowserAddress('#api', 'https://docs.example.test/guide/start?old=1')).toEqual({
      kind: 'url',
      destination: {
        href: 'https://docs.example.test/guide/start?old=1#api',
        hostname: 'docs.example.test',
        scope: 'same-origin',
      },
    });
  });

  test('makes non-URLs explicit DuckDuckGo searches and refuses unsafe schemes', () => {
    const search = resolveBrowserAddress('cross origin iframe policy', 'https://team.example.test/');
    expect(search.kind).toBe('search');
    if (search.kind !== 'error') {
      expect(search.destination.href).toBe('https://duckduckgo.com/?q=cross+origin+iframe+policy');
    }
    expect(resolveBrowserAddress('javascript:alert(1)')).toEqual({
      kind: 'error',
      message: 'Only HTTP and HTTPS addresses can be opened.',
    });
  });
});

describe('preview history', () => {
  test('starts empty when the Browser tab opens before any transcript link', () => {
    const history = createPreviewHistory();
    expect(history).toEqual({ entries: [], index: -1, revision: 0 });
    expect(movePreviewHistory(history, -1)).toBe(history);
    expect(movePreviewHistory(history, 1)).toBe(history);
  });

  test('keeps an independent bounded back/forward stack and drops a stale forward branch', () => {
    const one = browserDestination('https://one.example/')!;
    const two = browserDestination('https://two.example/')!;
    const three = browserDestination('https://three.example/')!;
    let history = createPreviewHistory(one);
    history = pushPreviewHistory(history, two);
    history = movePreviewHistory(history, -1);
    expect(history.entries[history.index]).toEqual(one);
    history = pushPreviewHistory(history, three);
    expect(history.entries.map(entry => entry.href)).toEqual([one.href, three.href]);
    expect(movePreviewHistory(history, 1)).toBe(history);
  });

  test('treats navigating to the current address as an iframe reload', () => {
    const destination = browserDestination('https://example.test/')!;
    const history = createPreviewHistory(destination);
    expect(pushPreviewHistory(history, destination)).toEqual({ ...history, revision: 1 });
  });
});

describe('session engine memory', () => {
  test('defaults to preview and remembers a manual choice only for that session', () => {
    expect(browserEngineForSession('session-a')).toBe('preview');
    rememberBrowserEngine('session-a', 'remote');
    expect(browserEngineForSession('session-a')).toBe('remote');
    expect(browserEngineForSession('session-b')).toBe('preview');
  });
});

const destination = browserDestination('https://example.test/docs', 'https://team.example.test/')!;

const remoteStatus = {
  sessionId: 'session-a',
  state: 'running' as const,
  viewport: { width: 800, height: 600 },
  viewers: 1,
  persistentProfile: true as const,
  idleTimeoutSeconds: 600,
  capacity: { running: 1, maximum: 3 },
  url: destination.href,
  title: 'Example docs',
};

const remoteAction = async () => ({ status: remoteStatus });

const remoteApi = {
  open: remoteAction,
  navigate: remoteAction,
  back: remoteAction,
  forward: remoteAction,
  reload: remoteAction,
};

type Effect = { deps: readonly unknown[] | undefined; create: () => void | (() => void); cleanup?: () => void };
type ElementLike = { type?: unknown; props?: Record<string, unknown> };

const reactInternals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

class HookHarness {
  private slots: unknown[] = [];
  private effects = new Map<number, Effect>();
  private pendingEffects: number[] = [];
  private index = 0;
  private queued = false;
  private renderComponent: (() => unknown) | null = null;
  output: unknown;

  useState<T>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] {
    const index = this.index++;
    if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    const setState: React.Dispatch<React.SetStateAction<T>> = value => {
      const current = this.slots[index] as T;
      this.slots[index] = typeof value === 'function' ? (value as (previous: T) => T)(current) : value;
      this.schedule();
    };
    return [this.slots[index] as T, setState];
  }

  useRef<T>(initial: T): React.RefObject<T> {
    const index = this.index++;
    if (!(index in this.slots)) this.slots[index] = { current: initial };
    return this.slots[index] as React.RefObject<T>;
  }

  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T {
    const index = this.index++;
    const previous = this.slots[index] as { callback: T; deps: readonly unknown[] } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => value === previous.deps[i]))
      return previous.callback;
    this.slots[index] = { callback, deps };
    return callback;
  }

  useEffect(create: () => void | (() => void), deps: readonly unknown[] | undefined): void {
    const index = this.index++;
    const previous = this.effects.get(index);
    const changed =
      !previous ||
      !deps ||
      !previous.deps ||
      deps.length !== previous.deps.length ||
      deps.some((value, i) => value !== previous.deps?.[i]);
    this.effects.set(index, { deps, create, cleanup: previous?.cleanup });
    if (changed) this.pendingEffects.push(index);
  }

  render(component: () => unknown): void {
    this.renderComponent = component;
    this.index = 0;
    this.pendingEffects = [];
    const previousDispatcher = reactInternals.H;
    reactInternals.H = {
      useState: <T,>(initial: T | (() => T)) => this.useState(initial),
      useRef: <T,>(initial: T) => this.useRef(initial),
      useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]) =>
        this.useCallback(callback, deps),
      useEffect: (create: () => void | (() => void), deps?: readonly unknown[]) => this.useEffect(create, deps),
    };
    try {
      this.output = component();
    } finally {
      reactInternals.H = previousDispatcher;
    }
    for (const index of this.pendingEffects) {
      const effect = this.effects.get(index)!;
      effect.cleanup?.();
      effect.cleanup = effect.create() || undefined;
    }
  }

  unmount(): void {
    this.renderComponent = null;
    for (const effect of this.effects.values()) effect.cleanup?.();
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.renderComponent) this.render(this.renderComponent);
    });
  }
}

function visit(node: unknown, predicate: (element: ElementLike) => boolean): ElementLike | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = visit(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const element = node as ElementLike;
  if (predicate(element)) return element;
  return visit(element.props?.children, predicate);
}

function flush(): Promise<void> {
  return Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('unified browser chrome', () => {
  test('has an honest neutral home when the Browser tab is selected directly', () => {
    const html = renderToStaticMarkup(
      <UnifiedBrowserSurface
        sessionId="session-a"
        destination={null}
        presentation="pane"
        titleId="browser-title"
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('Where to?');
    expect(html).toContain('Nothing opens until you choose where to go');
    expect(html).toContain('placeholder="URL or DuckDuckGo search"');
    const backTag = html.match(/<button[^>]*aria-label="Back in preview"[^>]*>/)?.[0];
    const forwardTag = html.match(/<button[^>]*aria-label="Forward in preview"[^>]*>/)?.[0];
    expect(backTag).toContain('disabled=""');
    expect(forwardTag).toContain('disabled=""');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('autofocus');
  });

  test('defaults a tapped transcript link to the deployed iframe with manual, thumb-safe escape controls', () => {
    const html = renderToStaticMarkup(
      <UnifiedBrowserSurface
        sessionId="session-a"
        destination={destination}
        presentation="pane"
        titleId="browser-title"
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Browser engine"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('URL or DuckDuckGo search');
    expect(html).toContain('Preview tracks app-opened pages; in-page links may not update here.');
    expect(html).toContain('Some sites block previews');
    expect(html).toContain('Open in real browser');
    expect(html).toContain('Open externally in a new tab');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox=');
    expect(html).not.toContain('autofocus');
    expect(html).not.toContain('aria-modal');
  });

  test('embeds the remote engine content-only and detaches its viewer while the retained surface is hidden', () => {
    rememberBrowserEngine('session-a', 'remote');
    const dependencies: UnifiedBrowserDependencies = {
      remoteApi,
      RemotePane: props => (
        <div
          data-remote-pane="true"
          data-active={String(props.isActive)}
          data-navigation={String(props.showNavigation)}
        />
      ),
    };
    const html = renderToStaticMarkup(
      <UnifiedBrowserSurface
        sessionId="session-a"
        destination={destination}
        presentation="pane"
        titleId="browser-title"
        onClose={() => undefined}
        isActive={false}
        dependencies={dependencies}
      />,
    );

    expect(html).toContain('data-remote-pane="true"');
    expect(html).toContain('data-active="false"');
    expect(html).toContain('data-navigation="false"');
    expect(html).not.toContain('<iframe');
  });

  test('keeps engine selection independent and copies a URL only through the explicit real-browser escape', async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const action = (name: string) => async (sessionId: string, url?: string) => {
      calls.push([name, sessionId, url]);
      return { status: { ...remoteStatus, url: url ?? remoteStatus.url } };
    };
    const dependencies: UnifiedBrowserDependencies = {
      remoteApi: {
        open: action('open'),
        navigate: action('navigate'),
        back: action('back'),
        forward: action('forward'),
        reload: action('reload'),
      },
      RemotePane: () => <div data-remote-pane="true" />,
    };
    const harness = new HookHarness();
    harness.render(() =>
      UnifiedBrowserSurface({
        sessionId: 'session-a',
        destination,
        presentation: 'pane',
        titleId: 'browser-title',
        onClose: () => undefined,
        dependencies,
      }),
    );

    const realButton = visit(harness.output, element => element.props?.children === 'Real')!;
    (realButton.props!.onClick as () => void)();
    await flush();

    expect(calls).toEqual([['open', 'session-a', undefined]]);
    expect(browserEngineForSession('session-a')).toBe('remote');
    expect(visit(harness.output, element => element.type === dependencies.RemotePane)).toBeDefined();

    const realBrowserEscape = visit(
      harness.output,
      element => element.props?.['aria-label'] === 'Open in real browser',
    )!;
    (realBrowserEscape.props!.onClick as () => void)();
    await flush();
    expect(calls).toEqual([
      ['open', 'session-a', undefined],
      ['open', 'session-a', destination.href],
    ]);
    harness.unmount();
  });

  test('does not drop a link tapped after an empty remote Browser sheet was unmounted', async () => {
    const calls: Array<[string, string | undefined]> = [];
    rememberBrowserEngine('session-a', 'remote');
    const action = async (sessionId: string, url?: string) => {
      calls.push([sessionId, url]);
      return { status: { ...remoteStatus, url: url ?? remoteStatus.url } };
    };
    const dependencies: UnifiedBrowserDependencies = {
      remoteApi: { open: action, navigate: action, back: action, forward: action, reload: action },
      RemotePane: () => <div />,
    };
    const harness = new HookHarness();
    harness.render(() =>
      UnifiedBrowserSurface({
        sessionId: 'session-a',
        destination,
        presentation: 'sheet',
        titleId: 'browser-title',
        onClose: () => undefined,
        dependencies,
      }),
    );
    await flush();

    expect(calls).toEqual([['session-a', destination.href]]);
    harness.unmount();
  });

  test('treats a fresh repeat tap of the original transcript URL as navigation', async () => {
    let incoming = destination;
    const harness = new HookHarness();
    const render = () =>
      UnifiedBrowserSurface({
        sessionId: 'session-a',
        destination: incoming,
        presentation: 'pane',
        titleId: 'browser-title',
        onClose: () => undefined,
      });
    harness.render(render);

    let input = visit(harness.output, element => element.type === 'input')!;
    (input.props!.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'github.com/openai' },
    });
    await flush();
    const form = visit(harness.output, element => element.type === 'form')!;
    (form.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
    await flush();
    expect(
      (visit(harness.output, element => element.type === InAppBrowserFrame)!.props!.destination as { href: string })
        .href,
    ).toBe('https://github.com/openai');

    incoming = { ...destination };
    harness.render(render);
    await flush();
    expect(
      (visit(harness.output, element => element.type === InAppBrowserFrame)!.props!.destination as { href: string })
        .href,
    ).toBe(destination.href);
    harness.unmount();
  });

  test('ignores stale remote action completion and keeps busy until the newest request settles', async () => {
    const first = deferred<{ status: typeof remoteStatus }>();
    const second = deferred<{ status: typeof remoteStatus }>();
    let openCount = 0;
    const nextDestination = browserDestination('https://new.example.test/path')!;
    let incoming = destination;
    const dependencies: UnifiedBrowserDependencies = {
      remoteApi: {
        open: async () => (openCount++ === 0 ? first.promise : second.promise),
        navigate: remoteAction,
        back: remoteAction,
        forward: remoteAction,
        reload: remoteAction,
      },
      RemotePane: () => <div />,
    };
    const harness = new HookHarness();
    const render = () =>
      UnifiedBrowserSurface({
        sessionId: 'session-a',
        destination: incoming,
        presentation: 'pane',
        titleId: 'browser-title',
        onClose: () => undefined,
        dependencies,
      });
    harness.render(render);
    const realButton = visit(harness.output, element => element.props?.children === 'Real')!;
    (realButton.props!.onClick as () => void)();
    await flush();

    incoming = nextDestination;
    harness.render(render);
    await flush();
    expect(openCount).toBe(2);
    expect(
      visit(harness.output, element => element.props?.['aria-label'] === 'Open in real browser')!.props!.disabled,
    ).toBe(true);

    second.resolve({ status: { ...remoteStatus, url: nextDestination.href, title: 'Newer page' } });
    await flush();
    expect(visit(harness.output, element => element.type === 'input')!.props!.value).toBe(nextDestination.href);
    expect(
      visit(harness.output, element => element.props?.['aria-label'] === 'Open in real browser')!.props!.disabled,
    ).toBe(false);

    first.resolve({ status: { ...remoteStatus, url: destination.href, title: 'Stale page' } });
    await flush();
    expect(visit(harness.output, element => element.type === 'input')!.props!.value).toBe(nextDestination.href);
    harness.unmount();
  });

  test('keeps the shared address truthful from sampled remote location metadata', async () => {
    rememberBrowserEngine('session-a', 'remote');
    const dependencies: UnifiedBrowserDependencies = {
      remoteApi,
      RemotePane: () => <div />,
    };
    const harness = new HookHarness();
    harness.render(() =>
      UnifiedBrowserSurface({
        sessionId: 'session-a',
        destination,
        presentation: 'pane',
        titleId: 'browser-title',
        onClose: () => undefined,
        dependencies,
      }),
    );
    await flush();

    const remotePane = visit(harness.output, element => element.type === dependencies.RemotePane)!;
    (remotePane.props!.onLocationChange as (location: { url: string; title: string }) => void)({
      url: 'https://clicked.example.test/current',
      title: 'Clicked page',
    });
    await flush();

    expect(visit(harness.output, element => element.type === 'input')!.props!.value).toBe(
      'https://clicked.example.test/current',
    );
    expect(visit(harness.output, element => element.props?.title === 'Clicked page')).toBeDefined();
    harness.unmount();
  });

  test('submits normalized addresses into preview history and exposes coherent back/forward controls', async () => {
    const harness = new HookHarness();
    harness.render(() =>
      UnifiedBrowserSurface({
        sessionId: 'session-a',
        destination,
        presentation: 'pane',
        titleId: 'browser-title',
        onClose: () => undefined,
      }),
    );

    let input = visit(harness.output, element => element.type === 'input')!;
    (input.props!.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'github.com/openai' },
    });
    await flush();
    let form = visit(harness.output, element => element.type === 'form')!;
    (form.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
    await flush();

    let frame = visit(harness.output, element => element.type === InAppBrowserFrame)!;
    expect((frame.props!.destination as { href: string }).href).toBe('https://github.com/openai');

    const back = visit(harness.output, element => element.props?.['aria-label'] === 'Back in preview')!;
    (back.props!.onClick as () => void)();
    await flush();
    frame = visit(harness.output, element => element.type === InAppBrowserFrame)!;
    expect((frame.props!.destination as { href: string }).href).toBe(destination.href);

    const forward = visit(harness.output, element => element.props?.['aria-label'] === 'Forward in preview')!;
    (forward.props!.onClick as () => void)();
    await flush();
    input = visit(harness.output, element => element.type === 'input')!;
    expect(input.props!.value).toBe('https://github.com/openai');
    harness.unmount();
  });
});
