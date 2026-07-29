/**
 * Daemon-global human browser sign-in window.
 *
 * This is deliberately NOT a `BrowserService` entry. Every method on the managed
 * runtime goes through Playwright, and the whole point of this window is a Chrome
 * with no CDP at all: while it is open there is no automation port to reach, so
 * "the agent is out" is a property of the process, not a promise in a comment.
 *
 * Shape, in one paragraph: one direct-child Chrome on the daemon's existing Xvfb
 * with the three remote-debugging flags entirely absent, one x11vnc bound to IPv4
 * loopback only under a `timeout(1)` supervisor, the existing shared-profile lease
 * held as session `human-login`, a random 8-character VNC credential that lives in
 * memory and in a self-deleting 0600 file, and a hard deadline. Nothing is
 * journaled and no credential is ever written to durable state.
 *
 * The two children are supervised ASYMMETRICALLY, on purpose.
 *
 * Chrome stays a DIRECT child. Wrapping it in `timeout(1)` or `xvfb-run` forwards
 * SIGTERM but not SIGKILL, and teardown escalates to SIGKILL — that orphans the
 * real Chrome and bricks the profile lock. An orphaned Chrome is a lock problem,
 * not an exposure: it has no CDP and, once VNC is gone, no viewer.
 *
 * x11vnc DOES go under `timeout(1)`, because an orphaned x11vnc IS the exposure.
 * `-timeout` is a CONNECT timeout — it exits only if nobody connects within the
 * first N seconds — and `-once` needs a viewer to disconnect. Neither bounds the
 * lifetime of an already-connected session, so with the daemon SIGKILLed, a
 * connected remote desktop of a signed-in browser would survive indefinitely. The
 * supervisor is the hard wall-clock wall, and it survives the daemon's death. An
 * in-daemon timer is never the only deadline. `-once` and `-timeout` stay on as
 * defence in depth. GNU `timeout` puts itself and its child in a fresh process
 * group, so clean teardown signals the GROUP and both die together.
 *
 * What the authorization around this route genuinely buys, stated honestly: a
 * warden runs under a different token and is fully excluded; an honest teammate
 * holding the shared admin bearer cannot stumble into it; a tunnel visitor cannot
 * reach the VNC port because it is loopback-bound and there is no in-daemon
 * proxy. It is NOT a defence against a hostile local agent — every agent on this
 * box runs as the same uid and can read the daemon token. `isHumanAdminActor` is
 * an operational boundary for honest clients, not a cryptographic capability.
 * Nothing in kteam currently defends against a hostile local process, and this
 * module does not pretend otherwise.
 *
 * The VNC password is not optional even though the socket is loopback-only. The
 * threat is not the network: a password-free loopback VNC is an unauthenticated
 * read-write remote desktop available to every local process at exactly the
 * moment the human is typing their password into it.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open as openFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { BrowserDisplayService } from './browser-display';
import type { BrowserProfile, BrowserProfileLease } from './browser-profile';
import { BrowserError, BROWSER_MAX_HEIGHT, BROWSER_MAX_WIDTH } from './browser-types';
import {
  browserEnvironment,
  chromeLaunchArguments,
  readChromeExecutableVersion,
  resolveChromeExecutable,
} from './browser-runtime';
import type { KTeamPaths } from './paths';

/** The lease is taken under this fixed session id: the window is daemon-global. */
export const BROWSER_LOGIN_SESSION_ID = 'human-login';
export const BROWSER_LOGIN_DEFAULT_MINUTES = 15;
export const BROWSER_LOGIN_MAX_MINUTES = 60;
export const BROWSER_LOGIN_URL = 'https://accounts.google.com/';

/** VNC's DES-based auth truncates the secret at 8 bytes; a longer one misleads. */
const PASSWORD_LENGTH = 8;
/** No look-alike glyphs: the human retypes this from a phone screen. */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEFAULT_WINDOW_READY_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_PASSWORD_READ_TIMEOUT_MS = 5_000;
const DEFAULT_VNC_READY_TIMEOUT_MS = 5_000;
/** Chrome is asked to exit gently so it flushes the cookie/profile databases —
 *  those databases are the entire product of this window. */
const CHROME_EXIT_GRACE_MS = 5_000;
const VNC_EXIT_GRACE_MS = 1_000;
/** Bounded escalation inside the supervisor: a wedged x11vnc cannot ignore TERM
 *  forever and still hold the framebuffer open. */
export const VNC_SUPERVISOR_KILL_AFTER_SECONDS = 10;

export type BrowserLoginState = 'closed' | 'opening' | 'open' | 'closing' | 'error';

export interface BrowserLoginConnection {
  host: string;
  port: number;
  password: string;
  /** Rendered with the real port so the human never assembles it by hand. */
  sshTunnel: string;
}

/**
 * The one status shape every route returns. `closed` carries no connection, no
 * `openedAt` and no `expiresAt`: absence renders as absence, never as a stale
 * port or a zeroed countdown.
 */
export interface BrowserLoginStatus {
  state: BrowserLoginState;
  profilePrimed: boolean;
  openedAt?: string;
  expiresAt?: string;
  connection?: BrowserLoginConnection;
  error?: string;
}

/** Durable window state. Pids, port and timestamps only — never a credential. */
export interface BrowserLoginRecord {
  version: 1;
  daemonPid: number;
  chromePid: number;
  vncPid: number;
  port: number;
  openedAt: string;
  expiresAt: string;
}

export interface BrowserLoginChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface BrowserLoginSpawnOptions {
  env?: Record<string, string | undefined>;
}

export type SpawnBrowserLoginChild = (argv: string[], options?: BrowserLoginSpawnOptions) => BrowserLoginChild;

export interface BrowserLoginTimer {
  cancel(): void;
}

export type BrowserLoginScheduler = (callback: () => void, delayMs: number) => BrowserLoginTimer;

/**
 * The `BrowserService` seam, injected rather than imported so this module never
 * depends on the service and the service never depends on it.
 *
 * The lifecycle sets its state to `opening` BEFORE calling this, so the service's
 * own `loginWindowOpen?: () => boolean` predicate is already refusing new starts
 * when eviction runs. There is no separate latch to leak: the predicate flips
 * back on its own once the window is fully closed.
 */
export interface BrowserLoginAgentBrowsers {
  /** Stop every running agent browser and release their leases, terminating
   *  their viewers with a reason that names the login window. The reason string
   *  belongs to the service, so a live `BrowserService` satisfies this as-is. */
  closeForLoginWindow(): Promise<void>;
}

export interface BrowserLoginOptions {
  paths: Pick<KTeamPaths, 'browserLogin'>;
  profile: BrowserProfile;
  display: Pick<BrowserDisplayService, 'start'>;
  agentBrowsers?: BrowserLoginAgentBrowsers;
  platform?: NodeJS.Platform;
  spawn?: SpawnBrowserLoginChild;
  chromeExecutable?: string;
  /** Overrides KTEAM_X11VNC_BIN. Intended for dependency injection in tests. */
  x11vncExecutable?: string;
  /** Overrides KTEAM_TIMEOUT_BIN. Intended for dependency injection in tests. */
  timeoutExecutable?: string;
  which?: (command: string) => string | null | undefined;
  now?: () => number;
  schedule?: BrowserLoginScheduler;
  sleep?: (milliseconds: number) => Promise<unknown>;
  freePort?: () => Promise<number>;
  /** Proves the chosen loopback port is actually bound. A consumed
   *  password file is not readiness, and freePort/bind is a TOCTOU race. */
  probePort?: (port: number) => Promise<boolean>;
  generatePassword?: () => string;
  /** Defaults to XDG_RUNTIME_DIR (tmpfs) and falls back to the browser directory. */
  passwordDirectory?: string;
  /** Chrome's SingletonLock is a symlink to a non-existent target, so readiness
   *  is an `lstat`, never an `existsSync`. */
  lockExists?: (file: string) => boolean;
  readChromeVersion?: (executable: string) => Promise<string>;
  isProcessAlive?: (pid: number) => boolean;
  /** Reads a pid's command line so boot reconciliation never kills a reused pid. */
  readProcessCommand?: (pid: number) => string | undefined;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Signals a whole process group. The VNC supervisor and x11vnc share one, so
   *  teardown takes both down and can never orphan the exposure. */
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  hostname?: string;
  sshUser?: string;
  windowReadyTimeoutMs?: number;
  pollIntervalMs?: number;
  passwordReadTimeoutMs?: number;
  vncReadyTimeoutMs?: number;
}

/** The structural contract the API route consumes. No import in either direction. */
export interface BrowserLoginLifecycle {
  status(): Promise<BrowserLoginStatus>;
  start(options: { minutes?: number }): Promise<BrowserLoginStatus>;
  stop(options: { primed?: boolean }): Promise<BrowserLoginStatus>;
  confirm(): Promise<BrowserLoginStatus>;
}

interface OpenWindow {
  chrome: BrowserLoginChild;
  vnc: BrowserLoginChild;
  lease: BrowserProfileLease;
  chromeVersion: string;
  port: number;
  password: string;
  openedAt: string;
  expiresAt: string;
  timer: BrowserLoginTimer | undefined;
}

const defaultSpawn: SpawnBrowserLoginChild = (argv, options = {}) => {
  const child = Bun.spawn(argv, {
    env: options.env,
    stdin: 'ignore',
    // x11vnc runs -quiet and neither child's output reaches daemon.log: no VNC
    // traffic, framebuffer content, or keystroke ever lands in a log file.
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { pid: child.pid, exited: child.exited, kill: signal => child.kill(signal) };
};

const defaultSchedule: BrowserLoginScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};

const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const defaultReadProcessCommand = (pid: number): string | undefined => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return undefined;
  }
};

const defaultLockExists = (file: string): boolean => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Prove the port is BOUND by trying to bind it ourselves and expecting to fail.
 *
 * A connect-and-drop probe would be a bug, not a check: x11vnc runs `-once`, so a
 * TCP peer that connects and disappears is a viewer that connected and left, and
 * x11vnc would exit — the probe would destroy the window it was verifying.
 *
 * EADDRINUSE means something owns the port. Combined with the caller having just
 * checked that the supervised child is still alive, and with the daemon holding no
 * listener of its own there, that something is x11vnc. If another process had
 * stolen the port in the freePort/bind gap, x11vnc would have failed to bind and
 * exited, which the liveness check catches first.
 */
async function loopbackPortBound(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE'));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(false)));
  });
}

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

export function generateVncPassword(
  randomValues: (buffer: Uint8Array) => Uint8Array = buffer => crypto.getRandomValues(buffer),
): string {
  const limit = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let password = '';
  while (password.length < PASSWORD_LENGTH) {
    // Rejection sampling: a plain modulo would bias the earliest glyphs.
    for (const byte of randomValues(new Uint8Array(PASSWORD_LENGTH))) {
      if (byte >= limit) continue;
      password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === PASSWORD_LENGTH) break;
    }
  }
  return password;
}

/** Resolve the actual x11vnc binary rather than assuming a packaging layout. */
export function resolveX11vncExecutable(
  override: string | undefined = process.env.KTEAM_X11VNC_BIN,
  which: (command: string) => string | null | undefined = Bun.which,
): string {
  const requested = override?.trim();
  if (requested) {
    const executable = which(requested);
    if (executable) return executable;
    throw new BrowserError('launch_failed', `x11vnc from KTEAM_X11VNC_BIN was not found: ${requested}`, 503);
  }
  const executable = which('x11vnc');
  if (executable) return executable;
  throw new BrowserError('launch_failed', 'x11vnc was not found; install it or set KTEAM_X11VNC_BIN', 503);
}

/**
 * x11vnc argv.
 *
 * `-listen 127.0.0.1` chooses the bound interface and `-localhost` chooses the
 * accepted peers: passing only one leaves the other unproven. `-noipv6` is not
 * redundant — without it a second socket appears on `[::1]`, and one provable
 * socket beats two that invite a wrong conclusion.
 *
 * `-once` and x11vnc's connection timeout are defense in depth. A separate
 * wall-clock supervisor is still required because `-timeout` stops applying
 * after a viewer connects.
 *
 * Deliberately absent: `-forever` and `-shared` (a standing multi-viewer remote
 * desktop), `-tightfilexfer` / `-ultrafilexfer` (a file-write primitive into the
 * box over VNC), `-gui`, `-http`, `-ssl`, and above all `-passwd` — argv is
 * readable by every process on the box via `/proc/<pid>/cmdline`, which is the whole
 * reason the credential arrives through `-passwdfile rm:`.
 *
 * Clipboard sync is left at its default (on): it is how the human pastes from a
 * password manager, x11vnc does not log clipboard contents, and kteam never sees
 * them.
 */
export function x11vncLaunchArguments(
  executable: string,
  display: string,
  port: number,
  passwordFile: string,
  timeoutSeconds: number,
): string[] {
  return [
    executable,
    '-display',
    display,
    '-rfbport',
    String(port),
    '-listen',
    '127.0.0.1',
    '-localhost',
    '-noipv6',
    '-passwdfile',
    `rm:${passwordFile}`,
    '-once',
    '-timeout',
    String(Math.max(1, Math.round(timeoutSeconds))),
    '-noremote',
    '-nocmds',
    '-nolookup',
    '-quiet',
  ];
}

/** Resolve GNU timeout(1), the hard wall-clock wall around x11vnc. */
export function resolveTimeoutExecutable(
  override: string | undefined = process.env.KTEAM_TIMEOUT_BIN,
  which: (command: string) => string | null | undefined = Bun.which,
): string {
  const requested = override?.trim();
  if (requested) {
    const executable = which(requested);
    if (executable) return executable;
    throw new BrowserError('launch_failed', `timeout from KTEAM_TIMEOUT_BIN was not found: ${requested}`, 503);
  }
  const executable = which('timeout');
  if (executable) return executable;
  throw new BrowserError('launch_failed', 'timeout(1) was not found; install coreutils or set KTEAM_TIMEOUT_BIN', 503);
}

/**
 * Wrap x11vnc in a hard wall-clock supervisor.
 *
 * This is the ONLY deadline that survives the daemon being SIGKILLed. x11vnc's
 * own `-timeout` stops applying the moment a viewer connects and `-once` needs a
 * disconnect, so without this a connected remote desktop of a signed-in browser
 * would outlive the daemon with nothing left to close it.
 *
 * `--signal=TERM` lets x11vnc restore the X server state it changed;
 * `--kill-after` is the bounded escalation so a wedged x11vnc cannot ignore it.
 * `--foreground` is deliberately NOT passed: without it GNU timeout puts itself
 * and its child in a fresh process group, which is what makes clean teardown able
 * to signal the group and take both down together.
 */
export function vncSupervisorArguments(
  timeoutExecutable: string,
  windowSeconds: number,
  x11vncArgv: string[],
  killAfterSeconds = VNC_SUPERVISOR_KILL_AFTER_SECONDS,
): string[] {
  return [
    timeoutExecutable,
    '--signal=TERM',
    `--kill-after=${Math.max(1, Math.round(killAfterSeconds))}`,
    String(Math.max(1, Math.round(windowSeconds))),
    ...x11vncArgv,
  ];
}

export function browserLoginChromeArguments(
  executable: string,
  profile: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // cdp:false removes --remote-debugging-address, --remote-debugging-port and
  // --remote-allow-origins and changes nothing else. The fingerprint must match
  // the automation sessions exactly, including --password-store=basic and every
  // X11/ANGLE/SwiftShader flag: diverging it is what would make signing in here
  // pointless. `--disable-gpu` is never added — it would change the fingerprint
  // and is not what makes software rendering work.
  return chromeLaunchArguments(
    executable,
    profile,
    0,
    { width: BROWSER_MAX_WIDTH, height: BROWSER_MAX_HEIGHT },
    platform,
    { cdp: false, initialUrl: BROWSER_LOGIN_URL },
  );
}

function parseRecord(value: string): BrowserLoginRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<BrowserLoginRecord>;
    const pid = (candidate: unknown): candidate is number =>
      typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0;
    if (!pid(parsed.daemonPid) || !pid(parsed.chromePid) || !pid(parsed.vncPid) || !pid(parsed.port)) return undefined;
    if (typeof parsed.openedAt !== 'string' || typeof parsed.expiresAt !== 'string') return undefined;
    return {
      version: 1,
      daemonPid: parsed.daemonPid,
      chromePid: parsed.chromePid,
      vncPid: parsed.vncPid,
      port: parsed.port,
      openedAt: parsed.openedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return undefined;
  }
}

function coarse(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n', 1)[0].slice(0, 300);
}

export class BrowserLoginService implements BrowserLoginLifecycle {
  private state: BrowserLoginState = 'closed';
  private window: OpenWindow | undefined;
  private failure: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  private readonly paths: Pick<KTeamPaths, 'browserLogin'>;
  private readonly profile: BrowserProfile;
  private readonly display: Pick<BrowserDisplayService, 'start'>;
  private readonly agentBrowsers: BrowserLoginAgentBrowsers | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly spawn: SpawnBrowserLoginChild;
  private readonly which: (command: string) => string | null | undefined;
  private readonly now: () => number;
  private readonly schedule: BrowserLoginScheduler;
  private readonly sleep: (milliseconds: number) => Promise<unknown>;
  private readonly freePort: () => Promise<number>;
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly generatePassword: () => string;
  private readonly lockExists: (file: string) => boolean;
  private readonly readChromeVersion: (executable: string) => Promise<string>;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly readProcessCommand: (pid: number) => string | undefined;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly killGroup: (pgid: number, signal: NodeJS.Signals) => void;
  private readonly hostname: string;
  private readonly sshUser: string;

  constructor(private readonly options: BrowserLoginOptions) {
    this.paths = options.paths;
    this.profile = options.profile;
    this.display = options.display;
    this.agentBrowsers = options.agentBrowsers;
    this.platform = options.platform ?? process.platform;
    this.spawn = options.spawn ?? defaultSpawn;
    this.which = options.which ?? Bun.which;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.sleep = options.sleep ?? (milliseconds => Bun.sleep(milliseconds));
    this.freePort = options.freePort ?? freeLoopbackPort;
    this.probePort = options.probePort ?? loopbackPortBound;
    this.generatePassword = options.generatePassword ?? (() => generateVncPassword());
    this.lockExists = options.lockExists ?? defaultLockExists;
    this.readChromeVersion = options.readChromeVersion ?? readChromeExecutableVersion;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.readProcessCommand = options.readProcessCommand ?? defaultReadProcessCommand;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    // A negative pid is a process-group signal. GNU timeout makes itself the
    // group leader, so its own pid is the group id.
    this.killGroup = options.killGroup ?? ((pgid, signal) => process.kill(-pgid, signal));
    this.hostname = options.hostname ?? os.hostname();
    this.sshUser = options.sshUser ?? os.userInfo().username;
  }

  /**
   * True while any agent browser action must be refused. `error` is excluded on
   * purpose: a failed open has already torn everything down, so refusing agents
   * afterwards would be a lie about the machine's state.
   */
  isOpen(): boolean {
    return this.state === 'opening' || this.state === 'open' || this.state === 'closing';
  }

  /**
   * Resolves once every queued transition has settled. The deadline timer runs
   * its teardown through the same queue, so this is how a caller — a test, or a
   * shutdown path ordering itself behind an in-flight open — waits for it.
   */
  async whenIdle(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) await this.queue;
  }

  async status(): Promise<BrowserLoginStatus> {
    const profilePrimed = await this.primed();
    const status: BrowserLoginStatus = { state: this.state, profilePrimed };
    const window = this.window;
    if (window && (this.state === 'open' || this.state === 'closing')) {
      status.openedAt = window.openedAt;
      status.expiresAt = window.expiresAt;
    }
    // The credential is offered only while the window is genuinely open. It is
    // returned on GET as well as start: withholding it buys nothing against a
    // local process that can already read the admin token, and it would strand a
    // human whose phone refreshed mid-login with a live window and no password.
    if (window && this.state === 'open') {
      status.connection = {
        host: '127.0.0.1',
        port: window.port,
        password: window.password,
        sshTunnel: `ssh -N -L ${window.port}:127.0.0.1:${window.port} ${this.sshUser}@${this.hostname}`,
      };
    }
    if (this.state === 'error' && this.failure) status.error = this.failure;
    return status;
  }

  async start(options: { minutes?: number } = {}): Promise<BrowserLoginStatus> {
    const minutes = this.normalizeMinutes(options.minutes);
    return await this.serialize(async () => {
      // A second start while open returns the existing window rather than
      // minting a new one, and does not extend the deadline.
      if (this.state === 'open') return await this.status();
      if (this.platform !== 'linux') {
        throw new BrowserError(
          'launch_failed',
          'the human browser login window needs Xvfb and x11vnc and is available only on Linux',
          503,
        );
      }
      return await this.openWindow(minutes);
    });
  }

  async stop(options: { primed?: boolean } = {}): Promise<BrowserLoginStatus> {
    return await this.serialize(async () => {
      if (!this.window) {
        // Nothing to close. Clear a previous failure so a stale error is not
        // reported forever, but never invent a primed marker.
        this.state = 'closed';
        this.failure = undefined;
        return await this.status();
      }
      await this.closeWindow({ primed: options.primed === true });
      return await this.status();
    });
  }

  /**
   * Mark the profile primed while leaving the window open.
   *
   * Priming must happen while the lease is held — `markPrimed` calls
   * `requireOwner` — which is why it is an argument to `stop` and an action here,
   * and never a separate later route.
   */
  async confirm(): Promise<BrowserLoginStatus> {
    return await this.serialize(async () => {
      const window = this.window;
      if (!window || this.state !== 'open') {
        throw new BrowserError('not_running', 'the human browser login window is not open', 409);
      }
      await window.lease.markPrimed(window.chromeVersion);
      return await this.status();
    });
  }

  /**
   * Boot reconciliation for a daemon that was SIGKILLed with a window open.
   *
   * The hard expiry a crash cannot defeat is the external GNU timeout supervisor:
   * x11vnc's own `-timeout` is time-to-first-client only, and `-once` needs a
   * viewer to disconnect, so neither bounds a connected session. Both stay on as
   * defence in depth. This reconciliation is the third layer, and it closes the
   * window early rather than waiting for the supervisor to reach its deadline.
   *
   * An orphaned Chrome is a profile-lock problem rather than an exposure, and
   * `BrowserProfile` already reclaims a dead daemon's lease — the kill here is
   * belt and braces on top of that.
   */
  async reconcile(): Promise<void> {
    const record = await this.readRecord();
    if (!record) return;
    // The recorded daemon is alive: that daemon owns this window, not us.
    if (record.daemonPid !== process.pid && this.isProcessAlive(record.daemonPid)) return;
    // The recorded VNC pid is the supervisor, which is its own group leader, so
    // the whole group goes: killing only timeout would orphan x11vnc itself.
    await this.killOrphan(record.vncPid, 'x11vnc', { group: true });
    await this.killOrphan(record.chromePid, `--user-data-dir=${this.profile.profile}`, { group: false });
    await rm(this.paths.browserLogin, { force: true });
  }

  /** Daemon shutdown. Runs the identical teardown as an explicit stop. */
  async close(): Promise<void> {
    await this.serialize(async () => {
      if (this.window) await this.closeWindow({ primed: false });
    }).catch(() => undefined);
  }

  private normalizeMinutes(value: number | undefined): number {
    if (value === undefined) return BROWSER_LOGIN_DEFAULT_MINUTES;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > BROWSER_LOGIN_MAX_MINUTES) {
      throw new BrowserError(
        'bad_request',
        `the login window duration must be a whole number of minutes between 1 and ${BROWSER_LOGIN_MAX_MINUTES}`,
        400,
      );
    }
    return value;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async primed(): Promise<boolean> {
    try {
      return await this.profile.isPrimed();
    } catch {
      return false;
    }
  }

  private async openWindow(minutes: number): Promise<BrowserLoginStatus> {
    // The state flips before eviction so BrowserService's injected predicate is
    // already refusing new starts: otherwise a browser could start in the gap
    // between stopping the last one and the window existing.
    this.state = 'opening';
    this.failure = undefined;

    let lease: BrowserProfileLease | undefined;
    let chrome: BrowserLoginChild | undefined;
    let vnc: BrowserLoginChild | undefined;
    let passwordFile: string | undefined;

    try {
      await this.agentBrowsers?.closeForLoginWindow();

      const chromeExecutable = this.options.chromeExecutable ?? resolveChromeExecutable(this.platform);
      const vncExecutable = resolveX11vncExecutable(this.options.x11vncExecutable, this.which);
      // Resolved before anything is spawned: a missing supervisor must fail the
      // open, never silently downgrade to an unbounded VNC.
      const supervisorExecutable = resolveTimeoutExecutable(this.options.timeoutExecutable, this.which);
      const chromeVersion = await this.readChromeVersion(chromeExecutable);

      // A profile_busy here is surfaced verbatim. Falling back to a session
      // profile — which prepareLaunch does correctly for ordinary browsing —
      // would silently sign the human into a profile that is then thrown away.
      // That is the worst outcome in this whole design.
      lease = await this.profile.acquire({ sessionId: BROWSER_LOGIN_SESSION_ID, chromeVersion });
      await this.profile.assertChromeVersionCompatible(chromeVersion);
      await lease.cleanupStaleChromeLocks();

      const display = await this.display.start();
      if (!display.display) {
        throw new BrowserError('launch_failed', 'the daemon X display is not available', 503);
      }

      // Chrome stays a DIRECT child. Wrapping it in timeout(1) or xvfb-run would
      // forward SIGTERM but not SIGKILL, and teardown escalates to SIGKILL —
      // that orphans the real process and bricks the profile lock.
      chrome = this.spawn(browserLoginChromeArguments(chromeExecutable, lease.profile, this.platform), {
        env: browserEnvironment(display.display),
      });
      // The version is recorded at spawn, not at priming: even a window closed
      // without a sign-in can have let Chrome migrate the profile, and the
      // high-water mark is what stops an older Chrome opening it later.
      await lease.updateChromePid(chrome.pid, chromeVersion);

      // Wait for the window to actually exist rather than sleeping: starting
      // x11vnc first shows the human a grey screen they will assume is broken.
      await this.waitForChromeWindow(lease.profile, chrome);

      const port = await this.freePort();
      const password = this.generatePassword();
      passwordFile = await this.writePasswordFile(password);
      vnc = this.spawn(
        vncSupervisorArguments(
          supervisorExecutable,
          minutes * 60,
          x11vncLaunchArguments(vncExecutable, display.display, port, passwordFile, minutes * 60),
        ),
        { env: browserEnvironment(display.display) },
      );
      await this.awaitPasswordFileConsumed(passwordFile, vnc);
      passwordFile = undefined;
      // A consumed password file is not readiness. Prove the port actually
      // accepts a connection before anything reports `open` or hands out the
      // credential: freePort/bind is a TOCTOU race, and a truthful-looking open
      // response for a failed bind is exactly the lie this module must not tell.
      await this.waitForVncPort(port, vnc);

      const openedAtMs = this.now();
      const openedAt = new Date(openedAtMs).toISOString();
      const expiresAt = new Date(openedAtMs + minutes * 60_000).toISOString();
      await this.writeRecord({
        version: 1,
        daemonPid: process.pid,
        chromePid: chrome.pid,
        vncPid: vnc.pid,
        port,
        openedAt,
        expiresAt,
      });

      const window: OpenWindow = {
        chrome,
        vnc,
        lease,
        chromeVersion,
        port,
        password,
        openedAt,
        expiresAt,
        timer: undefined,
      };
      // A deadline expiry primes nothing: there is no human present to assert it.
      window.timer = this.schedule(() => {
        void this.serialize(async () => {
          if (this.window === window) await this.closeWindow({ primed: false });
        }).catch(() => undefined);
      }, minutes * 60_000);
      this.window = window;
      this.state = 'open';
      // Either child exiting on its own closes the window promptly. Without this,
      // x11vnc's `-once` exit after the human disconnects would leave the UI
      // saying "open" and every agent locked out until the full deadline.
      this.watchForChildExit(window, window.chrome);
      this.watchForChildExit(window, window.vnc);
      return await this.status();
    } catch (error) {
      // Any failure between eviction and the armed timer runs the identical
      // teardown, including releasing the lease, before the error surfaces.
      await this.teardown({ chrome, vnc, lease, passwordFile });
      this.window = undefined;
      this.state = 'error';
      // An unexpected spawn or filesystem error becomes a bounded launch_failed:
      // a raw multiline exception body, or a generic 500, tells the caller
      // nothing true about the window.
      const failure =
        error instanceof BrowserError
          ? error
          : new BrowserError('launch_failed', `the human browser login window could not open: ${coarse(error)}`, 503);
      this.failure = coarse(failure);
      throw failure;
    }
  }

  /** Identity-checked so a queued teardown makes this a no-op rather than a
   *  second teardown of a window that has already gone. */
  private watchForChildExit(window: OpenWindow, child: BrowserLoginChild): void {
    void child.exited.then(() => {
      void this.serialize(async () => {
        if (this.window !== window) return;
        await this.closeWindow({ primed: false });
      }).catch(() => undefined);
    });
  }

  private async closeWindow(options: { primed: boolean }): Promise<void> {
    const window = this.window;
    if (!window) return;
    this.state = 'closing';
    window.timer?.cancel();
    // Priming happens while the lease is still held, before teardown releases it.
    let primingFailure: unknown;
    if (options.primed) {
      try {
        await window.lease.markPrimed(window.chromeVersion);
      } catch (error) {
        primingFailure = error;
      }
    }
    await this.teardown({ chrome: window.chrome, vnc: window.vnc, lease: window.lease });
    this.window = undefined;
    this.state = 'closed';
    this.failure = undefined;
    // The live remote desktop is torn down first either way, but a failed marker
    // is then surfaced: a response that looks successful would teach the fleet
    // the profile is signed in when nothing recorded that.
    if (primingFailure !== undefined) {
      throw primingFailure instanceof BrowserError
        ? primingFailure
        : new BrowserError(
            'launch_failed',
            `the login window closed but the signed-in marker was not recorded: ${coarse(primingFailure)}`,
            503,
          );
    }
  }

  private async teardown(parts: {
    chrome?: BrowserLoginChild;
    vnc?: BrowserLoginChild;
    lease?: BrowserProfileLease;
    passwordFile?: string;
  }): Promise<void> {
    // x11vnc first: the remote-desktop exposure is the security-critical half and
    // goes away before anything else is attempted.
    await this.terminateSupervisorGroup(parts.vnc);
    await this.terminate(parts.chrome, CHROME_EXIT_GRACE_MS);
    if (parts.passwordFile) await rm(parts.passwordFile, { force: true }).catch(() => undefined);
    if (parts.lease) {
      await parts.lease.updateChromePid(undefined).catch(() => undefined);
      await parts.lease.release().catch(() => undefined);
    }
    await rm(this.paths.browserLogin, { force: true }).catch(() => undefined);
  }

  private async terminate(child: BrowserLoginChild | undefined, graceMs: number): Promise<void> {
    if (!child) return;
    if (await this.exited(child, 0)) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    if (await this.exited(child, graceMs)) return;
    try {
      child.kill('SIGKILL');
    } catch {}
  }

  /**
   * Signal the supervisor's whole process group.
   *
   * Signalling only the `timeout` process risks orphaning x11vnc — the exposure —
   * if the supervisor dies without forwarding. The group is what guarantees both
   * go together. Signalling the direct child is the fallback for the narrow race
   * where timeout has not yet called setpgid and the group id does not exist.
   */
  private async terminateSupervisorGroup(child: BrowserLoginChild | undefined): Promise<void> {
    if (!child) return;
    if (await this.exited(child, 0)) return;
    const signal = (which: NodeJS.Signals): boolean => {
      try {
        this.killGroup(child.pid, which);
        return true;
      } catch {
        try {
          child.kill(which);
          return true;
        } catch {
          return false;
        }
      }
    };
    if (!signal('SIGTERM')) return;
    if (await this.exited(child, VNC_EXIT_GRACE_MS)) return;
    signal('SIGKILL');
  }

  private async exited(child: BrowserLoginChild, milliseconds: number): Promise<boolean> {
    return await Promise.race([child.exited.then(() => true), this.sleep(milliseconds).then(() => false)]);
  }

  private async waitForChromeWindow(profile: string, chrome: BrowserLoginChild): Promise<void> {
    const lock = path.join(profile, 'SingletonLock');
    const timeoutMs = this.options.windowReadyTimeoutMs ?? DEFAULT_WINDOW_READY_TIMEOUT_MS;
    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (await this.exited(chrome, 0)) {
        throw new BrowserError('launch_failed', 'Chrome exited before it owned the shared browser profile', 503);
      }
      if (this.lockExists(lock)) return;
      await this.sleep(pollMs);
    }
    throw new BrowserError('launch_failed', 'Chrome did not open its login window before the timeout', 503);
  }

  private async waitForVncPort(port: number, vnc: BrowserLoginChild): Promise<void> {
    const timeoutMs = this.options.vncReadyTimeoutMs ?? DEFAULT_VNC_READY_TIMEOUT_MS;
    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (await this.exited(vnc, 0)) {
        throw new BrowserError('launch_failed', 'x11vnc exited before it bound its loopback VNC port', 503);
      }
      if (await this.probePort(port)) return;
      await this.sleep(pollMs);
    }
    throw new BrowserError(
      'launch_failed',
      `x11vnc did not accept a connection on loopback port ${port} before the timeout`,
      503,
    );
  }

  private passwordDirectory(): string {
    const override = this.options.passwordDirectory?.trim();
    if (override) return override;
    const runtime = process.env.XDG_RUNTIME_DIR?.trim();
    // tmpfs when available; never a session directory, never the profile.
    if (runtime) return runtime;
    return path.dirname(this.paths.browserLogin);
  }

  private async writePasswordFile(password: string): Promise<string> {
    const directory = this.passwordDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `kteam-login-vnc-${crypto.randomUUID()}.pw`);
    const handle = await openFile(file, 'wx', 0o600);
    try {
      await handle.writeFile(`${password}\n`);
    } finally {
      await handle.close();
    }
    // writeFile's mode is subject to umask; make 0600 an assertion, not a hope.
    await chmod(file, 0o600);
    return file;
  }

  /**
   * `-passwdfile rm:` makes x11vnc unlink the file itself after reading it. We
   * wait for that to happen and force-unlink if it has not: a credential file
   * that outlives the read is exactly what this design promises never to leave.
   */
  private async awaitPasswordFileConsumed(file: string, vnc: BrowserLoginChild): Promise<void> {
    const timeoutMs = this.options.passwordReadTimeoutMs ?? DEFAULT_PASSWORD_READ_TIMEOUT_MS;
    const pollMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = this.now() + timeoutMs;
    try {
      while (this.now() < deadline) {
        if (!existsSync(file)) return;
        if (await this.exited(vnc, 0)) {
          throw new BrowserError('launch_failed', 'x11vnc exited before it opened the loopback VNC port', 503);
        }
        await this.sleep(pollMs);
      }
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  private async killOrphan(pid: number, commandMarker: string, options: { group: boolean }): Promise<void> {
    if (pid === process.pid) return;
    if (!this.isProcessAlive(pid)) return;
    // Pids are reused. Kill only a process whose command line still proves it is
    // the one this record named.
    const command = this.readProcessCommand(pid);
    if (!command || !command.includes(commandMarker)) return;
    const signal = (which: NodeJS.Signals): boolean => {
      try {
        if (options.group) this.killGroup(pid, which);
        else this.killProcess(pid, which);
        return true;
      } catch {
        return false;
      }
    };
    if (!signal('SIGTERM')) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!this.isProcessAlive(pid)) return;
      await this.sleep(100);
    }
    signal('SIGKILL');
  }

  private async readRecord(): Promise<BrowserLoginRecord | undefined> {
    try {
      return parseRecord(await readFile(this.paths.browserLogin, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  private async writeRecord(record: BrowserLoginRecord): Promise<void> {
    await mkdir(path.dirname(this.paths.browserLogin), { recursive: true, mode: 0o700 });
    const temporary = `${this.paths.browserLogin}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.paths.browserLogin);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function createBrowserLoginService(options: BrowserLoginOptions): BrowserLoginService {
  return new BrowserLoginService(options);
}
