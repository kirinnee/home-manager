import { createConnection, createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeTextAtomic } from './io';
import { PlaywrightWorkerClient, type BrowserAutomation } from './browser-playwright-client';
import {
  BROWSER_DEFAULT_VIEWPORT,
  BrowserError,
  type BrowserInputEvent,
  type BrowserPageActionSnapshot,
  type BrowserPageSnapshot,
  type BrowserScreencastFrame,
  type BrowserViewport,
} from './browser-types';

const LAUNCH_TIMEOUT_MS = 15_000;
const PROCESS_EXIT_GRACE_MS = 2_000;

export interface BrowserChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface BrowserSpawnOptions {
  env?: Record<string, string | undefined>;
}

export type SpawnBrowserChild = (argv: string[], options?: BrowserSpawnOptions) => BrowserChild;

export interface BrowserRuntimeOptions {
  spawn?: SpawnBrowserChild;
  automationFactory?: (endpoint: string) => Promise<BrowserAutomation>;
  now?: () => number;
  chromeExecutable?: string;
}

export interface BrowserRuntimeMetadata {
  version: 2;
  cdpPort: number;
  chromePid: number;
  startedAt: string;
}

export interface BrowserRuntimeFailure {
  component: 'chrome' | 'playwright';
  code: number;
}

const defaultSpawn: SpawnBrowserChild = (argv, options = {}) => {
  const child = Bun.spawn(argv, {
    env: options.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return {
    pid: child.pid,
    exited: child.exited,
    kill: signal => child.kill(signal),
  };
};

const sleep = (milliseconds: number) => Bun.sleep(milliseconds);

async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForChrome(port: number, child: BrowserChild, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (await portAcceptsConnections(port)) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return true;
      } catch {}
    }
    if (await Promise.race([child.exited.then(() => true), sleep(50).then(() => false)])) return false;
  }
  return false;
}

async function terminate(child: BrowserChild | undefined): Promise<void> {
  if (!child) return;
  // Browser.close() is asked first during normal shutdown. Let Chrome finish
  // flushing its cookie/profile databases before escalating to a signal.
  const naturallyExited = await Promise.race([
    child.exited.then(() => true),
    sleep(PROCESS_EXIT_GRACE_MS).then(() => false),
  ]);
  if (naturallyExited) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const exited = await Promise.race([child.exited.then(() => true), sleep(PROCESS_EXIT_GRACE_MS).then(() => false)]);
  if (exited) return;
  try {
    child.kill('SIGKILL');
  } catch {}
}

function browserEnvironment(): Record<string, string | undefined> {
  // Daemon bearer tokens and teammate capabilities must never reach Chrome.
  const env: Record<string, string | undefined> = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function chromeExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  override = process.env.KTEAM_CHROME_BIN,
): string[] {
  if (override?.trim()) return [override.trim()];
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

export function resolveChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  override = process.env.KTEAM_CHROME_BIN,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const executable = chromeExecutableCandidates(platform, override).find(exists);
  if (executable) return executable;
  throw new BrowserError(
    'launch_failed',
    `Google Chrome was not found for ${platform}; set KTEAM_CHROME_BIN to its executable`,
    503,
  );
}

export function chromeLaunchArguments(
  executable: string,
  profile: string,
  cdpPort: number,
  viewport: BrowserViewport,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const argv = [
    executable,
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--disable-dev-shm-usage',
    '--force-device-scale-factor=1',
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ];
  // Headless Linux often has no Secret Service/keyring. `basic` keeps durable
  // cookies in the already-private 0700 profile; macOS keeps Keychain-backed
  // storage by using Chrome's platform default.
  if (platform === 'linux') argv.splice(argv.length - 1, 0, '--password-store=basic');
  return argv;
}

function safeRuntimeError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BrowserError(
    'launch_failed',
    `remote browser launch failed: ${message.split('\n', 1)[0].slice(0, 500)}`,
    503,
  );
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new BrowserError('bad_request', 'a URL is required', 400);
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  const withScheme = loopback
    ? `http://${trimmed}`
    : /^[a-z][a-z\d+.-]*:/i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BrowserError('bad_request', `invalid browser URL: ${trimmed}`, 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.href !== 'about:blank') {
    throw new BrowserError('bad_request', 'browser navigation supports only HTTP(S) URLs and about:blank', 400);
  }
  return url.href;
}

/** One cross-platform headless Chrome and the Playwright/CDP worker attached to it. */
export class BrowserRuntime {
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private resolveUnexpectedExit!: (failure: BrowserRuntimeFailure) => void;
  readonly unexpectedExit: Promise<BrowserRuntimeFailure>;

  private constructor(
    readonly sessionId: string,
    readonly root: string,
    readonly profile: string,
    readonly metadata: BrowserRuntimeMetadata,
    private readonly chrome: BrowserChild,
    private readonly automation: BrowserAutomation,
    private viewportValue: BrowserViewport,
  ) {
    this.unexpectedExit = new Promise(resolve => {
      this.resolveUnexpectedExit = resolve;
    });
    void chrome.exited.then(code => this.onChildExit('chrome', code));
    if (automation.unexpectedExit) {
      void automation.unexpectedExit.then(code => this.onChildExit('playwright', code));
    }
  }

  private onChildExit(component: BrowserRuntimeFailure['component'], code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveUnexpectedExit({ component, code });
    this.shutdownPromise = this.shutdown();
    void this.shutdownPromise.catch(() => undefined);
  }

  static async launch(
    sessionId: string,
    root: string,
    viewport: BrowserViewport = BROWSER_DEFAULT_VIEWPORT,
    options: BrowserRuntimeOptions = {},
  ): Promise<BrowserRuntime> {
    const spawn = options.spawn ?? defaultSpawn;
    const automationFactory = options.automationFactory ?? (endpoint => PlaywrightWorkerClient.connect(endpoint));
    const now = options.now ?? Date.now;
    const profile = path.join(root, 'profile');
    const runtimeFile = path.join(root, 'runtime.json');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch(() => undefined);
    await chmod(profile, 0o700).catch(() => undefined);
    await rm(path.join(profile, 'DevToolsActivePort'), { force: true });

    let chrome: BrowserChild | undefined;
    let automation: BrowserAutomation | undefined;
    try {
      const cdpPort = await freeLoopbackPort();
      const executable = options.chromeExecutable ?? resolveChromeExecutable();
      chrome = spawn(chromeLaunchArguments(executable, profile, cdpPort, viewport), { env: browserEnvironment() });
      if (!(await waitForChrome(cdpPort, chrome, now() + LAUNCH_TIMEOUT_MS))) {
        throw new BrowserError('launch_failed', 'headless Chrome did not expose its loopback CDP endpoint', 503);
      }
      automation = await automationFactory(`http://127.0.0.1:${cdpPort}`);
      await automation.resize(viewport);
      const metadata: BrowserRuntimeMetadata = {
        version: 2,
        cdpPort,
        chromePid: chrome.pid,
        startedAt: new Date(now()).toISOString(),
      };
      await writeTextAtomic(runtimeFile, `${JSON.stringify(metadata, null, 2)}\n`);
      return new BrowserRuntime(sessionId, root, profile, metadata, chrome, automation, viewport);
    } catch (error) {
      await automation?.close().catch(() => undefined);
      await terminate(chrome);
      await rm(runtimeFile, { force: true });
      throw safeRuntimeError(error);
    }
  }

  get viewport(): BrowserViewport {
    return this.viewportValue;
  }

  private assertOpen(): void {
    if (this.closed) throw new BrowserError('not_running', 'the remote browser is not running', 409);
  }

  async resize(viewport: BrowserViewport): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    const snapshot = await this.automation.resize(viewport);
    this.viewportValue = viewport;
    return snapshot;
  }

  async startScreencast(listener: (frame: BrowserScreencastFrame) => void): Promise<void> {
    this.assertOpen();
    await this.automation.startScreencast(this.viewportValue, listener);
  }

  async stopScreencast(): Promise<void> {
    if (this.closed) return;
    await this.automation.stopScreencast();
  }

  async dispatchInput(input: BrowserInputEvent): Promise<void> {
    this.assertOpen();
    await this.automation.dispatchInput(input);
  }

  async navigate(input: string): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.navigate(normalizeBrowserUrl(input));
  }

  async click(selector: string): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.click(selector);
  }

  async type(selector: string, text: string): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.type(selector, text);
  }

  async read(selector?: string): Promise<BrowserPageActionSnapshot & { text: string }> {
    this.assertOpen();
    return await this.automation.read(selector);
  }

  async screenshot(): Promise<BrowserPageActionSnapshot & { screenshotBase64: string }> {
    this.assertOpen();
    return await this.automation.screenshot();
  }

  async back(): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.back();
  }

  async forward(): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.forward();
  }

  async reload(): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.reload();
  }

  async newPage(input?: string): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.newPage(input === undefined ? undefined : normalizeBrowserUrl(input));
  }

  async activatePage(pageId: string): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.activatePage(pageId);
  }

  async closePage(pageId: string): Promise<BrowserPageActionSnapshot> {
    this.assertOpen();
    return await this.automation.closePage(pageId);
  }

  async location(): Promise<BrowserPageSnapshot> {
    this.assertOpen();
    return await this.automation.location();
  }

  async close(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    if (this.closed) return;
    this.closed = true;
    this.shutdownPromise = this.shutdown();
    return await this.shutdownPromise;
  }

  private async shutdown(): Promise<void> {
    await this.automation.close().catch(() => undefined);
    await terminate(this.chrome);
    await rm(path.join(this.root, 'runtime.json'), { force: true });
  }
}

/** Runtime metadata carries process coordinates only, never browser content. */
export async function readBrowserRuntimeMetadata(root: string): Promise<BrowserRuntimeMetadata | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, 'runtime.json'), 'utf8')) as BrowserRuntimeMetadata;
    return parsed.version === 2 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
