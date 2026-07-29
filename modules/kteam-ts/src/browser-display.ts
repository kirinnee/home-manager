import { existsSync } from 'node:fs';
import path from 'node:path';
import { BrowserError } from './browser-types';

const DEFAULT_SOCKET_DIRECTORY = '/tmp/.X11-unix';
const DEFAULT_FIRST_DISPLAY = 99;
const DEFAULT_LAST_DISPLAY = 199;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const PROCESS_EXIT_GRACE_MS = 1_000;

/** A daemon-owned display. `display` is deliberately never inherited from the environment. */
export interface BrowserDisplay {
  /** The exact value to pass to Chrome as `DISPLAY`, or undefined when no X server is needed. */
  readonly display: string | undefined;
  close(): Promise<void>;
}

export interface BrowserDisplayChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export type SpawnXvfb = (argv: string[]) => BrowserDisplayChild;

export interface BrowserDisplayOptions {
  platform?: NodeJS.Platform;
  /** Overrides KTEAM_XVFB_BIN. Intended for dependency injection in tests. */
  xvfbExecutable?: string;
  which?: (command: string) => string | null | undefined;
  spawn?: SpawnXvfb;
  socketDirectory?: string;
  socketExists?: (socketPath: string) => boolean;
  firstDisplay?: number;
  lastDisplay?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

const defaultSpawn: SpawnXvfb = argv => {
  const child = Bun.spawn(argv, {
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

const defaultSleep = (milliseconds: number): Promise<unknown> => Bun.sleep(milliseconds);

/** Resolve the actual Xvfb binary, rather than assuming a package-specific path. */
export function resolveXvfbExecutable(
  override: string | undefined = process.env.KTEAM_XVFB_BIN,
  which: (command: string) => string | null | undefined = Bun.which,
): string {
  const requested = override?.trim();
  if (requested) {
    const executable = which(requested);
    if (executable) return executable;
    throw new BrowserError('launch_failed', `Xvfb from KTEAM_XVFB_BIN was not found: ${requested}`, 503);
  }
  const executable = which('Xvfb');
  if (executable) return executable;
  throw new BrowserError('launch_failed', 'Xvfb was not found; install it or set KTEAM_XVFB_BIN', 503);
}

function socketPath(socketDirectory: string, displayNumber: number): string {
  return path.join(socketDirectory, `X${displayNumber}`);
}

async function childExited(
  child: BrowserDisplayChild,
  sleep: (milliseconds: number) => Promise<unknown>,
): Promise<boolean> {
  return await Promise.race([child.exited.then(() => true), sleep(0).then(() => false)]);
}

class OwnedBrowserDisplay implements BrowserDisplay {
  readonly display: string;
  private closePromise: Promise<void> | undefined;

  constructor(
    displayNumber: number,
    private readonly child: BrowserDisplayChild,
    private readonly sleep: (milliseconds: number) => Promise<unknown>,
    private readonly onClose: () => void,
  ) {
    this.display = `:${displayNumber}`;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.terminate().finally(this.onClose);
    return this.closePromise;
  }

  private async terminate(): Promise<void> {
    if (await childExited(this.child, this.sleep)) return;
    try {
      this.child.kill('SIGTERM');
    } catch {
      return;
    }
    if (await Promise.race([this.child.exited.then(() => true), this.sleep(PROCESS_EXIT_GRACE_MS).then(() => false)]))
      return;
    try {
      this.child.kill('SIGKILL');
    } catch {}
  }
}

class DirectBrowserDisplay implements BrowserDisplay {
  readonly display = undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly onClose: () => void) {}

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = Promise.resolve().finally(this.onClose);
    return this.closePromise;
  }
}

/**
 * One Xvfb process per daemon. Concurrent starts coalesce so every Linux
 * browser receives the same explicit DISPLAY value; non-Linux callers receive
 * a neutral handle and launch headful Chrome on their native display.
 */
export class BrowserDisplayService {
  private current: BrowserDisplay | undefined;
  private starting: Promise<BrowserDisplay> | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: BrowserDisplayOptions = {}) {}

  async start(): Promise<BrowserDisplay> {
    if (this.closing) await this.closing;
    if (this.current) return this.current;
    if (!this.starting) {
      const pending = this.create();
      this.starting = pending;
      void pending
        .then(display => {
          this.current = display;
        })
        .finally(() => {
          if (this.starting === pending) this.starting = undefined;
        })
        .catch(() => undefined);
    }
    return await this.starting;
  }

  async close(): Promise<void> {
    if (this.closing) return await this.closing;
    const pending = this.starting ?? (this.current ? Promise.resolve(this.current) : undefined);
    if (!pending) return;
    this.closing = pending
      .then(
        display => display.close(),
        () => undefined,
      )
      .finally(() => {
        this.current = undefined;
        this.closing = undefined;
      });
    return await this.closing;
  }

  private async create(): Promise<BrowserDisplay> {
    const platform = this.options.platform ?? process.platform;
    let display: BrowserDisplay;
    const onClose = () => {
      if (this.current === display) this.current = undefined;
    };
    if (platform !== 'linux') {
      display = new DirectBrowserDisplay(onClose);
      return display;
    }

    const socketDirectory = this.options.socketDirectory ?? DEFAULT_SOCKET_DIRECTORY;
    const socketExists = this.options.socketExists ?? existsSync;
    const firstDisplay = this.options.firstDisplay ?? DEFAULT_FIRST_DISPLAY;
    const lastDisplay = this.options.lastDisplay ?? DEFAULT_LAST_DISPLAY;
    const displayNumber = this.findFreeDisplay(socketDirectory, socketExists, firstDisplay, lastDisplay);
    const executable = resolveXvfbExecutable(this.options.xvfbExecutable, this.options.which ?? Bun.which);
    const spawn = this.options.spawn ?? defaultSpawn;
    const sleep = this.options.sleep ?? defaultSleep;
    const child = spawn([executable, `:${displayNumber}`, '-screen', '0', '1920x1280x24', '-nolisten', 'tcp']);
    const readySocket = socketPath(socketDirectory, displayNumber);

    try {
      await this.waitForReady(readySocket, child, socketExists, sleep);
    } catch (error) {
      await new OwnedBrowserDisplay(displayNumber, child, sleep, () => undefined).close();
      throw error;
    }

    display = new OwnedBrowserDisplay(displayNumber, child, sleep, onClose);
    // A display that dies after readiness must never remain cached as usable.
    // Existing Chrome children will report their own exits; the next start
    // gets a fresh Xvfb instead of waiting for a false CDP timeout on :N.
    void child.exited.then(() => {
      if (this.current === display) this.current = undefined;
    });
    return display;
  }

  private findFreeDisplay(
    socketDirectory: string,
    socketExists: (socketPath: string) => boolean,
    firstDisplay: number,
    lastDisplay: number,
  ): number {
    for (let display = firstDisplay; display <= lastDisplay; display += 1) {
      if (!socketExists(socketPath(socketDirectory, display))) return display;
    }
    throw new BrowserError('launch_failed', 'no free X11 display is available for Xvfb', 503);
  }

  private async waitForReady(
    readySocket: string,
    child: BrowserDisplayChild,
    socketExists: (socketPath: string) => boolean,
    sleep: (milliseconds: number) => Promise<unknown>,
  ): Promise<void> {
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await childExited(child, sleep)) {
        throw new BrowserError('launch_failed', `Xvfb exited before display ${readySocket} became ready`, 503);
      }
      if (socketExists(readySocket)) {
        // Check once more after observing the socket: a dead Xvfb must never be
        // reported as a usable display merely because it left a stale socket.
        if (!(await childExited(child, sleep))) return;
        throw new BrowserError('launch_failed', `Xvfb exited before display ${readySocket} became ready`, 503);
      }
      await sleep(pollIntervalMs);
    }
    throw new BrowserError('launch_failed', `Xvfb did not make display ${readySocket} ready before the timeout`, 503);
  }
}
