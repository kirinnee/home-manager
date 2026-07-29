import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserProfile } from './browser-profile';
import { BrowserError } from './browser-types';
import {
  BROWSER_LOGIN_MAX_MINUTES,
  BROWSER_LOGIN_SESSION_ID,
  BROWSER_LOGIN_URL,
  BrowserLoginService,
  VNC_SUPERVISOR_KILL_AFTER_SECONDS,
  generateVncPassword,
  vncSupervisorArguments,
  x11vncLaunchArguments,
  type BrowserLoginChild,
  type BrowserLoginOptions,
  type BrowserLoginRecord,
  type BrowserLoginTimer,
  type SpawnBrowserLoginChild,
} from './browser-login';

const HOSTNAME = 'test-box';
const CHROME_VERSION = 'Google Chrome 141.0.7390.54';
const CHROME_BIN = '/usr/bin/google-chrome';
const X11VNC_BIN = '/usr/bin/x11vnc';
const TIMEOUT_BIN = '/usr/bin/timeout';

const temporaries: string[] = [];

afterEach(async () => {
  for (const directory of temporaries.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kteam-login-test-'));
  temporaries.push(directory);
  return directory;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

interface FakeChild {
  child: BrowserLoginChild;
  signals: Array<NodeJS.Signals | number | undefined>;
  exit: (code: number) => void;
}

/** `exitOnSignal: false` models a viewer-connected x11vnc that ignores the
 *  in-daemon signal, which is what the supervisor exists to bound. */
function fakeChild(pid: number, options: { exitOnSignal?: boolean } = {}): FakeChild {
  const exited = deferred<number>();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  return {
    child: {
      pid,
      exited: exited.promise,
      kill: signal => {
        signals.push(signal);
        if (options.exitOnSignal !== false) exited.resolve(0);
      },
    },
    signals,
    exit: exited.resolve,
  };
}

const isVncArgv = (command: string[]): boolean => command.includes('-passwdfile');

function passwordFileFrom(command: string[]): string {
  return command[command.indexOf('-passwdfile') + 1].slice('rm:'.length);
}

interface Harness {
  service: BrowserLoginService;
  profile: BrowserProfile;
  daemon: string;
  loginFile: string;
  argv: string[][];
  envs: Array<Record<string, string | undefined> | undefined>;
  chromeArgv: () => string[] | undefined;
  vncArgv: () => string[] | undefined;
  chrome: FakeChild;
  vnc: FakeChild;
  spawnCount: () => number;
  fireDeadline: () => Promise<void>;
  deadlineDelays: number[];
  cancelled: () => number;
  evictions: number[];
  passwordFiles: string[];
  passwordFileModes: number[];
  groupSignals: Array<[number, NodeJS.Signals]>;
  advance: (milliseconds: number) => void;
}

interface HarnessOverrides extends Partial<BrowserLoginOptions> {
  /** Replaces the whole spawn; receives the profile path so a test can build the
   *  SingletonLock the readiness poll waits on. */
  spawnFor?: (profile: BrowserProfile, chrome: FakeChild, vnc: FakeChild) => SpawnBrowserLoginChild;
  boundPorts?: Set<number>;
}

/**
 * A harness over a REAL BrowserProfile in a temp dir with both children faked.
 * The Chrome fake creates the SingletonLock symlink the readiness poll waits on;
 * the x11vnc fake deletes the password file exactly as `-passwdfile rm:` does and
 * marks the port bound so the readiness probe can see it.
 */
async function harness(overrides: HarnessOverrides = {}): Promise<Harness> {
  const { spawnFor, boundPorts, ...options } = overrides;
  const daemon = await scratch();
  const profile = new BrowserProfile(daemon, {
    daemonPid: process.pid,
    hostname: HOSTNAME,
    isProcessAlive: () => true,
  });
  const loginFile = path.join(daemon, 'browser', 'login.json');
  const argv: string[][] = [];
  const envs: Array<Record<string, string | undefined> | undefined> = [];
  const chrome = fakeChild(4242);
  const vnc = fakeChild(4243);
  const passwordFiles: string[] = [];
  const passwordFileModes: number[] = [];
  const groupSignals: Array<[number, NodeJS.Signals]> = [];
  const bound = boundPorts ?? new Set<number>();
  let clock = Date.parse('2026-07-28T23:10:00.000Z');
  const deadlineDelays: number[] = [];
  const deadlines: Array<() => void> = [];
  let cancelled = 0;
  const evictions: number[] = [];
  let spawns = 0;

  const inner: SpawnBrowserLoginChild = spawnFor
    ? spawnFor(profile, chrome, vnc)
    : (command, _options) => {
        if (isVncArgv(command)) {
          const file = passwordFileFrom(command);
          passwordFiles.push(file);
          // x11vnc reads the credential, unlinks it itself, then binds the port.
          queueMicrotask(() => {
            void stat(file)
              .then(stats => passwordFileModes.push(stats.mode & 0o777))
              .catch(() => undefined)
              .then(() => rm(file, { force: true }))
              .then(() => {
                bound.add(Number(command[command.indexOf('-rfbport') + 1]));
              });
          });
          return vnc.child;
        }
        // Chrome writes SingletonLock once it owns the user-data-dir.
        queueMicrotask(
          () =>
            void symlink(`${HOSTNAME}-${chrome.child.pid}`, path.join(profile.profile, 'SingletonLock')).catch(
              () => undefined,
            ),
        );
        return chrome.child;
      };

  const spawn: SpawnBrowserLoginChild = (command, spawnOptions) => {
    spawns += 1;
    argv.push(command);
    envs.push(spawnOptions?.env);
    return inner(command, spawnOptions);
  };

  const service = new BrowserLoginService({
    paths: { browserLogin: loginFile },
    profile,
    display: { start: async () => ({ display: ':99', close: async () => undefined }) },
    platform: 'linux',
    spawn,
    chromeExecutable: CHROME_BIN,
    which: command => (command === 'x11vnc' ? X11VNC_BIN : command === 'timeout' ? TIMEOUT_BIN : undefined),
    now: () => clock,
    schedule: (callback, delayMs): BrowserLoginTimer => {
      deadlineDelays.push(delayMs);
      deadlines.push(callback);
      return {
        cancel: () => {
          cancelled += 1;
        },
      };
    },
    // A real clock never advances in a unit test, so every bounded poll would
    // spin forever. Advancing here is what makes the timeouts reachable, and the
    // macrotask yield is what lets the fakes' filesystem work actually land —
    // a microtask-only sleep would drain the whole budget before any I/O ran.
    sleep: async milliseconds => {
      clock += milliseconds;
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    pollIntervalMs: 1,
    windowReadyTimeoutMs: 200,
    passwordReadTimeoutMs: 200,
    vncReadyTimeoutMs: 200,
    freePort: async () => 5951,
    probePort: async port => bound.has(port),
    generatePassword: () => 'Sq7fXk2p',
    readChromeVersion: async () => CHROME_VERSION,
    passwordDirectory: path.join(daemon, 'browser'),
    killGroup: (pgid, signal) => {
      groupSignals.push([pgid, signal]);
      if (pgid === vnc.child.pid) vnc.exit(0);
    },
    hostname: HOSTNAME,
    sshUser: 'kirin',
    agentBrowsers: {
      closeForLoginWindow: async () => {
        evictions.push(spawns);
      },
    },
    ...options,
  });

  return {
    service,
    profile,
    daemon,
    loginFile,
    argv,
    envs,
    chromeArgv: () => argv.find(command => !isVncArgv(command)),
    vncArgv: () => argv.find(isVncArgv),
    chrome,
    vnc,
    spawnCount: () => spawns,
    deadlineDelays,
    cancelled: () => cancelled,
    evictions,
    passwordFiles,
    passwordFileModes,
    groupSignals,
    advance: milliseconds => {
      clock += milliseconds;
    },
    fireDeadline: async () => {
      for (const deadline of deadlines.splice(0)) deadline();
      await service.whenIdle();
    },
  };
}

async function readRecord(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

describe('browser login window argv', () => {
  test('x11vnc binds loopback only, is one-shot, and never carries the password in argv', () => {
    const command = x11vncLaunchArguments(X11VNC_BIN, ':99', 5951, '/run/user/1000/pw', 900);

    expect(command).toEqual([
      X11VNC_BIN,
      '-display',
      ':99',
      '-rfbport',
      '5951',
      '-listen',
      '127.0.0.1',
      '-localhost',
      '-noipv6',
      '-passwdfile',
      'rm:/run/user/1000/pw',
      '-once',
      '-timeout',
      '900',
      '-noremote',
      '-nocmds',
      '-nolookup',
      '-quiet',
    ]);
    for (const forbidden of [
      '-forever',
      '-shared',
      '-passwd',
      '-tightfilexfer',
      '-ultrafilexfer',
      '-gui',
      '-http',
      '-httpport',
      '-ssl',
    ]) {
      expect(command).not.toContain(forbidden);
    }
  });

  test('the supervisor wraps x11vnc in a hard wall-clock duration', () => {
    const inner = x11vncLaunchArguments(X11VNC_BIN, ':99', 5951, '/run/pw', 900);
    const command = vncSupervisorArguments(TIMEOUT_BIN, 900, inner);

    expect(command.slice(0, 4)).toEqual([
      TIMEOUT_BIN,
      '--signal=TERM',
      `--kill-after=${VNC_SUPERVISOR_KILL_AFTER_SECONDS}`,
      '900',
    ]);
    expect(command.slice(4)).toEqual(inner);
    // --foreground would leave the supervisor in the daemon's process group and
    // break the group teardown that stops x11vnc being orphaned.
    expect(command).not.toContain('--foreground');
  });

  test('the login Chrome has no CDP at all and keeps every honest rendering flag', async () => {
    const context = await harness();
    await context.service.start({});

    const command = context.chromeArgv() as string[];
    expect(command).toBeDefined();
    for (const forbidden of [
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      '--disable-gpu',
      '--headless=new',
    ]) {
      expect(command).not.toContain(forbidden);
    }
    expect(command.some(argument => argument.startsWith('--remote-debugging-port'))).toBe(false);
    for (const kept of [
      '--ozone-platform=x11',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--password-store=basic',
      '--no-first-run',
    ]) {
      expect(command).toContain(kept);
    }
    expect(command.at(-1)).toBe(BROWSER_LOGIN_URL);
    expect(command).toContain(`--user-data-dir=${context.profile.profile}`);
    expect(command[0]).toBe(CHROME_BIN);
    // Chrome is a DIRECT child: no supervisor may sit in front of it.
    expect(command[0]).not.toBe(TIMEOUT_BIN);
    // And it is only ever allowed onto the display the daemon owns.
    expect(context.envs[0]?.DISPLAY).toBe(':99');
  });

  test('the spawned VNC command really is the supervised one', async () => {
    const context = await harness();
    await context.service.start({ minutes: 20 });

    const command = context.vncArgv() as string[];
    expect(command[0]).toBe(TIMEOUT_BIN);
    expect(command).toContain('1200');
    expect(command).toContain(X11VNC_BIN);
  });

  test('the generated credential is 8 unambiguous characters', () => {
    const password = generateVncPassword();
    expect(password).toHaveLength(8);
    expect(password).toMatch(/^[a-zA-Z2-9]{8}$/);
    expect(password).not.toMatch(/[0Oo1lI]/);
  });
});

describe('BrowserLoginService.start', () => {
  test('opens a window, holds the lease, and renders a real SSH command', async () => {
    const context = await harness();

    const status = await context.service.start({ minutes: 20 });

    expect(status.state).toBe('open');
    expect(status.profilePrimed).toBe(false);
    expect(Date.parse(status.expiresAt as string) - Date.parse(status.openedAt as string)).toBe(20 * 60_000);
    expect(status.connection).toEqual({
      host: '127.0.0.1',
      port: 5951,
      password: 'Sq7fXk2p',
      sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 kirin@test-box',
    });
    expect(context.deadlineDelays).toEqual([20 * 60_000]);
    expect(context.service.isOpen()).toBe(true);
  });

  test('records the Chrome pid and its version high-water mark on the lease', async () => {
    const context = await harness();
    const metadataFile = path.join(context.daemon, 'browser', 'profile.metadata.json');
    await mkdir(path.dirname(metadataFile), { recursive: true });
    await writeFile(
      metadataFile,
      `${JSON.stringify({ createdChromeVersion: 'Google Chrome 120.0.6099.109', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );

    await context.service.start({});

    const lease = JSON.parse(await readFile(context.profile.leaseFile, 'utf8')) as Record<string, unknown>;
    expect(lease['sessionId']).toBe(BROWSER_LOGIN_SESSION_ID);
    expect(lease['chromePid']).toBe(4242);
    // Even a window closed without priming may have let Chrome migrate the
    // profile, so the major is recorded at spawn rather than only at markPrimed.
    const metadata = await readRecord(metadataFile);
    expect(metadata['latestChromeVersion']).toBe(CHROME_VERSION);
  });

  test('evicts every agent browser before either child is spawned', async () => {
    const context = await harness();
    await context.service.start({});
    // Recorded as the spawn count at eviction time: nothing had been spawned yet.
    expect(context.evictions).toEqual([0]);
  });

  test('the durable record carries pids, port and timestamps and no credential', async () => {
    const context = await harness();
    await context.service.start({});

    const record = await readRecord(context.loginFile);
    expect(Object.keys(record).sort()).toEqual([
      'chromePid',
      'daemonPid',
      'expiresAt',
      'openedAt',
      'port',
      'version',
      'vncPid',
    ]);
    expect(record).not.toHaveProperty('password');
    expect(await readFile(context.loginFile, 'utf8')).not.toContain('Sq7fXk2p');
    expect((record as unknown as BrowserLoginRecord).port).toBe(5951);
    expect((record as unknown as BrowserLoginRecord).vncPid).toBe(4243);
    expect((await stat(context.loginFile)).mode & 0o777).toBe(0o600);
  });

  test('the password file is 0600 while it exists and gone once the window is open', async () => {
    const context = await harness();
    await context.service.start({});

    expect(context.passwordFiles).toHaveLength(1);
    expect(context.passwordFileModes).toEqual([0o600]);
    expect(existsSync(context.passwordFiles[0])).toBe(false);
    // And it never lived in a session directory or in the profile.
    expect(context.passwordFiles[0].startsWith(path.join(context.daemon, 'browser'))).toBe(true);
    expect(context.passwordFiles[0].startsWith(context.profile.profile)).toBe(false);
  });

  test('a second start returns the existing window and spawns nothing new', async () => {
    const context = await harness();
    const first = await context.service.start({});
    const spawnsAfterFirst = context.spawnCount();

    const second = await context.service.start({ minutes: 60 });

    expect(second).toEqual(first);
    expect(context.spawnCount()).toBe(spawnsAfterFirst);
    expect(context.deadlineDelays).toHaveLength(1);
  });

  test('rejects a duration that is not a whole number of minutes within range', async () => {
    const context = await harness();
    for (const minutes of [0, -5, 1.5, BROWSER_LOGIN_MAX_MINUTES + 1, Number.NaN]) {
      const error = await context.service.start({ minutes }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BrowserError);
      expect((error as BrowserError).code).toBe('bad_request');
      expect((error as BrowserError).status).toBe(400);
    }
    expect(context.spawnCount()).toBe(0);
  });

  test('is truthfully unavailable off Linux rather than a generic launch failure', async () => {
    const context = await harness({ platform: 'darwin' });
    const error = await context.service.start({}).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).message).toContain('only on Linux');
    expect(context.spawnCount()).toBe(0);
  });

  test('a missing supervisor fails the open instead of running an unbounded VNC', async () => {
    const context = await harness({ which: command => (command === 'x11vnc' ? X11VNC_BIN : undefined) });
    const error = await context.service.start({}).catch((thrown: unknown) => thrown);
    expect((error as BrowserError).code).toBe('launch_failed');
    expect((error as BrowserError).message).toContain('timeout(1)');
    expect(context.spawnCount()).toBe(0);
  });
});

describe('BrowserLoginService failure handling', () => {
  test('a busy shared profile is surfaced verbatim and never falls back to a session profile', async () => {
    const context = await harness();
    await mkdir(path.join(context.daemon, 'browser'), { recursive: true });
    await writeFile(
      context.profile.leaseFile,
      `${JSON.stringify({
        sessionId: 'other-session',
        daemonPid: process.pid,
        acquiredAt: '2026-07-28T22:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    const error = await context.service.start({}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe('profile_busy');
    expect(context.spawnCount()).toBe(0);
    // The foreign lease is left exactly as it was found.
    const lease = JSON.parse(await readFile(context.profile.leaseFile, 'utf8')) as Record<string, unknown>;
    expect(lease['sessionId']).toBe('other-session');
    const status = await context.service.status();
    expect(status.state).toBe('error');
    expect(status.connection).toBeUndefined();
    expect(status.error).toContain('profile');
    expect(context.service.isOpen()).toBe(false);
  });

  test('Chrome dying before it owns the profile releases the lease and leaves no record', async () => {
    const context = await harness({
      spawnFor: (_profile, _chrome, _vnc) => {
        const dying = fakeChild(4444);
        return command => {
          if (isVncArgv(command)) throw new Error('x11vnc must never be spawned after Chrome failed');
          queueMicrotask(() => dying.exit(1));
          return dying.child;
        };
      },
    });

    const error = await context.service.start({}).catch((thrown: unknown) => thrown);

    expect((error as BrowserError).code).toBe('launch_failed');
    expect(existsSync(context.profile.leaseFile)).toBe(false);
    expect(existsSync(context.loginFile)).toBe(false);
    expect((await context.service.status()).state).toBe('error');
  });

  test('a VNC port that never binds fails the open rather than reporting a truthful-looking window', async () => {
    // The supervised child stays alive and the password file is consumed, but the
    // port is never bound: a deleted password file is not readiness.
    const context = await harness({
      spawnFor: (profile, chrome, vnc) => command => {
        if (isVncArgv(command)) {
          queueMicrotask(() => void rm(passwordFileFrom(command), { force: true }));
          return vnc.child;
        }
        queueMicrotask(
          () =>
            void symlink(`${HOSTNAME}-${chrome.child.pid}`, path.join(profile.profile, 'SingletonLock')).catch(
              () => undefined,
            ),
        );
        return chrome.child;
      },
      vncReadyTimeoutMs: 20,
    });

    const error = await context.service.start({}).catch((thrown: unknown) => thrown);

    expect((error as BrowserError).code).toBe('launch_failed');
    expect((error as BrowserError).message).toContain('5951');
    expect(context.chrome.signals).toContain('SIGTERM');
    expect(context.groupSignals[0]?.[0]).toBe(4243);
    expect(existsSync(context.profile.leaseFile)).toBe(false);
    expect(existsSync(context.loginFile)).toBe(false);
    const status = await context.service.status();
    expect(status.state).toBe('error');
    expect(status.connection).toBeUndefined();
  });

  test('the VNC supervisor dying tears down Chrome and the whole window', async () => {
    const context = await harness({
      spawnFor: (profile, chrome, vnc) => command => {
        if (isVncArgv(command)) {
          queueMicrotask(() => vnc.exit(1));
          return vnc.child;
        }
        queueMicrotask(
          () =>
            void symlink(`${HOSTNAME}-${chrome.child.pid}`, path.join(profile.profile, 'SingletonLock')).catch(
              () => undefined,
            ),
        );
        return chrome.child;
      },
      passwordReadTimeoutMs: 20,
      vncReadyTimeoutMs: 20,
    });

    const error = await context.service.start({}).catch((thrown: unknown) => thrown);

    expect((error as BrowserError).code).toBe('launch_failed');
    expect(context.chrome.signals).toContain('SIGTERM');
    expect(existsSync(context.profile.leaseFile)).toBe(false);
    expect(existsSync(context.loginFile)).toBe(false);
    // No credential file survives a failed open.
    for (const file of context.passwordFiles) expect(existsSync(file)).toBe(false);
  });

  test('an unexpected spawn error becomes a bounded launch_failed, not a raw exception', async () => {
    const context = await harness({
      spawnFor: () => () => {
        throw new Error('spawn EACCES: /usr/bin/google-chrome\n  at somewhere\n  at somewhere else');
      },
    });

    const error = await context.service.start({}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe('launch_failed');
    expect((error as BrowserError).status).toBe(503);
    expect((error as BrowserError).message).not.toContain('\n');
    expect((error as BrowserError).message.length).toBeLessThan(400);
    expect(existsSync(context.profile.leaseFile)).toBe(false);
    const status = await context.service.status();
    expect(status.state).toBe('error');
    expect(status.error).not.toContain('\n');
  });
});

describe('BrowserLoginService.stop and confirm', () => {
  test('stop with primed marks the profile while the lease is still held', async () => {
    const context = await harness();
    await context.service.start({});
    expect(await context.profile.isPrimed()).toBe(false);

    const status = await context.service.stop({ primed: true });

    expect(status.state).toBe('closed');
    expect(status.profilePrimed).toBe(true);
    expect(status.connection).toBeUndefined();
    expect(status.openedAt).toBeUndefined();
    expect(status.expiresAt).toBeUndefined();
    expect(await context.profile.isPrimed()).toBe(true);
    expect(existsSync(context.profile.leaseFile)).toBe(false);
    expect(existsSync(context.loginFile)).toBe(false);
    // The supervisor's whole group goes, so x11vnc cannot be orphaned.
    expect(context.groupSignals[0]).toEqual([4243, 'SIGTERM']);
    expect(context.chrome.signals).toContain('SIGTERM');
    expect(context.service.isOpen()).toBe(false);
  });

  test('stop without primed leaves the marker exactly as it was', async () => {
    const context = await harness();
    await context.service.start({});

    const status = await context.service.stop({});

    expect(status.state).toBe('closed');
    expect(status.profilePrimed).toBe(false);
    expect(await context.profile.isPrimed()).toBe(false);
  });

  test('a failed priming marker is surfaced and never implied to have been recorded', async () => {
    const context = await harness();
    await context.service.start({});
    // The lease disappears under us, so markPrimed's requireOwner refuses.
    await rm(context.profile.leaseFile, { force: true });

    const error = await context.service.stop({ primed: true }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).message).not.toContain('\n');
    // Teardown still happened, and the closed window reports the honest truth.
    expect(await context.profile.isPrimed()).toBe(false);
    expect(existsSync(context.loginFile)).toBe(false);
    expect(context.chrome.signals).toContain('SIGTERM');
    const status = await context.service.status();
    expect(status).toEqual({ state: 'closed', profilePrimed: false });
    expect(context.service.isOpen()).toBe(false);
  });

  test('confirm primes the profile and leaves the window open', async () => {
    const context = await harness();
    await context.service.start({});

    const status = await context.service.confirm();

    expect(status.state).toBe('open');
    expect(status.profilePrimed).toBe(true);
    expect(status.connection?.port).toBe(5951);
    expect(context.chrome.signals).toHaveLength(0);
    expect(existsSync(context.loginFile)).toBe(true);
  });

  test('confirm refuses when no window is open', async () => {
    const context = await harness();
    const error = await context.service.confirm().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe('not_running');
    expect(await context.profile.isPrimed()).toBe(false);
  });

  test('a closed window reports no port, no countdown and no credential', async () => {
    const context = await harness();
    const status = await context.service.status();
    expect(status).toEqual({ state: 'closed', profilePrimed: false });
  });
});

describe('BrowserLoginService deadline and child exits', () => {
  test('expiry tears everything down and primes nothing', async () => {
    const context = await harness();
    await context.service.start({});
    context.advance(20 * 60_000);

    await context.fireDeadline();

    expect(context.groupSignals[0]).toEqual([4243, 'SIGTERM']);
    expect(context.chrome.signals).toContain('SIGTERM');
    expect(existsSync(context.profile.leaseFile)).toBe(false);
    expect(existsSync(context.loginFile)).toBe(false);
    // No human was present to assert a sign-in, so the marker stays as it was.
    expect(await context.profile.isPrimed()).toBe(false);
    expect(await context.service.status()).toEqual({ state: 'closed', profilePrimed: false });
    expect(context.service.isOpen()).toBe(false);
  });

  test('x11vnc exiting on -once closes the window instead of locking agents out until the deadline', async () => {
    const context = await harness();
    await context.service.start({});
    expect(context.service.isOpen()).toBe(true);

    // The human disconnected: -once makes x11vnc exit while the daemon still
    // believes the window is open.
    context.vnc.exit(0);
    await context.service.whenIdle();

    expect(context.service.isOpen()).toBe(false);
    expect(await context.service.status()).toEqual({ state: 'closed', profilePrimed: false });
    expect(context.chrome.signals).toContain('SIGTERM');
    expect(existsSync(context.loginFile)).toBe(false);
    expect(existsSync(context.profile.leaseFile)).toBe(false);
    // The armed deadline is not left running against a window that has gone.
    expect(context.cancelled()).toBe(1);
  });

  test('Chrome exiting on its own closes the window too', async () => {
    const context = await harness();
    await context.service.start({});

    context.chrome.exit(0);
    await context.service.whenIdle();

    expect(await context.service.status()).toEqual({ state: 'closed', profilePrimed: false });
    expect(context.groupSignals[0]?.[1]).toBe('SIGTERM');
  });

  test('a child exit after a queued teardown is a no-op rather than a second teardown', async () => {
    const context = await harness();
    await context.service.start({});
    await context.service.stop({ primed: true });
    const groupSignalsAfterStop = context.groupSignals.length;

    context.chrome.exit(0);
    context.vnc.exit(0);
    await context.service.whenIdle();

    expect(context.groupSignals).toHaveLength(groupSignalsAfterStop);
    expect(await context.profile.isPrimed()).toBe(true);
    expect((await context.service.status()).state).toBe('closed');
  });

  test('a viewer-connected x11vnc that ignores TERM is escalated within the group', async () => {
    const stubborn = fakeChild(4243, { exitOnSignal: false });
    const context = await harness({
      spawnFor: (profile, chrome) => command => {
        if (isVncArgv(command)) {
          queueMicrotask(() => void rm(passwordFileFrom(command), { force: true }));
          return stubborn.child;
        }
        queueMicrotask(
          () =>
            void symlink(`${HOSTNAME}-${chrome.child.pid}`, path.join(profile.profile, 'SingletonLock')).catch(
              () => undefined,
            ),
        );
        return chrome.child;
      },
      probePort: async () => true,
      killGroup: () => undefined,
    });
    await context.service.start({});

    await context.service.stop({});

    // The in-daemon signal is best effort; the supervisor's --kill-after is the
    // real bound, and it keeps applying after the daemon is gone.
    const command = context.vncArgv() as string[];
    expect(command).toContain(`--kill-after=${VNC_SUPERVISOR_KILL_AFTER_SECONDS}`);
    expect((await context.service.status()).state).toBe('closed');
  });

  test('an explicit stop cancels the armed deadline', async () => {
    const context = await harness();
    await context.service.start({});
    await context.service.stop({ primed: true });
    expect(context.cancelled()).toBe(1);
  });

  test('daemon shutdown closes an open window without priming it', async () => {
    const context = await harness();
    await context.service.start({});

    await context.service.close();

    expect(existsSync(context.loginFile)).toBe(false);
    expect(await context.profile.isPrimed()).toBe(false);
    expect((await context.service.status()).state).toBe('closed');
  });
});

describe('BrowserLoginService.reconcile', () => {
  async function record(file: string, value: Partial<BrowserLoginRecord> = {}): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({
        version: 1,
        daemonPid: 999_001,
        chromePid: 999_002,
        vncPid: 999_003,
        port: 5951,
        openedAt: '2026-07-28T23:10:00.000Z',
        expiresAt: '2026-07-28T23:25:00.000Z',
        ...value,
      })}\n`,
      { mode: 0o600 },
    );
  }

  test('kills the orphans a SIGKILLed daemon left behind and unlinks the record', async () => {
    const killed: Array<[number, NodeJS.Signals]> = [];
    const groups: Array<[number, NodeJS.Signals]> = [];
    const alive = new Set([999_002, 999_003]);
    const context = await harness();
    const service = new BrowserLoginService({
      paths: { browserLogin: context.loginFile },
      profile: context.profile,
      display: { start: async () => ({ display: ':99', close: async () => undefined }) },
      platform: 'linux',
      isProcessAlive: pid => alive.has(pid),
      readProcessCommand: pid =>
        pid === 999_002
          ? `/usr/bin/google-chrome --user-data-dir=${context.profile.profile}`
          : '/usr/bin/timeout --signal=TERM --kill-after=10 900 /usr/bin/x11vnc -display :99',
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
        alive.delete(pid);
      },
      killGroup: (pgid, signal) => {
        groups.push([pgid, signal]);
        alive.delete(pgid);
      },
      sleep: async () => undefined,
    });
    await record(context.loginFile);

    await service.reconcile();

    // The exposure goes first, and as a GROUP so timeout cannot orphan x11vnc.
    expect(groups).toEqual([[999_003, 'SIGTERM']]);
    // Chrome is a direct child, so it is signalled directly.
    expect(killed).toEqual([[999_002, 'SIGTERM']]);
    expect(existsSync(context.loginFile)).toBe(false);
  });

  test('a record naming dead pids is unlinked quietly', async () => {
    const killed: number[] = [];
    const context = await harness({
      isProcessAlive: () => false,
      killProcess: pid => killed.push(pid),
      killGroup: pid => killed.push(pid),
    });
    await record(context.loginFile);

    await context.service.reconcile();

    expect(killed).toEqual([]);
    expect(existsSync(context.loginFile)).toBe(false);
  });

  test('never kills a reused pid whose command line does not match the record', async () => {
    const killed: number[] = [];
    const context = await harness({
      isProcessAlive: pid => pid !== 999_001,
      readProcessCommand: () => '/usr/bin/postgres -D /var/lib/postgres',
      killProcess: pid => killed.push(pid),
      killGroup: pid => killed.push(pid),
    });
    await record(context.loginFile);

    await context.service.reconcile();

    expect(killed).toEqual([]);
    expect(existsSync(context.loginFile)).toBe(false);
  });

  test('leaves a window owned by a still-live daemon completely alone', async () => {
    const killed: number[] = [];
    const context = await harness({
      isProcessAlive: () => true,
      killProcess: pid => killed.push(pid),
      killGroup: pid => killed.push(pid),
    });
    await record(context.loginFile);

    await context.service.reconcile();

    expect(killed).toEqual([]);
    expect(existsSync(context.loginFile)).toBe(true);
  });

  test('a missing or malformed record is a no-op', async () => {
    const context = await harness();
    await context.service.reconcile();
    await mkdir(path.dirname(context.loginFile), { recursive: true });
    await writeFile(context.loginFile, 'not json\n');
    await context.service.reconcile();
    expect(existsSync(context.loginFile)).toBe(true);
  });
});
