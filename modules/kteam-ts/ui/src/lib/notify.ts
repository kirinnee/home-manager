// SESSION NOTIFICATIONS — the pure core.
//
// The problem: the fleet runs ~15 detached sessions and the human reads them
// through an installed PWA. A session going `awaiting_user` (a question, a
// permission prompt, a finished job) is invisible until they look. This module
// decides WHEN that fact becomes a system notification.
//
// DELIVERY TRANSPORTS. The existing WebSocket is the foreground fast path and
// uses this core while the page is alive. Real Web Push reuses the same payload
// identity when the installed PWA is suspended or closed. One deterministic
// eventKey plus one OS tag per session lets the presentation layer collapse the
// transport twins instead of buzzing twice.
//
// SPLIT: everything here is a pure function or an in-memory ledger — no DOM, no
// Notification global, no store import — so bun:test covers every decision.
// The browser wiring (permission, showNotification, the SW message channel)
// lives in hooks/useNotifications.ts; the notification-click deep link lives in
// the service worker (sw/notify.ts).

import type { SessionStatus, SessionView } from '../types';
import { displayCallsign } from './callsign';

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** The four event classes the brief names. Keys double as pref toggles. */
export type NotifyKind = 'needsYou' | 'question' | 'failed' | 'completed';

export const NOTIFY_KINDS: readonly NotifyKind[] = ['needsYou', 'question', 'failed', 'completed'];

export interface NotifyPrefs {
  /** Master switch. FALSE by default: quiet until the human explicitly turns
   *  notifications on in Settings (which is also where the permission request
   *  hangs — it must be user-initiated, never a page-load prompt). */
  enabled: boolean;
  /** Which transitions fire. Independent of `enabled` so turning the master
   *  switch off and on again keeps the shape the reader chose. */
  events: Record<NotifyKind, boolean>;
  /** Suppress while the app is visible — the dashboard already shows the
   *  status change, and a buzz on top of it is noise. Default true. */
  onlyWhenHidden: boolean;
  /** Only notify for `interactive` sessions. Default false: an auto session
   *  hitting a permission prompt is exactly the invisible case. */
  interactiveOnly: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  enabled: false,
  events: { needsYou: true, question: true, failed: true, completed: true },
  onlyWhenHidden: true,
  interactiveOnly: false,
};

export const NOTIFY_PREFS_KEY = 'kteam-ui-notify-v1';

/** Field-by-field parse, exactly like `parseUiControls`: one malformed field
 *  degrades to ITS default, never poisons the rest, and unknown fields are
 *  harmless in both directions. */
export function parseNotifyPrefs(raw: string | null): NotifyPrefs {
  if (!raw) return DEFAULT_NOTIFY_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs> & { events?: Partial<Record<NotifyKind, boolean>> };
    const events = {} as Record<NotifyKind, boolean>;
    for (const kind of NOTIFY_KINDS) {
      const value = parsed.events?.[kind];
      events[kind] = typeof value === 'boolean' ? value : DEFAULT_NOTIFY_PREFS.events[kind];
    }
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_NOTIFY_PREFS.enabled,
      events,
      onlyWhenHidden:
        typeof parsed.onlyWhenHidden === 'boolean' ? parsed.onlyWhenHidden : DEFAULT_NOTIFY_PREFS.onlyWhenHidden,
      interactiveOnly:
        typeof parsed.interactiveOnly === 'boolean' ? parsed.interactiveOnly : DEFAULT_NOTIFY_PREFS.interactiveOnly,
    };
  } catch {
    return DEFAULT_NOTIFY_PREFS;
  }
}

// ---------------------------------------------------------------------------
// Prefs store — module singleton, same pattern as lib/pin-bridge.ts.
//
// The Settings section writes prefs and the watch controller (mounted once in
// the shell) reads them; they are unrelated components with no shared owner
// this feature may edit, so a tiny subscribable module is the honest wiring.
// ---------------------------------------------------------------------------

type Listener = () => void;

let prefsSnapshot: NotifyPrefs | null = null;
const prefsListeners = new Set<Listener>();

function loadPrefs(): NotifyPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_NOTIFY_PREFS;
  try {
    return parseNotifyPrefs(localStorage.getItem(NOTIFY_PREFS_KEY));
  } catch {
    return DEFAULT_NOTIFY_PREFS;
  }
}

export function getNotifyPrefs(): NotifyPrefs {
  if (prefsSnapshot === null) prefsSnapshot = loadPrefs();
  return prefsSnapshot;
}

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): NotifyPrefs {
  const current = getNotifyPrefs();
  const next: NotifyPrefs = {
    ...current,
    ...patch,
    events: { ...current.events, ...(patch.events ?? {}) },
  };
  prefsSnapshot = next;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(next));
    } catch {
      /* private mode / quota — the session still works, prefs just don't survive */
    }
  }
  for (const listener of prefsListeners) listener();
  return next;
}

export function subscribeNotifyPrefs(listener: Listener): () => void {
  prefsListeners.add(listener);
  return () => prefsListeners.delete(listener);
}

/** Test hook: reset the module singleton between tests. */
export function resetNotifyPrefsForTest(): void {
  prefsSnapshot = null;
}

// ---------------------------------------------------------------------------
// Classification — which status transitions mean "tell the human"
// ---------------------------------------------------------------------------

/** The daemon's failure family (matches TERMINAL_STATUSES minus `completed`,
 *  which is its own kind, and `stopped`, which the human did themselves). */
const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'stalled', 'kill_failed']);

/** Map ONE status transition to a notify kind, or null.
 *
 *  `prev === undefined` is first sight — hydration, a reconnect that grew the
 *  list, or the watch just starting. It NEVER fires: a fresh subscriber must
 *  baseline the fleet silently, or enabling notifications would buzz once per
 *  already-waiting session. */
export function classifyTransition(prev: SessionStatus | undefined, next: SessionStatus): NotifyKind | null {
  if (prev === undefined || prev === next) return null;
  if (next === 'awaiting_question') return 'question';
  if (next === 'awaiting_user') return 'needsYou';
  if (FAILED_STATUSES.has(next)) return 'failed';
  if (next === 'completed') return 'completed';
  return null;
}

// ---------------------------------------------------------------------------
// Dedup ledger
// ---------------------------------------------------------------------------

/** A session bouncing into the same state twice inside this window is ONE
 *  notification (the brief's ten-second case, with margin — status flaps
 *  around a turn boundary are common). */
export const NOTIFY_COOLDOWN_MS = 60_000;
/** Recent updates to one conversation share a rolling count. The OS-level
 * notification itself is the unread boundary: dismiss/tap removes it, while
 * this window preserves context when the push service collapses queued payloads
 * before a sleeping phone wakes. */
export const NOTIFY_GROUP_WINDOW_MS = 15 * 60_000;

/** Per-session status baseline + per-(session, kind) cooldown. In-memory on
 *  purpose: a reload re-baselines silently, which is the safe direction —
 *  a missed notification costs a glance, a re-notified storm costs trust. */
export class NotifyLedger {
  private statuses = new Map<string, SessionStatus>();
  private fired = new Map<string, { at: number; eventKey: string }>();
  private groups = new Map<string, { at: number; count: number }>();

  status(id: string): SessionStatus | undefined {
    return this.statuses.get(id);
  }

  setStatus(id: string, status: SessionStatus): void {
    this.statuses.set(id, status);
  }

  /** True (and records the firing) unless this is the SAME logical transition
   * inside the cooldown. A new turn/question key is allowed immediately so
   * sequential messages update the grouped notification instead of vanishing. */
  shouldFire(
    id: string,
    kind: NotifyKind,
    at: number,
    eventKey = `${id}:${kind}`,
    cooldownMs = NOTIFY_COOLDOWN_MS,
  ): boolean {
    const key = `${id}\n${kind}`;
    const last = this.fired.get(key);
    if (last !== undefined && last.eventKey === eventKey && at - last.at < cooldownMs) return false;
    this.fired.set(key, { at, eventKey });
    return true;
  }

  nextGroupCount(id: string, at: number, windowMs = NOTIFY_GROUP_WINDOW_MS): number {
    const previous = this.groups.get(id);
    const count = !previous || at - previous.at > windowMs ? 1 : Math.min(100, previous.count + 1);
    this.groups.set(id, { at, count });
    return count;
  }

  /** Drop state for sessions that left the list, so a long-lived tab watching
   *  a churning fleet cannot grow these maps without bound. */
  prune(liveIds: ReadonlySet<string>): void {
    for (const id of this.statuses.keys()) if (!liveIds.has(id)) this.statuses.delete(id);
    for (const key of this.fired.keys()) {
      const id = key.slice(0, key.indexOf('\n'));
      if (!liveIds.has(id)) this.fired.delete(key);
    }
    for (const id of this.groups.keys()) if (!liveIds.has(id)) this.groups.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export interface NotificationSpec {
  title: string;
  body: string;
  /** Same tag = one Telegram-style conversation entry per session. */
  tag: string;
  /** SPA path the click deep-links to. Carried in `Notification.data` and
   *  resolved by the service worker's notificationclick (sw/notify.ts). */
  url: string;
  /** Absent on the burst summary. */
  sessionId?: string;
  kind?: NotifyKind;
  /** Deterministic across WebSocket and Web Push for the same transition. */
  eventKey: string;
  /** Number of recent lines collapsed into this conversation. `body` remains
   * the latest line; the presentation layer appends "+N more". */
  count: number;
}

const QUESTION_PREVIEW_LEN = 120;

function bodyFor(view: SessionView, kind: NotifyKind): string {
  switch (kind) {
    case 'question': {
      const question = view.state.pendingQuestion?.questions[0]?.question;
      if (question)
        return question.length > QUESTION_PREVIEW_LEN ? `${question.slice(0, QUESTION_PREVIEW_LEN - 1)}…` : question;
      return 'Asked you a question.';
    }
    case 'needsYou':
      return 'Waiting for you at the prompt.';
    case 'failed': {
      const status = view.state.status;
      const reason = view.state.reason;
      const label = status === 'stalled' ? 'Stalled' : status === 'kill_failed' ? 'Kill failed' : 'Failed';
      return reason ? `${label} — ${reason}` : `${label}.`;
    }
    case 'completed':
      return 'Finished its task.';
  }
}

export function notificationEventKey(view: SessionView, kind: NotifyKind): string {
  const question = kind === 'question' ? (view.state.pendingQuestion?.toolUseId ?? '') : '';
  return [view.config.id, kind, view.state.status, String(view.state.turn), question].join(':');
}

export function notificationTitle(view: SessionView): string {
  const id = view.config.id;
  const task = view.config.name?.trim() || id;
  // Older sessions can already carry a composed title. Preserve it verbatim so
  // the callsign is never doubled into `[Noel] [Noel] …`.
  if (task.startsWith('[')) return task;
  const callsign = displayCallsign(view.config.teammate);
  return callsign ? `[${callsign}] ${task}` : task;
}

export function buildNotification(view: SessionView, kind: NotifyKind, count = 1): NotificationSpec {
  const id = view.config.id;
  return {
    title: notificationTitle(view),
    body: bodyFor(view, kind),
    tag: `kteam-${id}`,
    url: `/session/${encodeURIComponent(id)}`,
    sessionId: id,
    kind,
    eventKey: notificationEventKey(view, kind),
    count: Math.max(1, Math.min(100, Math.floor(count))),
  };
}

// ---------------------------------------------------------------------------
// Planning — one snapshot diff → the notifications to show
// ---------------------------------------------------------------------------

/** More than this many firings from ONE diff pass collapse into a single
 *  summary. The storm case is real, not hypothetical: a phone waking after an
 *  hour reconnects the socket, the forced reconcile lands a whole fleet of
 *  status changes in one snapshot, and 12 separate buzzes would be worse than
 *  none. First sight never fires (see classifyTransition), so this only
 *  triggers when many sessions genuinely changed while the socket was up. */
export const NOTIFY_BURST_LIMIT = 3;

export const SUMMARY_TAG = 'kteam-summary';

/** Portable FNV-1a over sorted member keys. The daemon uses the same function
 * shape, so a WebSocket summary and its Web Push twin share one event key. */
export function fleetNotificationEventKey(eventKeys: readonly string[]): string {
  let hash = 0x811c9dc5;
  const joined = [...eventKeys].sort().join('\n');
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fleet:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function summaryNotification(count: number, eventKey = `fleet-summary:${count}`): NotificationSpec {
  return {
    title: 'kteam',
    body: `${count} sessions need your attention.`,
    tag: SUMMARY_TAG,
    url: '/',
    eventKey,
    count: 1,
  };
}

/** Diff one fleet snapshot against the ledger. ALWAYS advances the baseline
 *  (so a pass whose output is suppressed downstream cannot cause a later
 *  storm); fires only what the prefs allow and the cooldown admits. */
export function planNotifications(
  views: readonly SessionView[],
  ledger: NotifyLedger,
  prefs: NotifyPrefs,
  at: number,
): NotificationSpec[] {
  const live = new Set<string>();
  const specs: NotificationSpec[] = [];
  for (const view of views) {
    const id = view.config.id;
    live.add(id);
    const next = view.state.status;
    const kind = classifyTransition(ledger.status(id), next);
    ledger.setStatus(id, next);
    if (!kind) continue;
    if (!prefs.enabled || !prefs.events[kind]) continue;
    if (prefs.interactiveOnly && view.config.mode !== 'interactive') continue;
    const eventKey = notificationEventKey(view, kind);
    if (!ledger.shouldFire(id, kind, at, eventKey)) continue;
    specs.push(buildNotification(view, kind, ledger.nextGroupCount(id, at)));
  }
  ledger.prune(live);
  if (specs.length > NOTIFY_BURST_LIMIT) {
    const summaryKey = fleetNotificationEventKey(specs.map(spec => spec.eventKey));
    return [summaryNotification(specs.length, summaryKey)];
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Watch controller — pure over injected surfaces, wired by useNotifications
// ---------------------------------------------------------------------------

export interface SessionsSource {
  subscribe(listener: () => void): () => void;
  /** null until hydration — a null snapshot is "not yet", never "empty". */
  sessions(): readonly SessionView[] | null;
}

export interface NotifyEnv {
  prefs(): NotifyPrefs;
  /** `document.hidden` in the browser. */
  hidden(): boolean;
  /** The session the reader is LOOKING at right now (pin-bridge foreground),
   *  or null. Its own notifications are suppressed while the app is visible —
   *  buzzing about the conversation on screen helps nobody. */
  foregroundSession(): string | null;
  show(spec: NotificationSpec): void;
  now(): number;
}

/** Subscribe to the fleet and turn status changes into notifications. Returns
 *  the unsubscribe. Permission and the master switch are the CALLER's gate
 *  (useNotifications only starts this while enabled + granted); the first tick
 *  baselines the current fleet silently by construction. */
export function startNotificationWatch(source: SessionsSource, env: NotifyEnv): () => void {
  const ledger = new NotifyLedger();
  const tick = () => {
    const views = source.sessions();
    if (!views) return;
    const prefs = env.prefs();
    const specs = planNotifications(views, ledger, prefs, env.now());
    if (specs.length === 0) return;
    const visible = !env.hidden();
    if (visible && prefs.onlyWhenHidden) return;
    const foreground = visible ? env.foregroundSession() : null;
    for (const spec of specs) {
      if (spec.sessionId && spec.sessionId === foreground) continue;
      env.show(spec);
    }
  };
  tick();
  return source.subscribe(tick);
}
