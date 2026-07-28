import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { BROWSER_MAX_PAGE_ID_LENGTH } from '../../../src/browser-types';
import { RemoteBrowserPane, type RemoteBrowserDependencies, type RemoteBrowserPaneProps } from './RemoteBrowserPane';
import type { RemoteBrowserStatus } from '../lib/remote-browser';

const status = {
  sessionId: 'session-1',
  state: 'running' as const,
  viewport: { width: 800, height: 400 },
  viewers: 1,
  persistentProfile: true as const,
  idleTimeoutSeconds: 900,
  capacity: { running: 1, maximum: 2 },
  url: 'https://example.test/current',
  title: 'Current page',
};

function frameEnvelope(pageId: string, jpegBytes = Uint8Array.of(0xff, 0xd8, 0xff), version = 1): ArrayBuffer {
  const pageIdBytes = new TextEncoder().encode(pageId);
  const bytes = new Uint8Array(7 + pageIdBytes.byteLength + jpegBytes.byteLength);
  bytes.set([0x4b, 0x42, 0x52, 0x46], 0); // "KBRF"
  bytes[4] = version;
  new DataView(bytes.buffer).setUint16(5, pageIdBytes.byteLength, false);
  bytes.set(pageIdBytes, 7);
  bytes.set(jpegBytes, 7 + pageIdBytes.byteLength);
  return bytes.buffer;
}

const apiCalls = {
  status: [] as string[],
  resize: [] as Array<[string, number, number]>,
  pages: [] as Array<[string, string, string | undefined]>,
};

const remoteBrowserApi = {
  status: async (sessionId: string) => {
    apiCalls.status.push(sessionId);
    return status;
  },
  resize: async (sessionId: string, width: number, height: number) => {
    apiCalls.resize.push([sessionId, width, height]);
    return { status: { ...status, viewport: { width, height } } };
  },
  start: async () => ({ status }),
  open: async () => ({ status }),
  stop: async () => ({ status }),
  navigate: async () => ({ status }),
  back: async () => ({ status }),
  forward: async () => ({ status }),
  reload: async () => ({ status }),
  activity: async () => ({ status }),
  // Page control answers with the PAGED snapshot: the daemon returns the
  // refreshed status, so the strip must survive an activate/close/new.
  newPage: async (sessionId: string, url?: string) => {
    apiCalls.pages.push(['new-page', sessionId, url]);
    return { status: pagedStatus };
  },
  activatePage: async (sessionId: string, pageId: string) => {
    apiCalls.pages.push(['activate-page', sessionId, pageId]);
    return { status: pagedStatus };
  },
  closePage: async (sessionId: string, pageId: string) => {
    apiCalls.pages.push(['close-page', sessionId, pageId]);
    return { status: pagedStatus };
  },
};

/** A daemon that reports real Chrome pages, an explicit active target, and the
 *  page the agent last acted on. */
const pagedStatus = {
  ...status,
  pages: [
    { id: 'page-1', url: 'https://example.test/current', title: 'Current page' },
    { id: 'page-2', url: 'https://docs.example.test/guide', title: 'Guide' },
    { id: 'page-3', url: 'about:blank', title: '' },
  ],
  activePageId: 'page-2',
  agentPage: { pageId: 'page-1', kind: 'agent' as const, action: 'click' as const, at: '2026-07-28T10:00:00.000Z' },
  canGoBack: true,
  canGoForward: false,
  pageState: 'ready' as const,
};

type Effect = { deps: readonly unknown[] | undefined; create: () => void | (() => void); cleanup?: () => void };

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
  private tree: unknown;

  constructor(private readonly assignRefs: (tree: unknown) => void) {}

  useState<T>(initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
    const index = this.index++;
    if (!(index in this.slots)) this.slots[index] = initial;
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

  render(renderComponent: () => unknown): void {
    this.renderComponent = renderComponent;
    this.index = 0;
    this.pendingEffects = [];
    const previousDispatcher = reactInternals.H;
    reactInternals.H = {
      useState: <T,>(initial: T) => this.useState(initial),
      useRef: <T,>(initial: T) => this.useRef(initial),
      useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]) =>
        this.useCallback(callback, deps),
      useEffect: (create: () => void | (() => void), deps?: readonly unknown[]) => this.useEffect(create, deps),
    };
    try {
      this.tree = renderComponent();
    } finally {
      reactInternals.H = previousDispatcher;
    }
    this.assignRefs(this.tree);
    for (const index of this.pendingEffects) {
      const effect = this.effects.get(index)!;
      effect.cleanup?.();
      effect.cleanup = effect.create() || undefined;
    }
  }

  get output(): unknown {
    return this.tree;
  }

  unmount(): void {
    this.renderComponent = null;
    for (const effect of this.effects.values()) effect.cleanup?.();
  }

  private renderComponent: (() => unknown) | null = null;

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.renderComponent) this.render(this.renderComponent);
    });
  }
}

let harness: HookHarness | null = null;

const dependencies: RemoteBrowserDependencies = {
  api: remoteBrowserApi,
  streamUrl: sessionId => `ws://browser.test/${sessionId}`,
  viewportForContainer: (width, height, mode) =>
    mode === 'desktop' ? { width: 1280, height: 800 } : { width: Math.round(width), height: Math.round(height) },
};

// Dependency objects MUST be stable across renders: a fresh object identity
// would change the status-poll effect's deps every commit and spin forever.
const withStatus = (next: () => RemoteBrowserStatus): RemoteBrowserDependencies => ({
  ...dependencies,
  api: { ...remoteBrowserApi, status: async () => next() },
});

const pagedDependencies = withStatus(() => pagedStatus);
const closedAgentPageDependencies = withStatus(() => ({
  ...pagedStatus,
  agentPage: { ...pagedStatus.agentPage, pageId: 'page-9' },
}));
const failedPageDependencies = withStatus(() => ({
  ...pagedStatus,
  pageState: 'error' as const,
  pageError: 'net::ERR_CONNECTION_REFUSED',
}));
const loadingPageDependencies = withStatus(() => ({ ...pagedStatus, pageState: 'loading' as const }));

let testClock = 1_000;
const clockDependencies: RemoteBrowserDependencies = { ...dependencies, now: () => testClock };

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  readonly sent: string[] = [];
  readonly closes: Array<[number | undefined, string | undefined]> = [];
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
    this.readyState = 3;
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;

  constructor(private readonly callback: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: unknown): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(width: number, height: number): void {
    this.callback([{ contentRect: { width, height } }]);
  }
}

type ElementLike = { type?: unknown; props?: Record<string, unknown> };

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

function collect(
  node: unknown,
  predicate: (element: ElementLike) => boolean,
  matches: ElementLike[] = [],
): ElementLike[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== 'object') return matches;
  const element = node as ElementLike;
  if (predicate(element)) matches.push(element);
  collect(element.props?.children, predicate, matches);
  return matches;
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

function createCanvas(): HTMLCanvasElement & {
  draws: Array<[unknown, number, number]>;
  clears: Array<[number, number, number, number]>;
} {
  const canvas = {
    width: 800,
    height: 400,
    draws: [] as Array<[unknown, number, number]>,
    clears: [] as Array<[number, number, number, number]>,
    focus: () => undefined,
    setPointerCapture: () => undefined,
    hasPointerCapture: () => true,
    releasePointerCapture: () => undefined,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 200 }),
    getContext: () => ({
      drawImage: (bitmap: unknown, x: number, y: number) => canvas.draws.push([bitmap, x, y]),
      clearRect: (x: number, y: number, width: number, height: number) => canvas.clears.push([x, y, width, height]),
    }),
  } as unknown as HTMLCanvasElement & {
    draws: Array<[unknown, number, number]>;
    clears: Array<[number, number, number, number]>;
  };
  return canvas;
}

function mount(renderComponent: () => unknown = () => RemoteBrowserPane({ sessionId: 'session-1', dependencies })): {
  canvas: ReturnType<typeof createCanvas>;
  unmount: () => void;
} {
  const canvas = createCanvas();
  const screen = {} as HTMLDivElement;
  const assignRefs = (tree: unknown) => {
    const screenElement = visit(tree, element => element.type === 'div' && Boolean(element.props?.ref));
    const canvasElement = visit(tree, element => element.type === 'canvas');
    const screenRef = screenElement?.props?.ref as React.RefObject<HTMLDivElement> | undefined;
    const canvasRef = canvasElement?.props?.ref as React.RefObject<HTMLCanvasElement> | undefined;
    if (screenRef) screenRef.current = screen;
    if (canvasRef) canvasRef.current = canvas;
  };
  harness = new HookHarness(assignRefs);
  harness.render(renderComponent);
  return {
    canvas,
    unmount: () => harness?.unmount(),
  };
}

let originalWebSocket: typeof WebSocket | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalCreateImageBitmap: typeof createImageBitmap | undefined;
let originalWindow: typeof window | undefined;
let originalDocument: typeof document | undefined;

beforeEach(() => {
  apiCalls.status.length = 0;
  apiCalls.resize.length = 0;
  apiCalls.pages.length = 0;
  FakeWebSocket.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  originalWebSocket = globalThis.WebSocket;
  originalResizeObserver = globalThis.ResizeObserver;
  originalCreateImageBitmap = globalThis.createImageBitmap;
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  globalThis.createImageBitmap = async () => ({ width: 640, height: 360, close: () => undefined });
  globalThis.window = {
    setInterval: (callback: () => void) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    clearInterval: () => undefined,
    setTimeout: (callback: () => void) => {
      timerCallbacks.push(callback);
      return timerCallbacks.length;
    },
    clearTimeout: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
});

const timerCallbacks: Array<() => void> = [];
const intervalCallbacks: Array<() => void> = [];

afterEach(() => {
  harness?.unmount();
  harness = null;
  timerCallbacks.length = 0;
  intervalCallbacks.length = 0;
  globalThis.WebSocket = originalWebSocket!;
  globalThis.ResizeObserver = originalResizeObserver!;
  globalThis.createImageBitmap = originalCreateImageBitmap!;
  globalThis.window = originalWindow!;
  globalThis.document = originalDocument!;
});

describe('RemoteBrowserPane', () => {
  test('shows the backend launch failure instead of the stopped call-to-action', async () => {
    const reason = 'Google Chrome was not found for linux; set KTEAM_CHROME_BIN to its executable';
    const failedDependencies: RemoteBrowserDependencies = {
      ...dependencies,
      api: {
        ...remoteBrowserApi,
        status: async () => ({
          ...status,
          state: 'error',
          viewers: 0,
          capacity: { running: 0, maximum: 2 },
          error: reason,
        }),
      },
    };

    mount(() => RemoteBrowserPane({ sessionId: 'session-1', dependencies: failedDependencies }));
    await flush();

    expect(visit(harness!.output, element => element.props?.children === 'Browser unavailable')).toBeDefined();
    expect(visit(harness!.output, element => element.props?.children === reason)).toBeDefined();
    expect(visit(harness!.output, element => element.props?.children === 'Browser is stopped')).toBeUndefined();
  });

  test('switches the overlay immediately when start fails before the next status poll', async () => {
    const reason = 'Google Chrome was not found for linux; set KTEAM_CHROME_BIN to its executable';
    const failedStartDependencies: RemoteBrowserDependencies = {
      ...dependencies,
      api: {
        ...remoteBrowserApi,
        status: async () => ({
          ...status,
          state: 'stopped',
          viewers: 0,
          capacity: { running: 0, maximum: 2 },
        }),
        start: async () => {
          throw new Error(reason);
        },
      },
    };

    mount(() => RemoteBrowserPane({ sessionId: 'session-1', dependencies: failedStartDependencies }));
    await flush();
    const startButton = visit(
      harness!.output,
      element => element.props?.variant === 'primary' && typeof element.props?.onClick === 'function',
    )!;
    (startButton.props!.onClick as () => void)();
    await flush();

    expect(visit(harness!.output, element => element.props?.children === 'Browser unavailable')).toBeDefined();
    expect(visit(harness!.output, element => element.props?.children === reason)).toBeDefined();
    expect(visit(harness!.output, element => element.props?.children === 'Browser is stopped')).toBeUndefined();
  });

  test('keeps the normal stopped guidance for a genuinely idle browser', async () => {
    const stoppedDependencies: RemoteBrowserDependencies = {
      ...dependencies,
      api: {
        ...remoteBrowserApi,
        status: async () => ({
          ...status,
          state: 'stopped',
          viewers: 0,
          capacity: { running: 0, maximum: 2 },
        }),
      },
    };

    mount(() => RemoteBrowserPane({ sessionId: 'session-1', dependencies: stoppedDependencies }));
    await flush();

    expect(visit(harness!.output, element => element.props?.children === 'Browser is stopped')).toBeDefined();
    expect(visit(harness!.output, element => element.props?.children === 'Browser unavailable')).toBeUndefined();
  });

  test('ignores a stale status poll that resolves after a newer location sample', async () => {
    const stale = deferred<typeof status>();
    const fresh = deferred<typeof status>();
    const locations: Array<{ url: string; title: string }> = [];
    let statusCalls = 0;
    const orderedDependencies: RemoteBrowserDependencies = {
      ...dependencies,
      api: {
        ...remoteBrowserApi,
        status: async () => (statusCalls++ === 0 ? stale.promise : fresh.promise),
      },
    };

    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: orderedDependencies,
        onLocationChange: location => locations.push(location),
      }),
    );
    expect(statusCalls).toBe(1);
    intervalCallbacks[0]!();
    expect(statusCalls).toBe(2);

    fresh.resolve({ ...status, url: 'https://new.example.test/', title: 'New page' });
    await flush();
    expect(locations).toEqual([{ url: 'https://new.example.test/', title: 'New page' }]);

    stale.resolve({ ...status, url: 'https://stale.example.test/', title: 'Stale page' });
    await flush();
    expect(locations).toEqual([{ url: 'https://new.example.test/', title: 'New page' }]);
  });

  test('does not let an earlier status poll overwrite a newer pane action result', async () => {
    const stale = deferred<typeof status>();
    const locations: Array<{ url: string; title: string }> = [];
    const actionStatus = { ...status, url: 'https://action.example.test/', title: 'Action page' };
    const orderedDependencies: RemoteBrowserDependencies = {
      ...dependencies,
      api: {
        ...remoteBrowserApi,
        status: async () => stale.promise,
        start: async () => ({ status: actionStatus }),
      },
    };

    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: orderedDependencies,
        onLocationChange: location => locations.push(location),
      }),
    );
    const startButton = visit(
      harness!.output,
      element => element.props?.variant === 'primary' && typeof element.props?.onClick === 'function',
    )!;
    (startButton.props!.onClick as () => void)();
    await flush();
    expect(locations).toEqual([{ url: 'https://action.example.test/', title: 'Action page' }]);

    stale.resolve({ ...status, url: 'https://stale.example.test/', title: 'Stale page' });
    await flush();
    expect(locations).toEqual([{ url: 'https://action.example.test/', title: 'Action page' }]);
  });

  test('keeps every compact remote-browser control at least 44px tall', async () => {
    mount();
    await flush();
    const controls = collect(
      harness!.output,
      element => typeof element.props?.className === 'string' && /min-h-\[(?:40|44)px\]/.test(element.props.className),
    );
    expect(controls).toHaveLength(5);
    for (const control of controls) expect(control.props?.className).toContain('min-h-[44px]');
  });

  test('keeps its stream open while Fit is toggled', async () => {
    mount();
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    await flush();

    const fitButton = visit(harness!.output, element => element.props?.['aria-pressed'] === true)!;
    (fitButton.props!.onClick as () => void)();
    await flush();
    (fitButton.props!.onClick as () => void)();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.closes).toEqual([]);
  });

  test('resizes the daemon viewport and paints a legacy raw JPEG only when status has no active identity', async () => {
    const mounted = mount();
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    const observer = FakeResizeObserver.instances[0]!;

    observer.emit(900, 600);
    while (timerCallbacks.length) timerCallbacks.shift()?.();
    await flush();
    expect(apiCalls.resize).toEqual([['session-1', 900, 600]]);

    socket.emit('message', { data: new ArrayBuffer(8) });
    await flush();
    expect(mounted.canvas.width).toBe(640);
    expect(mounted.canvas.height).toBe(360);
    expect(mounted.canvas.draws).toHaveLength(1);
  });

  test('clears page A on a B commit and never repaints delayed, missing-tag, or malformed A frames', async () => {
    let currentStatus: RemoteBrowserStatus = {
      ...pagedStatus,
      activePageId: 'page-1',
      url: 'https://example.test/current',
      title: 'Current page',
    };
    const frameDependencies = withStatus(() => currentStatus);
    const delayed = deferred<{ width: number; height: number; close: () => void }>();
    let decodeCall = 0;
    let delayedClosed = 0;
    globalThis.createImageBitmap = (async () => {
      const call = decodeCall++;
      if (call === 1) return await delayed.promise;
      return { width: 640, height: 360, close: () => undefined, tag: call === 0 ? 'A' : 'B' };
    }) as typeof createImageBitmap;

    const mounted = mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: frameDependencies,
      }),
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;

    // Missing-tag legacy pixels fail closed once an active identity is known.
    socket.emit('message', { data: Uint8Array.of(0xff, 0xd8, 0xff).buffer });
    await flush();
    expect(mounted.canvas.draws).toHaveLength(0);

    socket.emit('message', { data: frameEnvelope('page-1') });
    await flush();
    expect(mounted.canvas.draws).toHaveLength(1);
    expect((mounted.canvas.draws[0]![0] as { tag: string }).tag).toBe('A');

    // This A frame begins decoding while A is current, then B commits before
    // decode resolves. The post-decode identity check must still reject it.
    socket.emit('message', { data: frameEnvelope('page-1', Uint8Array.of(1, 2, 3)) });
    await flush();
    currentStatus = {
      ...pagedStatus,
      activePageId: 'page-2',
      url: 'https://docs.example.test/guide',
      title: 'Guide',
    };
    intervalCallbacks[0]!();
    await flush();
    expect(mounted.canvas.clears).toEqual([[0, 0, 640, 360]]);
    expect(mounted.canvas.draws).toHaveLength(1);

    // A frame arriving after B is committed, plus malformed and overlong tags,
    // are discarded before image decode.
    socket.emit('message', { data: frameEnvelope('page-1', Uint8Array.of(4, 5, 6)) });
    socket.emit('message', { data: frameEnvelope('page-2', undefined, 2) });
    socket.emit('message', { data: frameEnvelope('x'.repeat(BROWSER_MAX_PAGE_ID_LENGTH + 1)) });
    await flush();
    expect(decodeCall).toBe(2);

    delayed.resolve({
      width: 640,
      height: 360,
      close: () => {
        delayedClosed += 1;
      },
    });
    await flush();
    expect(delayedClosed).toBe(1);
    expect(mounted.canvas.draws).toHaveLength(1);

    socket.emit('message', { data: frameEnvelope('page-2', Uint8Array.of(7, 8, 9)) });
    await flush();
    expect(mounted.canvas.draws).toHaveLength(2);
    expect((mounted.canvas.draws[1]![0] as { tag: string }).tag).toBe('B');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('maps pointer and keyboard input to stream protocol messages', async () => {
    mount();
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    const canvas = visit(harness!.output, element => element.type === 'canvas')!;
    const stop = () => undefined;

    (canvas.props!.onPointerDown as (event: Record<string, unknown>) => void)({
      clientX: 210,
      clientY: 120,
      button: 0,
      buttons: 1,
      detail: 1,
      pointerId: 7,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      currentTarget: createCanvas(),
      preventDefault: stop,
      stopPropagation: stop,
    });
    (canvas.props!.onKeyDown as (event: Record<string, unknown>) => void)({
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      keyCode: 37,
      repeat: false,
      location: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      nativeEvent: { isComposing: false },
      preventDefault: stop,
      stopPropagation: stop,
    });

    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      expect.objectContaining({
        kind: 'mouse',
        type: 'mousePressed',
        x: 400,
        y: 200,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        modifiers: 2,
      }),
      expect.objectContaining({ kind: 'key', type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: 8 }),
    ]);
  });

  test('releases pressed keys on canvas blur', async () => {
    mount();
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    const canvas = visit(harness!.output, element => element.type === 'canvas')!;
    const stop = () => undefined;
    (canvas.props!.onKeyDown as (event: Record<string, unknown>) => void)({
      key: 'Shift',
      code: 'ShiftLeft',
      keyCode: 16,
      repeat: false,
      location: 1,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      nativeEvent: { isComposing: false },
      preventDefault: stop,
      stopPropagation: stop,
    });
    (canvas.props!.onBlur as () => void)();

    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      expect.objectContaining({ kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 }),
      expect.objectContaining({ kind: 'key', type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 }),
    ]);
  });

  test('commits mobile IME text once through insertText', async () => {
    mount();
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    const input = visit(harness!.output, element => element.type === 'textarea')!;
    const target = { value: '漢字' };
    const stop = () => undefined;

    (input.props!.onCompositionStart as () => void)();
    (input.props!.onInput as (event: Record<string, unknown>) => void)({
      currentTarget: target,
      nativeEvent: { isComposing: true },
    });
    (input.props!.onCompositionEnd as (event: Record<string, unknown>) => void)({
      data: '漢字',
      currentTarget: target,
      preventDefault: stop,
      stopPropagation: stop,
    });
    (input.props!.onInput as (event: Record<string, unknown>) => void)({
      currentTarget: target,
      nativeEvent: { isComposing: false },
    });

    expect(socket.sent.map(message => JSON.parse(message))).toEqual([{ kind: 'insertText', text: '漢字' }]);
    expect(target.value).toBe('');
  });

  test('deduplicates location notification across an inline state-setting parent callback', async () => {
    let notifications = 0;
    const Parent = () => {
      const [, setLocation] = React.useState<{ url: string; title: string } | null>(null);
      const props: RemoteBrowserPaneProps = {
        sessionId: 'session-1',
        dependencies,
        onLocationChange: location => {
          notifications += 1;
          setLocation({ ...location });
        },
      };
      return RemoteBrowserPane(props);
    };
    mount(Parent);
    await flush();
    expect(notifications).toBe(1);
    expect(visit(harness!.output, element => element.props?.placeholder === 'URL or hostname')?.props?.value).toBe(
      'https://example.test/current',
    );
  });

  test('renders the daemon pages as the only tab strip and marks the shared active target', async () => {
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: pagedDependencies,
      }),
    );
    await flush();

    const strips = collect(harness!.output, element => element.props?.role === 'tablist');
    expect(strips).toHaveLength(1);
    expect(strips[0]!.props?.['aria-label']).toBe('Chrome pages');

    const tabs = collect(harness!.output, element => element.props?.role === 'tab');
    expect(tabs.map(tab => tab.props?.['aria-selected'])).toEqual([false, true, false]);
    // A page with no title falls back to its host, and about:blank reads as a new tab.
    expect(tabs.map(tab => tab.props?.title)).toEqual(['Current page', 'Guide — active shared page', 'New tab']);
    // The active tab is the only one carrying the accent and the roving tabstop.
    expect(tabs.map(tab => tab.props?.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabs[1]!.props?.['data-active']).toBe(true);
    expect(tabs[0]!.props?.['data-active']).toBeUndefined();
    for (const tab of tabs) expect(String(tab.props?.className)).toContain('min-h-[44px]');
  });

  test('marks only the agent page with literal provenance copy', async () => {
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: pagedDependencies,
      }),
    );
    await flush();

    const markers = collect(harness!.output, element => element.props?.title === 'Agent last used this tab.');
    expect(markers).toHaveLength(1);
    expect(visit(markers[0], element => element.props?.children === 'Agent last used this tab.')).toBeDefined();

    // The marker sits inside the agent's page (page-1), not the active one.
    const tabs = collect(harness!.output, element => element.props?.role === 'tab');
    expect(visit(tabs[0], element => element.props?.title === 'Agent last used this tab.')).toBeDefined();
    expect(visit(tabs[1], element => element.props?.title === 'Agent last used this tab.')).toBeUndefined();
  });

  test('keeps honest agent provenance after the daemon keeps a closed page id', async () => {
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: closedAgentPageDependencies,
      }),
    );
    await flush();

    // The marker is neither dropped nor moved onto an unrelated tab.
    expect(collect(harness!.output, element => element.props?.title === 'Agent last used this tab.')).toHaveLength(0);
    expect(
      visit(harness!.output, element => element.props?.children === 'Agent last used a closed tab.'),
    ).toBeDefined();
  });

  test('drives new, activate, and close through the daemon page ids', async () => {
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: pagedDependencies,
      }),
    );
    await flush();

    const tabs = collect(harness!.output, element => element.props?.role === 'tab');
    (tabs[0]!.props!.onClick as () => void)();
    await flush();
    (
      visit(harness!.output, element => element.props?.['aria-label'] === 'Close Guide')!.props!.onClick as () => void
    )();
    await flush();
    (
      visit(harness!.output, element => element.props?.['aria-label'] === 'New Chrome tab')!.props!
        .onClick as () => void
    )();
    await flush();

    expect(apiCalls.pages).toEqual([
      ['activate-page', 'session-1', 'page-1'],
      ['close-page', 'session-1', 'page-2'],
      ['new-page', 'session-1', undefined],
    ]);
  });

  test('sends the same click run on press and release and counts a real double click', async () => {
    testClock = 1_000;
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: clockDependencies,
      }),
    );
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    const canvas = visit(harness!.output, element => element.type === 'canvas')!;
    const stop = () => undefined;
    // A real PointerEvent always reports detail 0, which is why the run has to
    // be tracked from time and distance instead.
    const press = { clientX: 210, clientY: 120, button: 0, buttons: 1, detail: 0, pointerId: 7 };
    const release = { ...press, buttons: 0 };
    const flags = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    const target = createCanvas();
    const tap = () => {
      (canvas.props!.onPointerDown as (event: Record<string, unknown>) => void)({
        ...press,
        ...flags,
        currentTarget: target,
        preventDefault: stop,
        stopPropagation: stop,
      });
      (canvas.props!.onPointerUp as (event: Record<string, unknown>) => void)({
        ...release,
        ...flags,
        currentTarget: target,
        preventDefault: stop,
        stopPropagation: stop,
      });
    };

    tap();
    testClock += 200;
    tap();
    testClock += 5_000;
    tap();

    const sent = socket.sent.map(message => JSON.parse(message) as Record<string, unknown>);
    expect(sent.map(input => [input['type'], input['clickCount']])).toEqual([
      ['mousePressed', 1],
      ['mouseReleased', 1],
      ['mousePressed', 2],
      ['mouseReleased', 2],
      ['mousePressed', 1],
      ['mouseReleased', 1],
    ]);
    // The 800x400 frame is painted into a 400x200 box at (10, 20): a 2:1 downscale.
    expect(sent.every(input => input['x'] === 400 && input['y'] === 200)).toBe(true);
  });

  test('lets the local paste chord reach the canvas instead of forwarding a keystroke', async () => {
    mount();
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    const canvas = visit(harness!.output, element => element.type === 'canvas')!;
    let prevented = 0;
    const chord = {
      key: 'v',
      code: 'KeyV',
      keyCode: 86,
      repeat: false,
      location: 0,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => undefined,
    };

    (canvas.props!.onKeyDown as (event: Record<string, unknown>) => void)(chord);
    (canvas.props!.onKeyUp as (event: Record<string, unknown>) => void)(chord);
    // Cancelling the keydown would cancel the browser's own paste, so the chord
    // must pass through untouched and unsent.
    expect(prevented).toBe(0);
    expect(socket.sent).toEqual([]);

    (canvas.props!.onPaste as (event: Record<string, unknown>) => void)({
      clipboardData: { getData: () => 'pasted text' },
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([{ kind: 'insertText', text: 'pasted text' }]);
  });

  test('does not reset a typed address when the standalone field loses focus', async () => {
    mount();
    await flush();
    const input = visit(harness!.output, element => element.props?.placeholder === 'URL or hostname')!;
    expect(input.props!.onBlur).toBeUndefined();

    (input.props!.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'https://typed.example.test/' },
    });
    await flush();
    expect(visit(harness!.output, element => element.props?.placeholder === 'URL or hostname')!.props!.value).toBe(
      'https://typed.example.test/',
    );
  });

  test('uses the daemon history flags for back and forward', async () => {
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: pagedDependencies,
      }),
    );
    await flush();

    expect(visit(harness!.output, element => element.props?.['aria-label'] === 'Back')!.props!.disabled).toBe(false);
    expect(visit(harness!.output, element => element.props?.['aria-label'] === 'Forward')!.props!.disabled).toBe(true);
  });

  test('shows a visible loading state and a coarse page error from the daemon', async () => {
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: failedPageDependencies,
      }),
    );
    await flush();
    expect(
      visit(
        harness!.output,
        element => element.props?.role === 'alert' && element.props?.children === 'net::ERR_CONNECTION_REFUSED',
      ),
    ).toBeDefined();
    expect(visit(harness!.output, element => element.props?.children === 'Page failed')).toBeDefined();

    harness!.unmount();
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: loadingPageDependencies,
      }),
    );
    await flush();
    expect(visit(harness!.output, element => element.props?.children === 'Loading page…')).toBeDefined();
  });

  test('publishes every committed status snapshot to a parent toolbar', async () => {
    const snapshots: Array<string | undefined> = [];
    mount(() =>
      RemoteBrowserPane({
        sessionId: 'session-1',
        dependencies: pagedDependencies,
        onStatusChange: next => snapshots.push(next.activePageId),
      }),
    );
    await flush();
    expect(snapshots).toEqual(['page-2']);
  });
});
