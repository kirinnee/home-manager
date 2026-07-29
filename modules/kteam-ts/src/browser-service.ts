import path from 'node:path';
import { BrowserDisplayService, type BrowserDisplay } from './browser-display';
import {
  BrowserProfileBusyError,
  createBrowserProfile,
  type BrowserProfile,
  type BrowserProfileLease,
} from './browser-profile';
import type { KTeamPaths } from './paths';
import { isSafeSessionId } from './pins-store';
import {
  BrowserRuntime,
  readChromeExecutableVersion,
  resolveChromeExecutable,
  type BrowserRuntimeFailure,
} from './browser-runtime';
import {
  BROWSER_DEFAULT_VIEWPORT,
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_MAX_INSTANCES,
  BrowserError,
  normalizeBrowserViewport,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserActivity,
  type BrowserActorKind,
  type BrowserInputEvent,
  type BrowserPageActionSnapshot,
  type BrowserPageSnapshot,
  type BrowserProfileKind,
  type BrowserScreencastFrame,
  type BrowserStatusView,
  type BrowserViewport,
} from './browser-types';

export interface BrowserSessionRegistry {
  /** Resolve an id or teammate alias to the canonical session id. */
  resolve(sessionRef: string): Promise<string | undefined>;
}

export interface ManagedBrowserRuntime {
  readonly viewport: BrowserViewport;
  readonly unexpectedExit?: Promise<BrowserRuntimeFailure>;
  resize(viewport: BrowserViewport): Promise<BrowserPageActionSnapshot>;
  navigate(url: string): Promise<BrowserPageActionSnapshot>;
  click(selector: string): Promise<BrowserPageActionSnapshot>;
  type(selector: string, text: string): Promise<BrowserPageActionSnapshot>;
  read(selector?: string): Promise<BrowserPageActionSnapshot & { text: string }>;
  screenshot(): Promise<BrowserPageActionSnapshot & { screenshotBase64: string }>;
  back(): Promise<BrowserPageActionSnapshot>;
  forward(): Promise<BrowserPageActionSnapshot>;
  reload(): Promise<BrowserPageActionSnapshot>;
  newPage(url?: string): Promise<BrowserPageActionSnapshot>;
  activatePage(pageId: string): Promise<BrowserPageActionSnapshot>;
  closePage(pageId: string): Promise<BrowserPageActionSnapshot>;
  location(): Promise<BrowserPageSnapshot>;
  startScreencast(listener: (frame: BrowserScreencastFrame) => void): Promise<void>;
  stopScreencast(): Promise<void>;
  dispatchInput(input: BrowserInputEvent): Promise<void>;
  close(): Promise<void>;
}

export type BrowserRuntimeFactory = (
  sessionId: string,
  root: string,
  viewport: BrowserViewport,
  options?: BrowserRuntimeLaunchOptions,
) => Promise<ManagedBrowserRuntime>;

export interface BrowserRuntimeLaunchOptions {
  display?: string;
  profile?: string;
  chromeExecutable?: string;
  onChromeSpawn?: (pid: number) => Promise<void> | void;
}

export interface BrowserChromeInstallation {
  executable: string;
  version: string;
}

export interface BrowserServiceClock {
  now(): number;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface BrowserServiceOptions {
  maximumInstances?: number;
  idleTimeoutMs?: number;
  runtimeFactory?: BrowserRuntimeFactory;
  displayService?: Pick<BrowserDisplayService, 'start' | 'close'>;
  profileService?: BrowserProfile;
  chromeInstallation?: () => Promise<BrowserChromeInstallation>;
  /** True while the human-only, CDP-free login window owns browser control. */
  loginWindowOpen?: () => boolean;
  clock?: BrowserServiceClock;
}

interface RunningBrowser {
  runtime: ManagedBrowserRuntime;
  state: 'running' | 'stopping';
  startedAt: number;
  lastActivityAt: number;
  lastActor?: { kind: BrowserActorKind; at: number; action: BrowserActivity };
  /** The last agent page target. This deliberately survives that page closing. */
  agentPage?: { pageId: string; at: number; action: BrowserActivity };
  viewers: Map<string, BrowserViewer>;
  streamStart?: Promise<void>;
  /** Last coherent worker sample. It is transient and never written to disk. */
  snapshot?: BrowserPageSnapshot;
  /** Concurrent status calls can report a pending navigation without queueing behind it. */
  pendingNavigations: number;
  profileKind?: BrowserProfileKind;
  profileSignedIn?: boolean;
  profileLease?: BrowserProfileLease;
}

interface BrowserLaunchResources {
  display?: BrowserDisplay;
  profileKind?: BrowserProfileKind;
  profileSignedIn?: boolean;
  profileLease?: BrowserProfileLease;
  runtime: BrowserRuntimeLaunchOptions;
}

interface BrowserViewer {
  onFrame(frame: BrowserScreencastFrame): void;
  onTerminal?(terminal: BrowserViewerTerminal): void;
}

interface BrowserFailure {
  at: number;
  message: string;
}

type BrowserOperationResult = BrowserPageActionSnapshot & NonNullable<BrowserActionResult['result']>;

export interface BrowserViewerAttachment {
  id: string;
  detach(): void;
}

export interface BrowserViewerTerminal {
  code: number;
  reason: string;
}

const systemClock: BrowserServiceClock = {
  now: () => Date.now(),
  setInterval: (callback, milliseconds) => {
    const handle = setInterval(callback, milliseconds);
    handle.unref?.();
    return handle;
  },
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n|\r/, 1)[0]!.slice(0, 500);
}

function safePageError(error: string): string {
  return error.split(/\r?\n|\r/, 1)[0]!.slice(0, 200);
}

/**
 * The worker owns page identity. Keep its coherent sample intact, but derive
 * the compatibility URL/title from the declared active page so callers never
 * observe an active id that disagrees with the top-level fields.
 */
function coherentSnapshot(snapshot: BrowserPageSnapshot): BrowserPageSnapshot {
  const pages = snapshot.pages.map(page => ({ ...page }));
  const active = pages.find(page => page.id === snapshot.activePageId);
  if (!active) {
    throw new BrowserError('upstream_failed', 'remote browser returned an invalid active page snapshot', 502);
  }
  const boundedError = snapshot.pageError ? safePageError(snapshot.pageError) : undefined;
  return {
    // Deliberately construct only durable-in-memory status metadata. `snapshot`
    // can be an action response with text, screenshot bytes, and actedPageId;
    // those must stay in its explicit response and never enter entry.snapshot.
    url: active.url,
    title: active.title,
    pages,
    activePageId: snapshot.activePageId,
    pageState: snapshot.pageState,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    ...(boundedError ? { pageError: boundedError } : {}),
  };
}

function isNavigationActivity(action: BrowserActivity): boolean {
  // These verbs preserve active-page identity while a load is in flight. For
  // click/activate/close, a status read must wait for the worker instead: it
  // could otherwise describe the old tab after a popup or selection rebind.
  return action === 'navigate' || action === 'back' || action === 'forward' || action === 'reload';
}

function canHumanInputChangePage(input: BrowserInputEvent): boolean {
  return (
    (input.kind === 'mouse' && input.type === 'mouseReleased') ||
    (input.kind === 'key' && input.type === 'keyUp' && (input.key === 'Enter' || input.code === 'Enter'))
  );
}

function boundHumanInput(input: BrowserInputEvent, viewport: BrowserViewport): BrowserInputEvent {
  if (input.kind !== 'mouse') return input;
  return {
    ...input,
    x: Math.max(0, Math.min(viewport.width - 1, input.x)),
    y: Math.max(0, Math.min(viewport.height - 1, input.y)),
    deltaX: Math.max(-10_000, Math.min(10_000, input.deltaX ?? 0)),
    deltaY: Math.max(-10_000, Math.min(10_000, input.deltaY ?? 0)),
  };
}

/**
 * Daemon-owned lifecycle for all remote browsers.
 *
 * UI unmount only detaches a viewer. Chrome is stopped solely by an explicit
 * stop, daemon shutdown, or the 10-minute no-viewer/no-command idle timeout.
 */
export class BrowserService {
  private readonly entries = new Map<string, RunningBrowser>();
  private readonly starting = new Map<string, Promise<RunningBrowser>>();
  private readonly failures = new Map<string, BrowserFailure>();
  private readonly maximumInstances: number;
  private readonly idleTimeoutMs: number;
  private readonly runtimeFactory: BrowserRuntimeFactory;
  private readonly displayService?: Pick<BrowserDisplayService, 'start' | 'close'>;
  private readonly profileService?: BrowserProfile;
  private readonly chromeInstallation?: () => Promise<BrowserChromeInstallation>;
  private readonly loginWindowOpen?: () => boolean;
  private readonly clock: BrowserServiceClock;
  private readonly sweepTimer: unknown;
  private closed = false;

  constructor(
    private readonly paths: KTeamPaths,
    private readonly sessions: BrowserSessionRegistry,
    options: BrowserServiceOptions = {},
  ) {
    const productionRuntime = options.runtimeFactory === undefined;
    this.maximumInstances = options.maximumInstances ?? BROWSER_MAX_INSTANCES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? BROWSER_IDLE_TIMEOUT_MS;
    this.runtimeFactory =
      options.runtimeFactory ??
      ((sessionId, root, viewport, launch = {}) => BrowserRuntime.launch(sessionId, root, viewport, launch));
    this.displayService = options.displayService ?? (productionRuntime ? new BrowserDisplayService() : undefined);
    this.profileService = options.profileService ?? (productionRuntime ? createBrowserProfile(paths) : undefined);
    this.chromeInstallation =
      options.chromeInstallation ??
      (productionRuntime
        ? async () => {
            const executable = resolveChromeExecutable();
            return { executable, version: await readChromeExecutableVersion(executable) };
          }
        : undefined);
    this.loginWindowOpen = options.loginWindowOpen;
    this.clock = options.clock ?? systemClock;
    this.sweepTimer = this.clock.setInterval(() => void this.sweepIdle(), Math.min(30_000, this.idleTimeoutMs));
  }

  private browserRoot(sessionId: string): string {
    return path.join(this.paths.sessions, sessionId, 'browser');
  }

  private async prepareLaunch(sessionId: string, root: string): Promise<BrowserLaunchResources> {
    const installation = await this.chromeInstallation?.();
    let profileLease: BrowserProfileLease | undefined;
    let profileKind: BrowserProfileKind | undefined;
    let profileSignedIn: boolean | undefined;
    let profile: string | undefined;

    if (this.profileService) {
      try {
        profileLease = await this.profileService.acquire({
          sessionId,
          ...(installation ? { chromeVersion: installation.version } : {}),
        });
        if (installation) await this.profileService.assertChromeVersionCompatible(installation.version);
        await profileLease.cleanupStaleChromeLocks();
        profile = profileLease.profile;
        profileKind = 'shared';
        profileSignedIn = await this.profileService.isPrimed();
      } catch (error) {
        if (!(error instanceof BrowserProfileBusyError) || error.reason !== 'lease') {
          await profileLease?.release().catch(() => undefined);
          throw error;
        }
        // Acquisition itself can race a foreign Chrome appearing before the
        // guarded Singleton cleanup. If that happens after we obtained the
        // lease, release it before deliberately selecting the session profile.
        await profileLease?.release().catch(() => undefined);
        // One user-data-dir can back only one live Chrome. Other sessions keep
        // working against their existing durable per-session profile, and the
        // status contract says plainly that it is not the human-primed one.
        profileLease = undefined;
        profile = path.join(root, 'profile');
        profileKind = 'session';
        profileSignedIn = false;
      }
    }

    try {
      const display = await this.displayService?.start();
      return {
        ...(display ? { display } : {}),
        ...(profileKind ? { profileKind } : {}),
        ...(profileSignedIn === undefined ? {} : { profileSignedIn }),
        ...(profileLease ? { profileLease } : {}),
        runtime: {
          ...(display?.display ? { display: display.display } : {}),
          ...(profile ? { profile } : {}),
          ...(installation ? { chromeExecutable: installation.executable } : {}),
          ...(profileLease && installation
            ? { onChromeSpawn: (pid: number) => profileLease!.updateChromePid(pid, installation.version) }
            : profileLease
              ? { onChromeSpawn: (pid: number) => profileLease!.updateChromePid(pid) }
              : {}),
        },
      };
    } catch (error) {
      await profileLease?.release().catch(() => undefined);
      throw error;
    }
  }

  private async releaseProfile(entry: Pick<RunningBrowser, 'profileLease'>): Promise<void> {
    await entry.profileLease?.release().catch(() => undefined);
  }

  private activeCount(): number {
    // A launch is present in `starting` until start()'s finally block runs, but
    // its fulfilled runtime is inserted into `entries` before the response is
    // rendered. Count session ids, not map slots, or one freshly started
    // browser reports as two and makes the UI's fleet-capacity display lie.
    return new Set([...this.entries.keys(), ...this.starting.keys()]).size;
  }

  async resolveSession(sessionRef: string): Promise<string> {
    const sessionId = await this.sessions.resolve(sessionRef);
    if (!sessionId) throw new BrowserError('not_found', `unknown kteam session: ${sessionRef}`, 404);
    if (!isSafeSessionId(sessionId)) {
      throw new BrowserError('not_found', 'the resolved kteam session id is invalid', 404);
    }
    return sessionId;
  }

  private assertServiceOpen(): void {
    if (this.closed) throw new BrowserError('not_running', 'remote browser service is shutting down', 503);
  }

  private assertAgentControlAvailable(): void {
    if (!this.loginWindowOpen?.()) return;
    throw new BrowserError(
      'login_window_open',
      'the human browser login window is open; agent browser control is unavailable until it closes',
      409,
    );
  }

  private rememberFailure(sessionId: string, error: unknown): void {
    this.failures.delete(sessionId);
    this.failures.set(sessionId, { at: this.clock.now(), message: safeFailure(error) });
    while (this.failures.size > 100) this.failures.delete(this.failures.keys().next().value!);
  }

  private rememberSnapshot<T extends BrowserPageSnapshot>(entry: RunningBrowser, snapshot: T): T {
    const coherent = coherentSnapshot(snapshot);
    entry.snapshot = coherent;
    return { ...snapshot, ...coherent };
  }

  private touch(entry: RunningBrowser, kind: BrowserActorKind, action: BrowserActivity): number {
    const at = this.clock.now();
    entry.lastActivityAt = at;
    entry.lastActor = { kind, at, action };
    return at;
  }

  private rememberAgentPage(
    entry: RunningBrowser,
    actor: BrowserActorKind,
    action: BrowserActivity,
    pageId: string | undefined,
    at: number,
  ): void {
    // Actor provenance comes exclusively from the service/API call context.
    // A page id is opaque browser data, never an actor identity.
    if (actor !== 'agent' || !pageId) return;
    entry.agentPage = { pageId, action, at };
  }

  private terminateViewers(entry: RunningBrowser, terminal: BrowserViewerTerminal): void {
    const viewers = [...entry.viewers.values()];
    entry.viewers.clear();
    for (const viewer of viewers) {
      try {
        viewer.onTerminal?.(terminal);
      } catch {
        // A dead network client must never interrupt lifecycle cleanup for the
        // shared browser or another viewer.
      }
    }
  }

  private async statusFor(sessionId: string, entry?: RunningBrowser): Promise<BrowserStatusView> {
    const now = this.clock.now();
    const starting = this.starting.has(sessionId);
    const failure = this.failures.get(sessionId);
    const state = entry?.state ?? (starting ? 'starting' : failure ? 'error' : 'stopped');
    const view: BrowserStatusView = {
      sessionId,
      state,
      viewport: entry?.runtime.viewport ?? BROWSER_DEFAULT_VIEWPORT,
      viewers: entry?.viewers.size ?? 0,
      persistentProfile: true,
      idleTimeoutSeconds: Math.round(this.idleTimeoutMs / 1_000),
      pages: [],
      capacity: { running: this.activeCount(), maximum: this.maximumInstances },
    };
    if (entry?.profileKind) {
      view.profileKind = entry.profileKind;
      if (entry.profileSignedIn !== undefined) view.profileSignedIn = entry.profileSignedIn;
    } else if (this.profileService) {
      const anotherSessionOwnsShared = [...this.entries.entries()].some(
        ([ownerId, owner]) => ownerId !== sessionId && owner.profileKind === 'shared',
      );
      if (anotherSessionOwnsShared) {
        view.profileKind = 'session';
        view.profileSignedIn = false;
      } else if (this.starting.size === 0) {
        // Stopped status describes the durable profile a first launch will try.
        // While any launch is unresolved the profile choice is unknown, so the
        // optional fields stay absent rather than claiming shared availability.
        view.profileKind = 'shared';
        view.profileSignedIn = await this.profileService.isPrimed();
      }
    }
    if (entry) {
      view.startedAt = new Date(entry.startedAt).toISOString();
      const snapshot = entry.snapshot;
      if (snapshot) {
        view.url = snapshot.url;
        view.title = snapshot.title;
        view.pages = snapshot.pages;
        view.activePageId = snapshot.activePageId;
        view.pageState = entry.pendingNavigations > 0 ? 'loading' : snapshot.pageState;
        view.canGoBack = snapshot.canGoBack;
        view.canGoForward = snapshot.canGoForward;
        if (entry.pendingNavigations === 0 && snapshot.pageError) view.pageError = snapshot.pageError;
      }
      if (entry.viewers.size === 0)
        view.idleDeadline = new Date(entry.lastActivityAt + this.idleTimeoutMs).toISOString();
      if (entry.agentPage) {
        view.agentPage = {
          pageId: entry.agentPage.pageId,
          kind: 'agent',
          action: entry.agentPage.action,
          at: new Date(entry.agentPage.at).toISOString(),
        };
      }
      if (entry.lastActor) {
        view.lastActor = {
          kind: entry.lastActor.kind,
          at: new Date(entry.lastActor.at).toISOString(),
          action: entry.lastActor.action,
        };
      }
    } else if (failure && now - failure.at <= this.idleTimeoutMs) {
      view.error = failure.message;
    }
    return view;
  }

  async status(sessionRef: string): Promise<BrowserStatusView> {
    const sessionId = await this.resolveSession(sessionRef);
    const entry = this.entries.get(sessionId);
    // The worker serializes commands. Do not make a status request queue behind
    // an in-flight navigation: the cached identity plus `loading` is useful
    // feedback while that command is genuinely busy.
    if (entry?.state === 'running' && entry.pendingNavigations === 0) {
      const snapshot = await entry.runtime.location().catch(() => undefined);
      if (snapshot && this.entries.get(sessionId) === entry && entry.state === 'running') {
        try {
          this.rememberSnapshot(entry, snapshot);
        } catch {
          // A malformed transient sample must not replace the last truthful
          // one or make a status read fail closed.
        }
      }
    }
    // The runtime can exit while location() is pending. Re-read the map so the
    // recorded failure wins over the stale entry that handleUnexpectedExit()
    // has already marked as stopping and removed.
    return await this.statusFor(sessionId, this.entries.get(sessionId));
  }

  async start(sessionRef: string, actor: BrowserActorKind): Promise<BrowserStatusView> {
    this.assertServiceOpen();
    this.assertAgentControlAvailable();
    const sessionId = await this.resolveSession(sessionRef);
    // Resolution may await mutable daemon state. A shutdown begun during that
    // await must prevent a late launch from escaping close()'s snapshot.
    this.assertServiceOpen();
    this.assertAgentControlAvailable();
    const existing = this.entries.get(sessionId);
    if (existing) {
      if (existing.pendingNavigations === 0) {
        const snapshot = await existing.runtime.location();
        const current = this.entries.get(sessionId);
        if (current !== existing || current.state !== 'running') return await this.statusFor(sessionId, current);
        this.rememberSnapshot(existing, snapshot);
      }
      this.touch(existing, actor, 'start');
      return await this.statusFor(sessionId, existing);
    }
    const pending = this.starting.get(sessionId);
    if (pending) {
      const launched = await pending;
      const entry = this.entries.get(sessionId);
      if (entry !== launched || entry.state !== 'running') return await this.statusFor(sessionId, entry);
      this.touch(entry, actor, 'start');
      return await this.statusFor(sessionId, entry);
    }
    if (this.activeCount() >= this.maximumInstances) {
      throw new BrowserError(
        'capacity',
        `remote browser capacity reached (${this.maximumInstances} concurrent instances)`,
        429,
      );
    }
    this.failures.delete(sessionId);
    const startedAt = this.clock.now();
    const root = this.browserRoot(sessionId);
    const launch = this.prepareLaunch(sessionId, root).then(async resources => {
      let runtime: ManagedBrowserRuntime | undefined;
      try {
        runtime = await this.runtimeFactory(sessionId, root, BROWSER_DEFAULT_VIEWPORT, resources.runtime);
        const serviceClosed = this.closed;
        const loginBlocked = this.loginWindowOpen?.() === true;
        if (serviceClosed || loginBlocked) {
          await runtime.close().catch(() => undefined);
          if (serviceClosed) throw new BrowserError('not_running', 'remote browser service is shutting down', 503);
          throw new BrowserError(
            'login_window_open',
            'the human browser login window is open; agent browser control is unavailable until it closes',
            409,
          );
        }
        let snapshot: BrowserPageSnapshot;
        try {
          snapshot = coherentSnapshot(await runtime.location());
        } catch (error) {
          await runtime.close().catch(() => undefined);
          throw error;
        }
        const entry: RunningBrowser = {
          runtime,
          state: 'running',
          startedAt,
          lastActivityAt: this.clock.now(),
          viewers: new Map(),
          pendingNavigations: 0,
          snapshot,
          ...(resources.profileKind ? { profileKind: resources.profileKind } : {}),
          ...(resources.profileSignedIn === undefined ? {} : { profileSignedIn: resources.profileSignedIn }),
          ...(resources.profileLease ? { profileLease: resources.profileLease } : {}),
        };
        this.touch(entry, actor, 'start');
        this.entries.set(sessionId, entry);
        if (runtime.unexpectedExit) {
          void runtime.unexpectedExit.then(failure => this.handleUnexpectedExit(sessionId, entry, failure));
        }
        return entry;
      } catch (error) {
        await runtime?.close().catch(() => undefined);
        await resources.profileLease?.release().catch(() => undefined);
        throw error;
      }
    });
    this.starting.set(sessionId, launch);
    try {
      await launch;
      return await this.statusFor(sessionId, this.entries.get(sessionId));
    } catch (error) {
      this.rememberFailure(sessionId, error);
      throw error;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private async handleUnexpectedExit(
    sessionId: string,
    entry: RunningBrowser,
    failure: BrowserRuntimeFailure,
  ): Promise<void> {
    if (this.entries.get(sessionId) !== entry || entry.state !== 'running') return;
    entry.state = 'stopping';
    this.entries.delete(sessionId);
    this.rememberFailure(
      sessionId,
      new BrowserError(
        'upstream_failed',
        `remote browser ${failure.component} process exited unexpectedly (code ${failure.code})`,
        502,
      ),
    );
    this.terminateViewers(entry, { code: 1011, reason: 'remote browser exited' });
    try {
      await entry.runtime.close().catch(() => undefined);
    } finally {
      await this.releaseProfile(entry);
    }
  }

  async stop(sessionRef: string, actor: BrowserActorKind): Promise<BrowserStatusView> {
    const sessionId = await this.resolveSession(sessionRef);
    const pending = this.starting.get(sessionId);
    const entry = this.entries.get(sessionId) ?? (pending ? await pending : undefined);
    if (!entry) {
      this.failures.delete(sessionId);
      return await this.statusFor(sessionId);
    }
    entry.state = 'stopping';
    this.touch(entry, actor, 'stop');
    this.terminateViewers(entry, { code: 1000, reason: 'remote browser stopped' });
    try {
      await entry.runtime.close();
    } finally {
      await this.releaseProfile(entry);
      this.entries.delete(sessionId);
      this.failures.delete(sessionId);
    }
    return await this.statusFor(sessionId);
  }

  private running(sessionId: string): RunningBrowser {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'running') {
      throw new BrowserError('not_running', 'start the remote browser first', 409);
    }
    return entry;
  }

  async attachViewer(
    sessionRef: string,
    onFrame: (frame: BrowserScreencastFrame) => void,
    onTerminal?: (terminal: BrowserViewerTerminal) => void,
  ): Promise<BrowserViewerAttachment> {
    this.assertAgentControlAvailable();
    const sessionId = await this.resolveSession(sessionRef);
    this.assertAgentControlAvailable();
    const entry = this.running(sessionId);
    const id = crypto.randomUUID();
    entry.viewers.set(id, { onFrame, onTerminal });
    entry.lastActivityAt = this.clock.now();
    if (entry.viewers.size === 1) {
      const start = entry.runtime.startScreencast(frame => {
        const current = this.entries.get(sessionId);
        if (current !== entry || entry.state !== 'running') return;
        for (const viewer of [...entry.viewers.values()]) {
          try {
            viewer.onFrame(frame);
          } catch {
            // Viewer transports are isolated: one failed send must not unwind
            // the Playwright worker stdout reader or starve sibling viewers.
          }
        }
      });
      entry.streamStart = start;
    }
    try {
      await entry.streamStart;
    } catch (error) {
      entry.viewers.delete(id);
      // A worker can partially enable screencasting before startup rejects.
      // If every waiter is now gone, compensate even though there is no
      // attachment object whose detach() could perform the cleanup.
      if (entry.viewers.size === 0) await entry.runtime.stopScreencast().catch(() => undefined);
      throw error;
    } finally {
      if (entry.streamStart) entry.streamStart = undefined;
    }
    let attached = true;
    return {
      id,
      detach: () => {
        if (!attached) return;
        attached = false;
        const current = this.entries.get(sessionId);
        // A lifecycle terminal notification clears the map first. A stale
        // attachment must not stop screencasting on a newly restarted entry or
        // race several stopScreencast calls during runtime teardown.
        if (!current?.viewers.delete(id)) return;
        current.lastActivityAt = this.clock.now();
        if (current.viewers.size === 0) void current.runtime.stopScreencast().catch(() => undefined);
      },
    };
  }

  async dispatchHumanInput(sessionRef: string, input: BrowserInputEvent): Promise<void> {
    this.assertAgentControlAvailable();
    const sessionId = await this.resolveSession(sessionRef);
    this.assertAgentControlAvailable();
    const entry = this.running(sessionId);
    await entry.runtime.dispatchInput(boundHumanInput(input, entry.runtime.viewport));
    // The hot stream includes mouse moves and key repeats, so do not make each
    // input pay for title/history sampling. A click release or Enter release
    // can actually change tabs; refresh only for those terminal events.
    if (canHumanInputChangePage(input)) {
      const snapshot = await entry.runtime.location().catch(() => undefined);
      if (snapshot && this.entries.get(sessionId) === entry && entry.state === 'running') {
        try {
          this.rememberSnapshot(entry, snapshot);
        } catch {
          // Keep the last coherent sample if a transient worker reply is bad.
        }
      }
    }
    this.touch(entry, 'human', input.kind === 'mouse' ? 'pointer' : input.kind === 'key' ? 'keyboard' : 'paste');
  }

  async noteHumanActivity(sessionRef: string, action: 'pointer' | 'keyboard' | 'paste'): Promise<BrowserStatusView> {
    const sessionId = await this.resolveSession(sessionRef);
    const entry = this.running(sessionId);
    this.touch(entry, 'human', action);
    return await this.statusFor(sessionId, entry);
  }

  private async agentResult(
    sessionId: string,
    action: BrowserActivity,
    actor: BrowserActorKind,
    operation: (runtime: ManagedBrowserRuntime) => Promise<BrowserOperationResult>,
  ): Promise<BrowserActionResult> {
    const entry = this.running(sessionId);
    const navigation = isNavigationActivity(action);
    if (navigation) entry.pendingNavigations += 1;
    let result: BrowserOperationResult;
    try {
      result = this.rememberSnapshot(entry, await operation(entry.runtime));
    } finally {
      if (navigation) entry.pendingNavigations = Math.max(0, entry.pendingNavigations - 1);
    }
    const current = this.entries.get(sessionId);
    if (current !== entry || current.state !== 'running') {
      return { status: await this.statusFor(sessionId, current), result };
    }
    const at = this.touch(current, actor, action);
    // The worker serializes selection and the verb, so this identity is atomic
    // even when a click opens a popup or a close selects a neighbour.
    this.rememberAgentPage(current, actor, action, result.actedPageId, at);
    return { status: await this.statusFor(sessionId, current), result };
  }

  async act(sessionRef: string, action: BrowserAction, actor: BrowserActorKind): Promise<BrowserActionResult> {
    this.assertAgentControlAvailable();
    const sessionId = await this.resolveSession(sessionRef);
    this.assertAgentControlAvailable();
    switch (action.action) {
      case 'start':
        return { status: await this.start(sessionId, actor) };
      case 'open': {
        await this.start(sessionId, actor);
        if (!action.url) return { status: await this.statusFor(sessionId, this.running(sessionId)) };
        return await this.agentResult(sessionId, 'navigate', actor, runtime => runtime.navigate(action.url!));
      }
      case 'stop':
        return { status: await this.stop(sessionId, actor) };
      case 'resize': {
        const viewport = normalizeBrowserViewport(action.width, action.height);
        return await this.agentResult(sessionId, 'resize', actor, runtime => runtime.resize(viewport));
      }
      case 'human-activity':
        return { status: await this.noteHumanActivity(sessionId, action.kind) };
      case 'navigate':
        return await this.agentResult(sessionId, 'navigate', actor, runtime => runtime.navigate(action.url));
      case 'click':
        return await this.agentResult(sessionId, 'click', actor, runtime => runtime.click(action.selector));
      case 'type':
        return await this.agentResult(sessionId, 'type', actor, runtime => runtime.type(action.selector, action.text));
      case 'read':
        return await this.agentResult(sessionId, 'read', actor, runtime => runtime.read(action.selector));
      case 'screenshot':
        return await this.agentResult(sessionId, 'screenshot', actor, runtime => runtime.screenshot());
      case 'back':
        return await this.agentResult(sessionId, 'back', actor, runtime => runtime.back());
      case 'forward':
        return await this.agentResult(sessionId, 'forward', actor, runtime => runtime.forward());
      case 'reload':
        return await this.agentResult(sessionId, 'reload', actor, runtime => runtime.reload());
      case 'new-page':
        return await this.agentResult(sessionId, 'new-page', actor, runtime => runtime.newPage(action.url));
      case 'activate-page':
        return await this.agentResult(sessionId, 'activate-page', actor, runtime =>
          runtime.activatePage(action.pageId),
        );
      case 'close-page':
        return await this.agentResult(sessionId, 'close-page', actor, runtime => runtime.closePage(action.pageId));
    }
  }

  async sweepIdle(now = this.clock.now()): Promise<number> {
    const expired = [...this.entries.entries()].filter(
      ([, entry]) =>
        entry.state === 'running' && entry.viewers.size === 0 && now - entry.lastActivityAt >= this.idleTimeoutMs,
    );
    await Promise.all(
      expired.map(async ([sessionId, entry]) => {
        entry.state = 'stopping';
        this.terminateViewers(entry, { code: 1001, reason: 'remote browser idle timeout' });
        try {
          await entry.runtime.close();
        } finally {
          await this.releaseProfile(entry);
          this.entries.delete(sessionId);
        }
      }),
    );
    return expired.length;
  }

  /** Drain every CDP-controlled browser before the human types credentials. */
  async closeForLoginWindow(): Promise<void> {
    const pending = await Promise.allSettled([...this.starting.values()]);
    const launched = pending
      .filter((result): result is PromiseFulfilledResult<RunningBrowser> => result.status === 'fulfilled')
      .map(result => result.value);
    const browserEntries = new Set([...this.entries.values(), ...launched]);
    for (const entry of browserEntries) {
      entry.state = 'stopping';
      this.terminateViewers(entry, { code: 1001, reason: 'human browser login window opened' });
    }
    await Promise.allSettled(
      [...browserEntries].map(async entry => {
        try {
          await entry.runtime.close();
        } finally {
          await this.releaseProfile(entry);
        }
      }),
    );
    for (const [sessionId, entry] of this.entries) {
      if (!browserEntries.has(entry)) continue;
      this.entries.delete(sessionId);
      this.failures.delete(sessionId);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clock.clearInterval(this.sweepTimer);
    const pending = await Promise.allSettled(this.starting.values());
    const launched = pending
      .filter((result): result is PromiseFulfilledResult<RunningBrowser> => result.status === 'fulfilled')
      .map(result => result.value);
    const browserEntries = new Set([...this.entries.values(), ...launched]);
    for (const entry of browserEntries) {
      entry.state = 'stopping';
      this.terminateViewers(entry, { code: 1001, reason: 'browser service shutting down' });
    }
    await Promise.allSettled(
      [...browserEntries].map(async entry => {
        try {
          await entry.runtime.close();
        } finally {
          await this.releaseProfile(entry);
        }
      }),
    );
    await this.displayService?.close().catch(() => undefined);
    this.entries.clear();
    this.starting.clear();
  }
}
