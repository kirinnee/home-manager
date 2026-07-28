import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { WebTerminals, type WebTerminalsDependencies } from './WebTerminals';
import { webTerminalApi, type WebTerminal, type WebTerminalList } from '../lib/web-terminals';

// This suite drives the REAL TerminalCanvas effects. TerminalCanvas is not
// exported, so we reach it exactly the way the shell does: render WebTerminals
// through the hook harness, then pull the TerminalCanvas component out of the
// element tree it produced. We then mount that component directly with fully
// faked browser primitives (xterm, FitAddon, WebSocket, ResizeObserver,
// MutationObserver, window/document, host element) so the lifecycle claims the
// static-render test cannot make are exercised against the shipping code.

// ---------------------------------------------------------------------------
// Hook harness (mirrors RemoteBrowserPane.test.tsx)
// ---------------------------------------------------------------------------

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

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Fake browser primitives
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  readonly sent: unknown[] = [];
  readonly closes: Array<[number | undefined, string | undefined]> = [];
  binaryType = 'blob';
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(message: unknown): void {
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

  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: unknown): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(): void {
    this.callback();
  }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  observed: Array<[unknown, unknown]> = [];
  disconnected = false;

  constructor(private readonly callback: () => void) {
    FakeMutationObserver.instances.push(this);
  }

  observe(target: unknown, options: unknown): void {
    this.observed.push([target, options]);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(): void {
    this.callback();
  }
}

class FakeFitAddon {
  fitCalls = 0;
  private term: FakeTerminal | null = null;

  // Real xterm calls activate(terminal) inside loadAddon; our fake mirrors that
  // so fit() can rewrite the terminal's fitted cols/rows.
  activate(term: FakeTerminal): void {
    this.term = term;
  }

  fit(): void {
    this.fitCalls += 1;
    if (this.term) {
      this.term.cols = 120;
      this.term.rows = 40;
    }
  }
}

type Disposable = { dispose(): void; disposed: boolean };

function makeDisposable(): Disposable {
  const disposable: Disposable = {
    disposed: false,
    dispose() {
      disposable.disposed = true;
    },
  };
  return disposable;
}

class FakeTerminal {
  static instances: FakeTerminal[] = [];
  cols = 80;
  rows = 24;
  focusCalls = 0;
  disposed = false;
  options: Record<string, unknown>;
  readonly writes: Uint8Array[] = [];
  readonly addons: FakeFitAddon[] = [];
  hostOpened: unknown = null;
  keyHandler: ((event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; code: string }) => boolean) | null = null;
  dataHandler: ((value: string) => void) | null = null;
  binaryHandler: ((value: string) => void) | null = null;
  selectionHandler: (() => void) | null = null;
  selectionValue = '';
  private hasSelectionValue = false;
  readonly dataDisposable = makeDisposable();
  readonly binaryDisposable = makeDisposable();
  readonly selectionDisposable = makeDisposable();

  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeTerminal.instances.push(this);
  }

  loadAddon(addon: FakeFitAddon): void {
    this.addons.push(addon);
    addon.activate(this);
  }

  open(host: unknown): void {
    this.hostOpened = host;
  }

  focus(): void {
    this.focusCalls += 1;
  }

  attachCustomKeyEventHandler(handler: FakeTerminal['keyHandler']): void {
    this.keyHandler = handler;
  }

  onData(handler: (value: string) => void): Disposable {
    this.dataHandler = handler;
    return this.dataDisposable;
  }

  onBinary(handler: (value: string) => void): Disposable {
    this.binaryHandler = handler;
    return this.binaryDisposable;
  }

  onSelectionChange(handler: () => void): Disposable {
    this.selectionHandler = handler;
    return this.selectionDisposable;
  }

  getSelection(): string {
    return this.selectionValue;
  }

  hasSelection(): boolean {
    return this.hasSelectionValue;
  }

  setSelection(value: string): void {
    this.selectionValue = value;
    this.hasSelectionValue = value.length > 0;
    this.selectionHandler?.();
  }

  write(data: Uint8Array): void {
    this.writes.push(data);
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// window / document doubles
// ---------------------------------------------------------------------------

const timers = {
  timeouts: [] as Array<{ id: number; callback: () => void }>,
  cleared: [] as number[],
  intervals: [] as Array<() => void>,
  nextId: 1,
};

function installGlobals(): void {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  globalThis.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver;
  globalThis.getComputedStyle = (() => ({ getPropertyValue: () => '' })) as unknown as typeof getComputedStyle;
  globalThis.window = {
    setInterval: (callback: () => void) => {
      timers.intervals.push(callback);
      return timers.intervals.length;
    },
    clearInterval: () => undefined,
    setTimeout: (callback: () => void) => {
      const id = timers.nextId++;
      timers.timeouts.push({ id, callback });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.cleared.push(id);
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => undefined,
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    documentElement: {},
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
}

let originalWebSocket: typeof WebSocket | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalMutationObserver: typeof MutationObserver | undefined;
let originalGetComputedStyle: typeof getComputedStyle | undefined;
let originalWindow: typeof window | undefined;
let originalDocument: typeof document | undefined;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const terminal: WebTerminal = {
  id: 't1',
  sessionId: 'ms-test',
  title: 'shell',
  state: 'running',
  cols: 80,
  rows: 24,
  viewers: 1,
  createdAt: '2026-07-28T00:00:00.000Z',
  lastActivityAt: '2026-07-28T00:00:00.000Z',
};

const list: WebTerminalList = {
  sessionId: 'ms-test',
  terminals: [terminal],
  limits: { perSession: 4, global: 8, runningGlobal: 1, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
};

const dependencies: WebTerminalsDependencies = {
  api: { ...webTerminalApi, list: async () => list },
  streamUrl: (sessionId, terminalId) => `ws://terminals.test/${sessionId}/${terminalId}`,
  loadXterm: async () => ({
    Terminal: FakeTerminal as unknown as typeof import('@xterm/xterm').Terminal,
    FitAddon: FakeFitAddon as unknown as typeof import('@xterm/addon-fit').FitAddon,
  }),
};

type TerminalCanvasProps = {
  sessionId: string;
  terminal: WebTerminal;
  active: boolean;
  scrollback: number;
  dependencies: WebTerminalsDependencies;
  onConnection: (state: string) => void;
  onSelection: (selection: string) => void;
};

type TerminalCanvasComponent = (props: TerminalCanvasProps) => unknown;

// Reach the real (unexported) TerminalCanvas via WebTerminals' element tree.
async function terminalCanvasComponent(): Promise<TerminalCanvasComponent> {
  const harness = new HookHarness(() => undefined);
  harness.render(() => WebTerminals({ sessionId: 'ms-test', dependencies }));
  await flush();
  const element = visit(
    harness.output,
    node => typeof node.type === 'function' && typeof node.props?.onConnection === 'function',
  );
  harness.unmount();
  if (!element) throw new Error('TerminalCanvas was not rendered by WebTerminals');
  return element.type as TerminalCanvasComponent;
}

function mountCanvas(
  Component: TerminalCanvasComponent,
  overrides: Partial<TerminalCanvasProps> = {},
): { harness: HookHarness; connection: string[]; selection: string[] } {
  const connection: string[] = [];
  const selection: string[] = [];
  const host = { clientWidth: 640, clientHeight: 480 } as unknown as HTMLDivElement;
  const props: TerminalCanvasProps = {
    sessionId: 'ms-test',
    terminal,
    active: true,
    scrollback: 5_000,
    dependencies,
    onConnection: state => connection.push(state),
    onSelection: value => selection.push(value),
    ...overrides,
  };
  const assignRefs = (tree: unknown) => {
    const hostElement = visit(tree, node => node.type === 'div' && Boolean(node.props?.ref));
    const ref = hostElement?.props?.ref as React.RefObject<HTMLDivElement> | undefined;
    if (ref) ref.current = host;
  };
  const harness = new HookHarness(assignRefs);
  harness.render(() => Component(props));
  return { harness, connection, selection };
}

let TerminalCanvas: TerminalCanvasComponent;

beforeEach(async () => {
  originalWebSocket = globalThis.WebSocket;
  originalResizeObserver = globalThis.ResizeObserver;
  originalMutationObserver = globalThis.MutationObserver;
  originalGetComputedStyle = globalThis.getComputedStyle;
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  FakeWebSocket.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  FakeMutationObserver.instances.length = 0;
  FakeTerminal.instances.length = 0;
  timers.timeouts.length = 0;
  timers.cleared.length = 0;
  timers.intervals.length = 0;
  timers.nextId = 1;
  installGlobals();
  TerminalCanvas = await terminalCanvasComponent();
  // Reset instance trackers dirtied by the extraction render (its TerminalCanvas
  // element is never mounted, so nothing was created — but be defensive).
  FakeWebSocket.instances.length = 0;
  FakeTerminal.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  FakeMutationObserver.instances.length = 0;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket!;
  globalThis.ResizeObserver = originalResizeObserver!;
  globalThis.MutationObserver = originalMutationObserver!;
  globalThis.getComputedStyle = originalGetComputedStyle!;
  globalThis.window = originalWindow!;
  globalThis.document = originalDocument!;
});

describe('TerminalCanvas lifecycle', () => {
  test('never focuses xterm and sends a fitted resize once the socket opens', async () => {
    const mounted = mountCanvas(TerminalCanvas);
    await flush();

    const xterm = FakeTerminal.instances[0]!;
    const socket = FakeWebSocket.instances[0]!;
    expect(xterm).toBeDefined();
    expect(socket).toBeDefined();
    expect(socket.binaryType).toBe('arraybuffer');

    // Selecting/creating a terminal (mounting the active canvas) must not steal
    // the composer's focus.
    expect(xterm.focusCalls).toBe(0);
    expect(mounted.connection).toContain('connecting');

    socket.emit('open');
    expect(mounted.connection).toContain('live');
    // FitAddon.fit() rewrote cols/rows to 120x40; the initial resize must carry
    // those fitted dimensions, not the raw 80x24.
    expect(socket.sent).toContain(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    expect(xterm.focusCalls).toBe(0);
  });

  test('relays onData as UTF-8 binary, preserves onBinary bytes, and writes server frames to xterm', async () => {
    mountCanvas(TerminalCanvas);
    await flush();

    const xterm = FakeTerminal.instances[0]!;
    const socket = FakeWebSocket.instances[0]!;

    xterm.dataHandler!('héllo');
    xterm.binaryHandler!(String.fromCharCode(0, 27, 128, 255, 65));

    const binarySent = socket.sent.filter((message): message is Uint8Array => message instanceof Uint8Array);
    expect(binarySent).toHaveLength(2);
    expect(Array.from(binarySent[0]!)).toEqual(Array.from(new TextEncoder().encode('héllo')));
    expect(Array.from(binarySent[1]!)).toEqual([0, 27, 128, 255, 65]);

    const frame = new Uint8Array([1, 2, 3, 250]);
    socket.emit('message', { data: frame.buffer });
    expect(xterm.writes).toHaveLength(1);
    expect(Array.from(xterm.writes[0]!)).toEqual([1, 2, 3, 250]);
  });

  test('reports selection to the host and tears down socket, listeners, addons, terminal and observers on cleanup', async () => {
    const mounted = mountCanvas(TerminalCanvas);
    await flush();

    const xterm = FakeTerminal.instances[0]!;
    const socket = FakeWebSocket.instances[0]!;
    const resizeObserver = FakeResizeObserver.instances[0]!;
    const themeObserver = FakeMutationObserver.instances[0]!;

    xterm.setSelection('copied text');
    expect(mounted.selection).toContain('copied text');

    mounted.harness.unmount();

    expect(socket.closes).toContainEqual([1000, 'terminal tab detached']);
    expect(xterm.disposed).toBe(true);
    expect(xterm.dataDisposable.disposed).toBe(true);
    expect(xterm.binaryDisposable.disposed).toBe(true);
    expect(xterm.selectionDisposable.disposed).toBe(true);
    expect(resizeObserver.disconnected).toBe(true);
    expect(themeObserver.disconnected).toBe(true);
  });

  test('schedules a reconnect after an abnormal close and cancels it on cleanup', async () => {
    const mounted = mountCanvas(TerminalCanvas);
    await flush();

    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open');
    socket.emit('close', { code: 1006 });

    // A non-1000 close arms exactly one reconnect timer.
    expect(timers.timeouts).toHaveLength(1);
    const reconnectId = timers.timeouts[0]!.id;

    mounted.harness.unmount();

    // Cleanup cancels the pending reconnect; it must never fire.
    expect(timers.cleared).toContain(reconnectId);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
