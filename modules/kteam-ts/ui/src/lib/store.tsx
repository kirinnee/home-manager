// ONE CLIENT STORE FOR THE WHOLE APP.
//
// Before this file every page owned its own data: the dashboard opened a fleet
// socket and re-GET the ENTIRE session list 1.5s after any event; the chat page
// opened a SECOND socket, polled `getSession` every 8s and `listSessions` every
// 20s for folder neighbours; and navigating between them threw all of it away
// and started over. Three sockets and four pollers for one daemon.
//
// What lives here:
//   - the session list + project list, hydrated once
//   - ONE fleet-scoped event socket, with reconnect/backoff/catch-up
//   - immediate per-session deltas from events, plus a BATCHED targeted
//     `getSession(id)` for the affected session only
//   - a slow, visibility-gated full reconcile (safety net, not the mechanism)
//   - a bounded per-session event buffer, replayed to a chat page the moment it
//     subscribes, so "load history → subscribe" has no gap
//   - the global, persisted UI controls (search, mode, RC, finished, view,
//     sidebar) so filters survive navigation and reload
//
// Render discipline: state is exposed through `useSyncExternalStore` with one
// SNAPSHOT OBJECT PER SLICE, so a component that reads only the UI controls
// does not re-render when a terminal frame patches some session's activity
// line, and `useSession(id)` re-renders only when THAT session's object
// changes. Stream-driven notifications are coalesced (a busy fleet emits many
// frames a second); anything the reader just did notifies immediately.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api';
import { openEventStream, type EventStreamHandle, type StreamStatus } from './ws';
import type {
  InteractionMode,
  KTeamEvent,
  ProjectInfo,
  SearchResponse,
  SessionState,
  SessionView,
  UsageAccountView,
  UsageFeedView,
} from '../types';
import { usageIndex } from './usage';
import type { SettingId } from './settings';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Events kept per session for replay to a late subscriber. */
const EVENT_BUFFER_LIMIT = 300;
/** Sessions we keep a buffer for at all (LRU). The fleet can be large; the
 *  reader can only be looking at a couple of chats. */
const BUFFERED_SESSIONS = 12;
/** Coalescing window for stream-driven re-renders. A busy fleet emits several
 *  `terminal.frame`s a second; without this the dashboard re-renders on each
 *  one. Anything the reader just did notifies immediately instead. */
const NOTIFY_COALESCE_MS = 250;
/** Batching window for a targeted `getSession` after an event. Several events
 *  usually land together (status + activity + turn) — one GET covers them. */
const REFRESH_DEBOUNCE_MS = 900;
/** Slow full-list reconcile. The socket is the mechanism; this only heals
 *  anything the delta path could have missed. */
const RECONCILE_MS = 45_000;
/** Account quota feed. kfleet refreshes on its own 300s interval and the daemon
 *  caches that, so polling faster than the data changes just burns requests.
 *  60s keeps a reset countdown honest. */
const USAGE_MS = 60_000;
/** Don't reconcile twice inside this window (reconnect + interval racing). */
const RECONCILE_MIN_GAP_MS = 5_000;
/** Fleet tail replayed on every (re)connect. */
const STREAM_TAIL = -200;

const CONTROLS_KEY = 'kteam-ui-controls-v1';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type ModeFilter = 'all' | InteractionMode;
export type DashboardView = 'cards' | 'table';
export type Density = 'full' | 'compact' | 'minimal';
export type ChatWidth = 'full' | 'readable';

/** Global, persisted UI controls. They live in the store rather than in the
 *  dashboard so the sidebar slice can render the same controls without either
 *  copy drifting, and so a filter survives navigating into a session. */
export interface UiControls {
  /** Instant client-side filter over the session list. */
  query: string;
  mode: ModeFilter;
  /** Remote-control sessions only — a real filter, not a search term. */
  rcOnly: boolean;
  includeFinished: boolean;
  /** null = follow the viewport (cards when narrow). */
  dashboardView: DashboardView | null;
  /** null = use the first-load device default without persisting it. */
  density: Density | null;
  /** Chat pane horizontal measure. 'full' = full-bleed (today's behaviour);
   *  'readable' caps the column at a reading measure and centres it. Mostly a
   *  desktop control — a phone is already narrower than the cap, so it is inert
   *  there. Non-null default because there is no device-derived answer to defer
   *  to, unlike `density`. */
  chatWidth: ChatWidth;
  /** Folder mode: focus one project group. The group KEY (a normalised project
   *  path, or a raw cwd for fallback groups) — never the display name, which can
   *  collide. null = the whole fleet. Working state, same class as query/mode. */
  projectScope: string | null;
  /** For the persistent sidebar (next slice); persisted now so it is remembered
   *  the first time that UI exists. */
  sidebarCollapsed: boolean;
}

const DEFAULT_CONTROLS: UiControls = {
  query: '',
  mode: 'all',
  rcOnly: false,
  includeFinished: false,
  dashboardView: null,
  density: null,
  chatWidth: 'full',
  projectScope: null,
  sidebarCollapsed: false,
};

export interface FleetSnapshot {
  /** null until the first hydration settles (renders the skeleton). */
  sessions: SessionView[] | null;
  byId: ReadonlyMap<string, SessionView>;
  projects: ProjectInfo[];
  /** Hydration error only — a failed background refresh keeps the last good list. */
  error: string | null;
  status: StreamStatus;
}

/** Server-side transcript search (Enter in the search box). Kept in the store,
 *  not the dashboard, so moving the search UI into the sidebar is a re-render
 *  away rather than a state migration. */
export interface SearchSnapshot {
  query: string;
  searching: boolean;
  results: SearchResponse | null;
}

/** The fleet-wide account-quota feed plus its by-binary index. One slice, so a
 *  quota refresh re-renders the badges that read it and nothing else. */
export interface UsageSnapshot {
  feed: UsageFeedView | null;
  index: Map<string, UsageAccountView>;
}

/** Ephemeral shell overlays. Unlike filters these must not survive a reload:
 * opening Settings is current navigation state, not a preference. */
export interface ChromeSnapshot {
  settingsOpen: boolean;
  settingsTarget: SettingId | null;
}

type Listener = () => void;
type EventListener = (event: KTeamEvent) => void;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Parse the additive controls-v1 payload field by field.
 *
 * Older payloads have no `density`; that is deliberately `null`, not a written
 * default, so the first-load pointer policy can choose compact on a phone and
 * full on desktop. Unknown fields remain harmless for forward/backward
 * compatibility, and one malformed field cannot discard the user's others. */
export function parseUiControls(raw: string | null): UiControls {
  if (!raw) return DEFAULT_CONTROLS;
  try {
    const parsed = JSON.parse(raw) as Partial<UiControls>;
    // Field-by-field, type-checked: a hand-edited or older blob must degrade to
    // the default for that field, never poison the whole control set.
    return {
      query: typeof parsed.query === 'string' ? parsed.query : DEFAULT_CONTROLS.query,
      mode:
        parsed.mode === 'all' || parsed.mode === 'auto' || parsed.mode === 'interactive'
          ? parsed.mode
          : DEFAULT_CONTROLS.mode,
      rcOnly: typeof parsed.rcOnly === 'boolean' ? parsed.rcOnly : DEFAULT_CONTROLS.rcOnly,
      includeFinished:
        typeof parsed.includeFinished === 'boolean' ? parsed.includeFinished : DEFAULT_CONTROLS.includeFinished,
      dashboardView: parsed.dashboardView === 'cards' || parsed.dashboardView === 'table' ? parsed.dashboardView : null,
      density:
        parsed.density === 'full' || parsed.density === 'compact' || parsed.density === 'minimal'
          ? parsed.density
          : null,
      // Optional on read: an older blob has no `chatWidth`, so it degrades to
      // 'full' — which IS today's behaviour, so the field can never poison a
      // set it predates. No key/version bump needed for the same reason.
      chatWidth: parsed.chatWidth === 'readable' ? 'readable' : 'full',
      // Additive, like density: absent/invalid/empty → null (the whole fleet),
      // which IS today's behaviour, so an older blob can never mean something
      // else. Stores the group KEY, never the display name.
      projectScope: typeof parsed.projectScope === 'string' && parsed.projectScope !== '' ? parsed.projectScope : null,
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : DEFAULT_CONTROLS.sidebarCollapsed,
    };
  } catch {
    return DEFAULT_CONTROLS;
  }
}

function loadControls(): UiControls {
  if (typeof localStorage === 'undefined') return DEFAULT_CONTROLS;
  try {
    return parseUiControls(localStorage.getItem(CONTROLS_KEY));
  } catch {
    return DEFAULT_CONTROLS;
  }
}

function saveControls(controls: UiControls): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CONTROLS_KEY, JSON.stringify(controls));
  } catch {
    /* private mode / quota — the app works fine without persistence */
  }
}

// ---------------------------------------------------------------------------
// Event → state deltas
// ---------------------------------------------------------------------------

/** Fleet-level warden broadcasts carry this pseudo id and no session. */
const FLEET_EVENT_SESSION = 'fleet';

/** Live-only, never journalled, always sequence 0 — and the highest-volume
 *  class by far. Applied as a patch; never worth a targeted GET, never worth
 *  keeping in the replay buffer. */
const TERMINAL_FRAME = 'terminal.frame';

/** Fields a `terminal.frame` may carry. `??` throughout when applying: the
 *  daemon OMITS a field it does not know, and an omitted field must leave the
 *  last known value alone rather than blanking a readout. */
interface FramePatch {
  activity?: string;
  contextPercent?: number;
  promptReady?: boolean;
  usage5hPercent?: number;
  usageWeeklyPercent?: number;
  usage5hResetAt?: number;
  usageWeeklyResetAt?: number;
  usageAtLimit?: boolean;
  usageAuthOk?: boolean;
}

function framePatch(data: unknown): Partial<SessionState> {
  const d = (data ?? {}) as FramePatch;
  const patch: Partial<SessionState> = {};
  if (d.activity !== undefined) patch.activity = d.activity;
  if (d.contextPercent !== undefined) patch.contextPercent = d.contextPercent;
  if (d.promptReady !== undefined) patch.promptReady = d.promptReady;
  if (d.usage5hPercent !== undefined) patch.usage5hPercent = d.usage5hPercent;
  if (d.usageWeeklyPercent !== undefined) patch.usageWeeklyPercent = d.usageWeeklyPercent;
  if (d.usage5hResetAt !== undefined) patch.usage5hResetAt = d.usage5hResetAt;
  if (d.usageWeeklyResetAt !== undefined) patch.usageWeeklyResetAt = d.usageWeeklyResetAt;
  if (d.usageAtLimit !== undefined) patch.usageAtLimit = d.usageAtLimit;
  if (d.usageAuthOk !== undefined) patch.usageAuthOk = d.usageAuthOk;
  return patch;
}

/** Every JOURNALLED transition event carries `{ status, health, … }` in its
 *  data (session-manager.ts `transition()`), whatever its type name is — so the
 *  status moves the instant the event lands, and the batched GET that follows
 *  only fills in the rest. */
function transitionPatch(event: KTeamEvent): Partial<SessionState> {
  const d = (event.data ?? {}) as { status?: unknown; health?: unknown; pendingQuestion?: unknown };
  const patch: Partial<SessionState> = {};
  if (typeof d.status === 'string') patch.status = d.status as SessionState['status'];
  if (typeof d.health === 'string') patch.health = d.health as SessionState['health'];
  if (d.pendingQuestion === null || (typeof d.pendingQuestion === 'object' && d.pendingQuestion !== null))
    patch.pendingQuestion = d.pendingQuestion as SessionState['pendingQuestion'];
  if (event.time) patch.lastActivityAt = event.time;
  return patch;
}

function sameView(a: SessionView, b: SessionView): boolean {
  // Structural compare, used ONLY on the slow reconcile path: reusing the old
  // object for an unchanged session keeps `useSession` from re-rendering every
  // open page every 45 seconds.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class FleetStore {
  private listeners = new Set<Listener>();
  private notifyTimer: number | null = null;

  private fleetSnapshot: FleetSnapshot = {
    sessions: null,
    byId: new Map(),
    projects: [],
    error: null,
    status: 'connecting',
  };
  private controlsSnapshot: UiControls = loadControls();
  private searchSnapshot: SearchSnapshot = { query: '', searching: false, results: null };
  private chromeSnapshot: ChromeSnapshot = { settingsOpen: false, settingsTarget: null };

  private socket: EventStreamHandle | null = null;
  private started = false;
  /** Have we ever seen the socket reach `open`? The FIRST open is the initial
   *  handshake (already covered by hydrate's list fetch); a LATER open is a
   *  genuine RECONNECT, where the 200-event global tail cannot be trusted to
   *  carry a per-session status change we missed while down — so that one gets a
   *  FORCED reconcile. */
  private hasConnected = false;

  /** Per-session highest JOURNALLED sequence seen. Sequences are per session,
   *  so this is a map, not a number. */
  private lastSequence = new Map<string, number>();
  /** Bounded per-session replay buffer for late chat subscribers. */
  private buffers = new Map<string, KTeamEvent[]>();
  private subscribers = new Map<string, Set<EventListener>>();
  /** Live-only fleet event listeners. Unlike per-session chat subscribers,
   * these do not pin replay buffers; aggregate projections use them to hear
   * events from sessions that had no relevant record at mount time. */
  private fleetEventSubscribers = new Set<EventListener>();

  private refreshTimers = new Map<string, number>();
  private refreshInflight = new Map<string, Promise<SessionView>>();
  private refreshAgain = new Set<string>();

  private reconcileInflight: Promise<void> | null = null;
  private reconcileTimer: number | null = null;
  private lastReconcileAt = 0;

  /** ONE account-quota poll for the whole app. It used to be a `useUsage` hook
   *  with its own 60s interval, mounted once per consumer — so the dashboard
   *  plus two retained chat panes ran three identical requests forever. Its own
   *  snapshot slice, so a usage response re-renders the badges and nothing else. */
  private usageSnapshot: UsageSnapshot = { feed: null, index: new Map() };
  private usageTimer: number | null = null;
  private usageInflight = false;
  private lastUsageAt = 0;

  private searchToken = 0;

  // -- lifecycle ------------------------------------------------------------

  /** Idempotent: StrictMode's double-mount, or a second provider, must not open
   *  a second socket. The store lives as long as the document. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.hydrate();
    this.socket = openEventStream({
      after: STREAM_TAIL,
      onEvent: event => this.handleEvent(event),
      onStatus: status => this.setStatus(status),
    });
    this.reconcileTimer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.reconcile();
    }, RECONCILE_MS);
    void this.refreshUsage();
    this.usageTimer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.refreshUsage();
    }, USAGE_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.socket?.close();
    this.socket = null;
    if (this.reconcileTimer != null) window.clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.usageTimer != null) window.clearInterval(this.usageTimer);
    this.usageTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
    this.refreshTimers.clear();
  }

  private onVisibility = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    // Coming back to a tab that has been asleep: the reconcile interval was
    // skipped while hidden AND the socket may have missed a per-session status
    // change (a structured question raised while backgrounded is the case that
    // bit us — dale's diagnosis, Rank 1). FORCE this one reconcile past the 5s
    // gap so a returning PWA always heals immediately, instead of the pending
    // question staying invisible for up to the 45s interval.
    void this.reconcile(true);
    // Same for quota — a countdown that stopped while hidden is worse than no
    // countdown, but only refetch if the interval genuinely lapsed.
    if (Date.now() - this.lastUsageAt >= USAGE_MS) void this.refreshUsage();
  };

  /** Fetch the fleet-wide usage feed. Last-good on failure: a transient error
   *  must never blank a readout that was correct a minute ago, and an absent
   *  record must read as "unknown", never as 0% (see lib/usage.ts). */
  private async refreshUsage(): Promise<void> {
    if (this.usageInflight) return;
    this.usageInflight = true;
    try {
      const feed = await api.usage();
      this.usageSnapshot = { feed, index: usageIndex(feed) };
      this.notify(true);
    } catch {
      /* keep the last good snapshot */
    } finally {
      this.usageInflight = false;
      this.lastUsageAt = Date.now();
    }
  }

  private async hydrate(): Promise<void> {
    // Stamped BEFORE the request: the socket opens at roughly the same moment
    // and its `open` reconcile would otherwise duplicate this exact fetch.
    this.lastReconcileAt = Date.now();
    const sessions = api
      .listSessions()
      .then(list => {
        this.setSessions(list);
        this.setFleet({ error: null });
      })
      .catch((error: unknown) => {
        // Only a FAILED FIRST LOAD is an error the reader must see. Later
        // failures keep the last good list (see reconcile()).
        if (this.fleetSnapshot.sessions === null) {
          this.setFleet({ error: error instanceof ApiError ? error.message : String(error) });
        }
      });
    const projects = api
      .projects()
      .then(list => this.setFleet({ projects: list }))
      .catch(() => undefined);
    await Promise.all([sessions, projects]);
    this.lastReconcileAt = Date.now();
  }

  // -- snapshots ------------------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getFleet = (): FleetSnapshot => this.fleetSnapshot;
  getControls = (): UiControls => this.controlsSnapshot;
  getSearch = (): SearchSnapshot => this.searchSnapshot;
  getUsage = (): UsageSnapshot => this.usageSnapshot;
  getChrome = (): ChromeSnapshot => this.chromeSnapshot;
  getSession = (id: string): SessionView | undefined => this.fleetSnapshot.byId.get(id);

  private notify(immediate = false): void {
    if (immediate) {
      if (this.notifyTimer != null) {
        window.clearTimeout(this.notifyTimer);
        this.notifyTimer = null;
      }
      for (const listener of this.listeners) listener();
      return;
    }
    if (this.notifyTimer != null) return;
    this.notifyTimer = window.setTimeout(() => {
      this.notifyTimer = null;
      for (const listener of this.listeners) listener();
    }, NOTIFY_COALESCE_MS);
  }

  private setFleet(patch: Partial<FleetSnapshot>, immediate = true): void {
    this.fleetSnapshot = { ...this.fleetSnapshot, ...patch };
    this.notify(immediate);
  }

  private setStatus(status: StreamStatus): void {
    if (this.fleetSnapshot.status === status) return;
    this.setFleet({ status });
    // A socket that just (re)opened may have missed events while it was down;
    // the tail covers journalled ones, a reconcile covers the rest. The FIRST
    // open dedupes against hydrate's fetch (hydrate stamped lastReconcileAt for
    // exactly this); a RECONNECT forces the reconcile past the 5s gap, because
    // the 200-event global tail routinely misses a per-session status change
    // (e.g. a question raised while we were down) and the whole point of the
    // reconnect heal is to catch it (dale's diagnosis, Rank 1).
    if (status === 'open') {
      const reconnect = this.hasConnected;
      this.hasConnected = true;
      void this.reconcile(reconnect);
    }
  }

  /** Replace the whole list, reusing unchanged session objects so open pages
   *  do not re-render on every reconcile. */
  private setSessions(list: SessionView[]): void {
    const previous = this.fleetSnapshot.byId;
    const sessions = list.map(view => {
      const old = previous.get(view.config.id);
      return old && sameView(old, view) ? old : view;
    });
    this.commitSessions(sessions, true);
  }

  private commitSessions(sessions: SessionView[], immediate: boolean): void {
    const byId = new Map<string, SessionView>();
    for (const view of sessions) byId.set(view.config.id, view);
    this.fleetSnapshot = { ...this.fleetSnapshot, sessions, byId };
    this.notify(immediate);
  }

  // -- mutations ------------------------------------------------------------

  /** Insert or replace one session (an API response, or a delta). Used by every
   *  mutating call in the chat page so the fleet reflects it at once. */
  upsertSession(view: SessionView, immediate = true): void {
    const current = this.fleetSnapshot.sessions;
    if (!current) {
      this.commitSessions([view], immediate);
      return;
    }
    const index = current.findIndex(v => v.config.id === view.config.id);
    if (index === -1) {
      this.commitSessions([view, ...current], immediate);
      return;
    }
    if (current[index] === view) return;
    const next = current.slice();
    next[index] = view;
    this.commitSessions(next, immediate);
  }

  removeSession(id: string): void {
    const current = this.fleetSnapshot.sessions;
    this.cancelRefresh(id);
    this.buffers.delete(id);
    if (!current) return;
    const next = current.filter(v => v.config.id !== id);
    if (next.length === current.length) return;
    this.commitSessions(next, true);
  }

  private patchSession(id: string, patch: Partial<SessionState>): boolean {
    if (Object.keys(patch).length === 0) return false;
    const current = this.fleetSnapshot.byId.get(id);
    if (!current) return false;
    this.upsertSession({ ...current, state: { ...current.state, ...patch } }, false);
    return true;
  }

  // -- targeted refresh -----------------------------------------------------

  /** Fetch ONE session and fold it in. Shared inflight promise, so a burst of
   *  events (or a page mount racing the stream) makes one request. Throws so a
   *  caller that needs the answer — the chat page's initial load — can surface
   *  a real error. */
  fetchSession(id: string): Promise<SessionView> {
    const inflight = this.refreshInflight.get(id);
    if (inflight) return inflight;
    const request = api
      .getSession(id)
      .then(view => {
        this.upsertSession(view);
        return view;
      })
      .catch((error: unknown) => {
        // A session that no longer exists leaves the cache rather than sitting
        // there forever as a ghost row.
        if (error instanceof ApiError && error.status === 404) this.removeSession(id);
        throw error;
      })
      .finally(() => {
        this.refreshInflight.delete(id);
        if (this.refreshAgain.delete(id)) this.scheduleRefresh(id);
      });
    this.refreshInflight.set(id, request);
    return request;
  }

  /** Batched targeted refresh: never a fleet GET, never more than one request
   *  per session per window, and never overlapping requests for one session. */
  scheduleRefresh(id: string): void {
    if (!id || id === FLEET_EVENT_SESSION) return;
    if (this.refreshInflight.has(id)) {
      this.refreshAgain.add(id);
      return;
    }
    if (this.refreshTimers.has(id)) return;
    const timer = window.setTimeout(() => {
      this.refreshTimers.delete(id);
      void this.fetchSession(id).catch(() => undefined);
    }, REFRESH_DEBOUNCE_MS);
    this.refreshTimers.set(id, timer);
  }

  private cancelRefresh(id: string): void {
    const timer = this.refreshTimers.get(id);
    if (timer != null) window.clearTimeout(timer);
    this.refreshTimers.delete(id);
    this.refreshAgain.delete(id);
  }

  /** The slow safety net: full list, visibility-gated, rate-limited. */
  reconcile(force = false): Promise<void> {
    if (this.reconcileInflight) return this.reconcileInflight;
    if (!force && Date.now() - this.lastReconcileAt < RECONCILE_MIN_GAP_MS) return Promise.resolve();
    if (typeof document !== 'undefined' && document.hidden && !force) return Promise.resolve();
    const request = api
      .listSessions()
      .then(list => {
        this.setSessions(list);
        if (this.fleetSnapshot.error) this.setFleet({ error: null });
      })
      // A transient failure must not blank a list that was correct a moment
      // ago; the next tick tries again.
      .catch(() => undefined)
      .finally(() => {
        this.reconcileInflight = null;
        this.lastReconcileAt = Date.now();
      });
    this.reconcileInflight = request;
    return request;
  }

  refreshProjects(): void {
    api
      .projects()
      .then(list => this.setFleet({ projects: list }))
      .catch(() => undefined);
  }

  // -- event fan-out --------------------------------------------------------

  private handleEvent(event: KTeamEvent): void {
    const id = event.sessionId;

    // SEQUENCE 0 MEANS "NOT IN THE JOURNAL", NOT "OLD".
    //
    // Two whole classes are broadcast live and never journalled, and both carry
    // sequence 0 by construction: `terminal.frame`, and EVERY harness-derived
    // chat event (chat.*, tool.use, tool.result — indexed by byte pointer in the
    // harness's own transcript, never copied into events.jsonl). Applying a
    // monotonic guard to those drops 100% of streaming chat, because the
    // journalled backfill always pushes the cursor above 0 first. Only
    // journalled events are deduped here; chat records are deduped by CONTENT
    // identity in the chat page (recordUuid, else a full-length hash).
    if (typeof event.sequence === 'number' && event.sequence > 0) {
      const last = this.lastSequence.get(id) ?? 0;
      if (event.sequence <= last) return;
      this.lastSequence.set(id, event.sequence);
    }

    for (const listener of this.fleetEventSubscribers) {
      try {
        listener(event);
      } catch {
        /* one aggregate listener never breaks the shared stream */
      }
    }
    this.buffer(event);
    const listeners = this.subscribers.get(id);
    if (listeners) for (const listener of listeners) listener(event);
    this.applyDelta(event);
  }

  private applyDelta(event: KTeamEvent): void {
    const id = event.sessionId;
    if (!id || id === FLEET_EVENT_SESSION) return;

    if (event.type === TERMINAL_FRAME) {
      // Pure delta: frames are liveness, they arrive constantly, and a GET per
      // frame would be a request storm on its own.
      this.patchSession(id, framePatch(event.data));
      return;
    }

    // SEQUENCE, NOT TYPE, DECIDES WHAT AN EVENT IS.
    //
    // `turn.started` exists twice: the daemon's own JOURNALLED transition (it
    // carries `{status, health}` and IS a state change) and the harness's
    // transcript record broadcast live at sequence 0 (it is a transcript entry
    // and carries no state). Classifying by type name — "anything turn.* is
    // chat" — silently dropped the first, so a turn boundary never moved the
    // status until some later event did. Sequence-0 frames go to the transcript
    // subscribers only; journalled events are state.
    if (!(typeof event.sequence === 'number' && event.sequence > 0)) return;

    if (event.type === 'session.deleted') {
      this.removeSession(id);
      return;
    }

    if (event.type === 'quota.updated') {
      this.patchSession(id, framePatch(event.data));
      this.scheduleRefresh(id);
      return;
    }

    // Every journalled transition carries `{ status, health, … }` whatever its
    // type name is, so the status moves at once; the batched GET that follows
    // fills in everything else (turn, pending question, liveness ledger) with
    // ONE request per session per window — never a fleet re-GET.
    this.patchSession(id, transitionPatch(event));
    this.scheduleRefresh(id);
  }

  private buffer(event: KTeamEvent): void {
    const id = event.sessionId;
    if (!id || id === FLEET_EVENT_SESSION) return;
    // Frames are state, and the store already applied them; buffering ~1/s per
    // live session would evict the chat records the buffer exists for.
    if (event.type === TERMINAL_FRAME) return;
    let queue = this.buffers.get(id);
    if (!queue) {
      queue = [];
      // LRU by insertion order (Map preserves it): evict the oldest buffer that
      // nobody is subscribed to. A session the reader has open is never evicted
      // out from under its chat page.
      if (this.buffers.size >= BUFFERED_SESSIONS) {
        for (const candidate of this.buffers.keys()) {
          if (this.subscribers.has(candidate)) continue;
          this.buffers.delete(candidate);
          break;
        }
      }
    } else {
      // Re-insert so an active session moves to the back of the LRU.
      this.buffers.delete(id);
    }
    queue.push(event);
    if (queue.length > EVENT_BUFFER_LIMIT) queue.splice(0, queue.length - EVENT_BUFFER_LIMIT);
    this.buffers.set(id, queue);
  }

  /** Subscribe to one session's live events. The buffered recent window is
   *  replayed SYNCHRONOUSLY first, so a chat page that finished loading its
   *  history a moment after the socket delivered a frame still sees that frame
   *  — there is no window in which an event can fall between the two. */
  subscribeSession(id: string, listener: EventListener): () => void {
    let set = this.subscribers.get(id);
    if (!set) {
      set = new Set();
      this.subscribers.set(id, set);
    }
    set.add(listener);
    for (const event of this.buffers.get(id) ?? []) {
      try {
        listener(event);
      } catch {
        /* one bad replay never breaks the subscription */
      }
    }
    return () => {
      const current = this.subscribers.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.subscribers.delete(id);
    };
  }

  /** Subscribe to the live fleet stream without replaying or retaining every
   * session's chat buffer. Initial state must still come from an API read. */
  subscribeEvents(listener: EventListener): () => void {
    this.fleetEventSubscribers.add(listener);
    return () => this.fleetEventSubscribers.delete(listener);
  }

  // -- UI controls ----------------------------------------------------------

  setControls(patch: Partial<UiControls>): void {
    const next = { ...this.controlsSnapshot, ...patch };
    if ((Object.keys(patch) as Array<keyof UiControls>).every(key => this.controlsSnapshot[key] === next[key])) return;
    this.controlsSnapshot = next;
    saveControls(next);
    this.notify(true);
  }

  // -- shell overlays -------------------------------------------------------

  openSettings(target: SettingId | null = null): void {
    if (this.chromeSnapshot.settingsOpen && this.chromeSnapshot.settingsTarget === target) return;
    this.chromeSnapshot = { settingsOpen: true, settingsTarget: target };
    this.notify(true);
  }

  closeSettings(): void {
    if (!this.chromeSnapshot.settingsOpen && this.chromeSnapshot.settingsTarget === null) return;
    this.chromeSnapshot = { settingsOpen: false, settingsTarget: null };
    this.notify(true);
  }

  // -- transcript search ----------------------------------------------------

  async runSearch(query: string): Promise<void> {
    const q = query.trim();
    if (!q) {
      this.clearSearch();
      return;
    }
    const token = ++this.searchToken;
    this.searchSnapshot = { query: q, searching: true, results: null };
    this.notify(true);
    try {
      const results = await api.search(q, 40);
      if (token !== this.searchToken) return;
      this.searchSnapshot = { query: q, searching: false, results };
    } catch {
      if (token !== this.searchToken) return;
      this.searchSnapshot = { query: q, searching: false, results: { query: q, scanned: 0, results: [] } };
    }
    this.notify(true);
  }

  clearSearch(): void {
    this.searchToken++;
    if (!this.searchSnapshot.query && !this.searchSnapshot.results && !this.searchSnapshot.searching) return;
    this.searchSnapshot = { query: '', searching: false, results: null };
    this.notify(true);
  }
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/** Module singleton. The store's lifetime is the document's: a provider remount
 *  (StrictMode, HMR) must not drop the socket or the cache. */
const store = new FleetStore();

const StoreContext = createContext<FleetStore>(store);

export function StoreProvider({ children }: { children: ReactNode }) {
  // Started in an effect rather than at module scope so nothing connects while
  // the tree is still being constructed; `start()` is idempotent.
  useEffect(() => {
    store.start();
  }, []);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): FleetStore {
  return useContext(StoreContext);
}

export function useFleet(): FleetSnapshot {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.getFleet, s.getFleet);
}

/** Re-renders only when THIS session's object changes. */
export function useSession(id: string): SessionView | undefined {
  const s = useStore();
  const get = useCallback(() => s.getSession(id), [s, id]);
  return useSyncExternalStore(s.subscribe, get, get);
}

export function useUiControls(): [UiControls, (patch: Partial<UiControls>) => void] {
  const s = useStore();
  const controls = useSyncExternalStore(s.subscribe, s.getControls, s.getControls);
  const set = useCallback((patch: Partial<UiControls>) => s.setControls(patch), [s]);
  return [controls, set];
}

export function useChrome(): ChromeSnapshot {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.getChrome, s.getChrome);
}

export function useTranscriptSearch(): SearchSnapshot {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.getSearch, s.getSearch);
}

/** Live events for one session, buffered-then-live. The handler may change
 *  every render; the subscription does not. */
export function useSessionEvents(id: string, handler: EventListener): void {
  const s = useStore();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!id) return;
    return s.subscribeSession(id, event => ref.current(event));
  }, [s, id]);
}

/** Live events across every session, without opening another socket or pinning
 * per-session replay buffers. */
export function useFleetEvents(handler: EventListener): void {
  const s = useStore();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => s.subscribeEvents(event => ref.current(event)), [s]);
}

/** The fleet list as a Map-free array plus a stable empty default. */
export function useSessions(): SessionView[] {
  const { sessions } = useFleet();
  return useMemo(() => sessions ?? EMPTY_SESSIONS, [sessions]);
}

const EMPTY_SESSIONS: SessionView[] = [];

/** The fleet-wide account-quota feed. Same shape the old `useUsage` hook
 *  returned, so every call site is unchanged — but there is now ONE poll behind
 *  it for the whole app instead of one per mounted consumer. */
export function useUsageSnapshot(): UsageSnapshot {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.getUsage, s.getUsage);
}
