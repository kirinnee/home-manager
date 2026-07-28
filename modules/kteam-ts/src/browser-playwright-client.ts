import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  BROWSER_MAX_PAGE_ID_LENGTH,
  BrowserError,
  type BrowserInputEvent,
  type BrowserPageActionSnapshot,
  type BrowserPageSummary,
  type BrowserPageSnapshot,
  type BrowserScreencastFrame,
  type BrowserViewport,
} from './browser-types';

const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PAGES = 40;
const MAX_URL = 4_096;
const MAX_TITLE = 500;
const MAX_PAGE_ERROR = 200;
const MAX_SCREENSHOT_BASE64 = 24 * 1024 * 1024;
// Screenshot output is the largest explicit response: allow its 24 MiB base64
// payload plus ample JSON/snapshot overhead, but never retain an unbounded
// newline-free worker record.
const MAX_WORKER_PROTOCOL_LINE = MAX_SCREENSHOT_BASE64 + 2 * 1024 * 1024;

interface WorkerMessage {
  type?: 'ready' | 'fatal' | 'screencast-frame';
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  dataBase64?: string;
  width?: number;
  height?: number;
  pageId?: string;
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/** Page ids are opaque protocol identity, so truncation is never safe: an
 * invalid overlong id can otherwise become the exact prefix of a real page. */
function pageId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= BROWSER_MAX_PAGE_ID_LENGTH ? value : undefined;
}

/**
 * Coarse errors take the first line and only then the length cap, exactly like
 * the worker's own `safeError`. Slicing alone would let a buggy worker smuggle
 * locator snapshots or page text through in the trailing lines of a short first
 * line, and page content must never reach a durable status.
 */
function coarseError(value: unknown): string {
  return typeof value === 'string' ? value.split(/\r?\n|\r/, 1)[0]!.slice(0, MAX_PAGE_ERROR) : '';
}

function workerError(value: unknown): string {
  return coarseError(value) || 'unknown error';
}

/**
 * The worker is a separate process, so its page model is untrusted input: bound
 * every string, cap the tab list, and never let a malformed reply widen the
 * typed snapshot the runtime consumes.
 */
function normalizeSnapshot(value: unknown): BrowserPageSnapshot {
  const raw = (value ?? {}) as Record<string, unknown>;
  const activePageId = pageId(raw['activePageId']);
  if (!activePageId) {
    throw new BrowserError('upstream_failed', 'Playwright worker returned an invalid active page', 502);
  }
  const all = (Array.isArray(raw['pages']) ? raw['pages'] : []).reduce<BrowserPageSummary[]>((pages, item) => {
    const page = (item ?? {}) as Record<string, unknown>;
    const id = pageId(page['id']);
    if (id) {
      pages.push({
        id,
        url: text(page['url'], MAX_URL),
        title: text(page['title'], MAX_TITLE),
      });
    }
    return pages;
  }, []);
  let pages = all.slice(0, MAX_PAGES);
  // The cap must never be what hides the active tab: a popup that arrives past
  // the limit is exactly the one the viewer is looking at. Spend the last slot
  // on it and keep real context order for the rest.
  const active = all.find(page => page.id === activePageId);
  if (active && !pages.includes(active)) pages = [...pages.slice(0, MAX_PAGES - 1), active];
  // An activePageId naming no page at all is not something to paper over: a
  // status built from it would show an address bar and a tab strip that
  // disagree. Fail the request instead of publishing an incoherent snapshot.
  if (!active) {
    throw new BrowserError('upstream_failed', 'Playwright worker returned an unknown active page', 502);
  }
  const state = raw['pageState'];
  const pageError = coarseError(raw['pageError']);
  return {
    // Top-level identity is derived from the active summary so the compat
    // fields can never drift from the tab they claim to describe.
    url: active.url,
    title: active.title,
    pages,
    activePageId,
    pageState: state === 'loading' || state === 'error' ? state : 'ready',
    ...(pageError !== '' ? { pageError } : {}),
    canGoBack: raw['canGoBack'] === true,
    canGoForward: raw['canGoForward'] === true,
  };
}

/**
 * `actedPageId` is validated and bounded on its own, NOT against `pages`: a
 * close legitimately reports a page that no longer exists, and a click reports
 * the opener rather than the popup that is now active. Only its shape is
 * checked; a worker that omits it is refused, because provenance that silently
 * defaults to the active page would misattribute the action.
 */
function normalizeActionSnapshot(value: unknown): BrowserPageActionSnapshot {
  const raw = (value ?? {}) as Record<string, unknown>;
  const actedPageId = pageId(raw['actedPageId']);
  if (!actedPageId) {
    throw new BrowserError('upstream_failed', 'Playwright worker returned no acted page', 502);
  }
  return { ...normalizeSnapshot(raw), actedPageId };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workerEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env['NO_PROXY'] = '127.0.0.1,localhost,::1';
  env['no_proxy'] = env['NO_PROXY'];
  return env;
}

export function resolvePlaywrightWorkerEntry(directory = import.meta.dir): string {
  const besideModule = path.join(directory, 'browser-playwright-worker.mjs');
  if (existsSync(besideModule)) return besideModule;
  throw new BrowserError('launch_failed', `Playwright worker is missing beside ${directory}`, 503);
}

export interface BrowserAutomation {
  readonly unexpectedExit?: Promise<number>;
  navigate(url: string): Promise<BrowserPageActionSnapshot>;
  click(selector: string): Promise<BrowserPageActionSnapshot>;
  type(selector: string, text: string): Promise<BrowserPageActionSnapshot>;
  read(selector?: string): Promise<BrowserPageActionSnapshot & { text: string }>;
  screenshot(): Promise<BrowserPageActionSnapshot & { screenshotBase64: string }>;
  back(): Promise<BrowserPageActionSnapshot>;
  forward(): Promise<BrowserPageActionSnapshot>;
  reload(): Promise<BrowserPageActionSnapshot>;
  /** The only plain sample: a status poll acts on nothing. */
  location(): Promise<BrowserPageSnapshot>;
  newPage(url?: string): Promise<BrowserPageActionSnapshot>;
  activatePage(pageId: string): Promise<BrowserPageActionSnapshot>;
  closePage(pageId: string): Promise<BrowserPageActionSnapshot>;
  resize(viewport: BrowserViewport): Promise<BrowserPageActionSnapshot>;
  startScreencast(viewport: BrowserViewport, listener: (frame: BrowserScreencastFrame) => void): Promise<void>;
  stopScreencast(): Promise<void>;
  dispatchInput(input: BrowserInputEvent): Promise<void>;
  close(): Promise<void>;
}

export class PlaywrightWorkerClient implements BrowserAutomation {
  private nextId = 1;
  private readonly pending = new Map<number, Deferred<unknown>>();
  private readonly ready = deferred<void>();
  private readonly workerExit = deferred<number>();
  private buffer = '';
  private closed = false;
  private closing = false;
  private readyState: 'pending' | 'ready' | 'failed' = 'pending';
  private readonly frameListeners = new Set<(frame: BrowserScreencastFrame) => void>();
  readonly unexpectedExit = this.workerExit.promise;

  private constructor(private readonly child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'ignore'>>) {
    void this.readOutput().catch(() => undefined);
    void child.exited.then(code => {
      const unexpected = !this.closed && !this.closing;
      this.closed = true;
      if (this.readyState === 'pending') {
        this.readyState = 'failed';
        this.ready.reject(new BrowserError('launch_failed', 'Playwright worker exited during launch', 503));
      }
      if (unexpected) this.workerExit.resolve(code);
      const error = new BrowserError('upstream_failed', 'Playwright worker exited', 502);
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    });
  }

  static async connect(
    endpoint: string,
    workerEntry = resolvePlaywrightWorkerEntry(),
  ): Promise<PlaywrightWorkerClient> {
    const child = Bun.spawn([process.env.KTEAM_NODE_BIN ?? 'node', workerEntry, endpoint], {
      cwd: path.dirname(path.dirname(workerEntry)),
      env: workerEnvironment(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const client = new PlaywrightWorkerClient(child);
    try {
      await Promise.race([
        client.ready.promise,
        Bun.sleep(READY_TIMEOUT_MS).then(() => {
          throw new BrowserError('launch_failed', 'Playwright worker did not become ready', 503);
        }),
      ]);
      return client;
    } catch (error) {
      client.closed = true;
      child.kill('SIGTERM');
      throw error;
    }
  }

  private async readOutput(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      this.buffer += decoder.decode(item.value, { stream: true });
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) {
          if (this.buffer.length > MAX_WORKER_PROTOCOL_LINE) this.failProtocolOverflow();
          break;
        }
        if (newline > MAX_WORKER_PROTOCOL_LINE) {
          this.failProtocolOverflow();
          return;
        }
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.onLine(line);
      }
      if (this.closed) return;
    }
  }

  /**
   * A worker speaks JSON lines over stdout. Do not let one malformed record
   * become an unbounded in-memory string: there is no safe resynchronization
   * point before its newline, so terminate this worker and fail every caller.
   */
  private failProtocolOverflow(): void {
    if (this.closed) return;
    const launching = this.readyState === 'pending';
    const error = new BrowserError(
      launching ? 'launch_failed' : 'upstream_failed',
      'Playwright worker emitted an oversized protocol record',
      launching ? 503 : 502,
    );
    this.buffer = '';
    this.closed = true;
    this.frameListeners.clear();
    if (launching) {
      this.readyState = 'failed';
      this.ready.reject(error);
    } else {
      // The worker is being stopped by a protocol violation rather than a
      // normal close, so consumers waiting on this signal must not hang.
      this.workerExit.resolve(-1);
    }
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    try {
      this.child.kill('SIGTERM');
    } catch {
      // The child may have exited between the protocol check and termination.
    }
  }

  private onLine(line: string): void {
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      return;
    }
    if (message.type === 'ready') {
      if (this.readyState !== 'pending') return;
      this.readyState = 'ready';
      this.ready.resolve();
      return;
    }
    if (message.type === 'fatal') {
      if (this.readyState !== 'pending') return;
      this.readyState = 'failed';
      this.ready.reject(
        new BrowserError('launch_failed', `Playwright worker failed: ${workerError(message.error)}`, 503),
      );
      return;
    }
    if (message.type === 'screencast-frame') {
      if (
        typeof message.dataBase64 !== 'string' ||
        message.dataBase64.length > 16 * 1024 * 1024 ||
        !Number.isFinite(message.width) ||
        !Number.isFinite(message.height)
      )
        return;
      const framePageId = pageId(message.pageId);
      const frame: BrowserScreencastFrame = {
        dataBase64: message.dataBase64,
        width: Math.max(1, Math.round(message.width!)),
        height: Math.max(1, Math.round(message.height!)),
        // Frame provenance so a viewer can tell which tab it is watching after
        // a popup rebind. It is opaque identity, not display text: truncating
        // an invalid id could turn it into a real page id's prefix.
        ...(framePageId ? { pageId: framePageId } : {}),
      };
      for (const listener of [...this.frameListeners]) {
        try {
          listener(frame);
        } catch {
          // A failed viewer callback must never stop the JSON-lines reader;
          // pending agent actions share this worker and must keep resolving.
        }
      }
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else
      pending.reject(
        new BrowserError('upstream_failed', `Playwright action failed: ${workerError(message.error)}`, 502),
      );
  }

  private async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new BrowserError('not_running', 'Playwright worker is closed', 409);
    const id = this.nextId++;
    const result = deferred<unknown>();
    this.pending.set(id, result);
    try {
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      await this.child.stdin.flush();
      return (await Promise.race([
        result.promise,
        Bun.sleep(REQUEST_TIMEOUT_MS).then(() => {
          throw new BrowserError('upstream_failed', `Playwright ${method} timed out`, 504);
        }),
      ])) as T;
    } finally {
      this.pending.delete(id);
    }
  }

  private async actionRequest(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<BrowserPageActionSnapshot> {
    return normalizeActionSnapshot(await this.request<unknown>(method, params));
  }

  navigate(url: string) {
    return this.actionRequest('navigate', { url });
  }
  click(selector: string) {
    return this.actionRequest('click', { selector });
  }
  type(selector: string, text: string) {
    return this.actionRequest('type', { selector, text });
  }
  async read(selector?: string) {
    const raw = await this.request<Record<string, unknown>>('read', { selector });
    return { ...normalizeActionSnapshot(raw), text: text(raw?.['text'], 200_000) };
  }
  async screenshot() {
    const raw = await this.request<Record<string, unknown>>('screenshot');
    return {
      ...normalizeActionSnapshot(raw),
      screenshotBase64: text(raw?.['screenshotBase64'], MAX_SCREENSHOT_BASE64),
    };
  }
  back() {
    return this.actionRequest('back');
  }
  forward() {
    return this.actionRequest('forward');
  }
  reload() {
    return this.actionRequest('reload');
  }
  location() {
    return this.request<unknown>('location').then(normalizeSnapshot);
  }
  newPage(url?: string) {
    return this.actionRequest('newPage', url === undefined ? {} : { url });
  }
  activatePage(pageId: string) {
    return this.actionRequest('activatePage', { pageId });
  }
  closePage(pageId: string) {
    return this.actionRequest('closePage', { pageId });
  }
  resize(viewport: BrowserViewport) {
    return this.actionRequest('resize', { width: viewport.width, height: viewport.height });
  }
  async startScreencast(viewport: BrowserViewport, listener: (frame: BrowserScreencastFrame) => void) {
    const first = this.frameListeners.size === 0;
    this.frameListeners.add(listener);
    if (!first) return;
    try {
      await this.request('startScreencast', { width: viewport.width, height: viewport.height });
    } catch (error) {
      this.frameListeners.delete(listener);
      throw error;
    }
  }
  async stopScreencast() {
    if (this.frameListeners.size === 0) return;
    this.frameListeners.clear();
    await this.request('stopScreencast');
  }
  async dispatchInput(input: BrowserInputEvent) {
    await this.request('dispatchInput', { input });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      await this.request('close');
    } catch {
      // Chrome may close the CDP socket before the worker can flush its reply;
      // process termination below is still the bounded source of truth.
    }
    this.closed = true;
    this.frameListeners.clear();
    this.child.stdin.end();
    const exited = await Promise.race([this.child.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
    if (!exited) this.child.kill('SIGTERM');
  }
}
