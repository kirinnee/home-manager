import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  BrowserError,
  type BrowserInputEvent,
  type BrowserScreencastFrame,
  type BrowserViewport,
} from './browser-types';

const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

interface WorkerMessage {
  type?: 'ready' | 'fatal' | 'screencast-frame';
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  dataBase64?: string;
  width?: number;
  height?: number;
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
  navigate(url: string): Promise<{ url: string; title: string }>;
  click(selector: string): Promise<{ url: string; title: string }>;
  type(selector: string, text: string): Promise<{ url: string; title: string }>;
  read(selector?: string): Promise<{ url: string; title: string; text: string }>;
  screenshot(): Promise<{ url: string; title: string; screenshotBase64: string }>;
  back(): Promise<{ url: string; title: string }>;
  forward(): Promise<{ url: string; title: string }>;
  reload(): Promise<{ url: string; title: string }>;
  location(): Promise<{ url: string; title: string }>;
  resize(viewport: BrowserViewport): Promise<void>;
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
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.onLine(line);
        newline = this.buffer.indexOf('\n');
      }
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
        new BrowserError('launch_failed', `Playwright worker failed: ${message.error ?? 'unknown error'}`, 503),
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
      const frame: BrowserScreencastFrame = {
        dataBase64: message.dataBase64,
        width: Math.max(1, Math.round(message.width!)),
        height: Math.max(1, Math.round(message.height!)),
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
        new BrowserError('upstream_failed', `Playwright action failed: ${message.error ?? 'unknown error'}`, 502),
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

  navigate(url: string) {
    return this.request<{ url: string; title: string }>('navigate', { url });
  }
  click(selector: string) {
    return this.request<{ url: string; title: string }>('click', { selector });
  }
  type(selector: string, text: string) {
    return this.request<{ url: string; title: string }>('type', { selector, text });
  }
  read(selector?: string) {
    return this.request<{ url: string; title: string; text: string }>('read', { selector });
  }
  screenshot() {
    return this.request<{ url: string; title: string; screenshotBase64: string }>('screenshot');
  }
  back() {
    return this.request<{ url: string; title: string }>('back');
  }
  forward() {
    return this.request<{ url: string; title: string }>('forward');
  }
  reload() {
    return this.request<{ url: string; title: string }>('reload');
  }
  location() {
    return this.request<{ url: string; title: string }>('location');
  }
  async resize(viewport: BrowserViewport) {
    await this.request('resize', { width: viewport.width, height: viewport.height });
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
