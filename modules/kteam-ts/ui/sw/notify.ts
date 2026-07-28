/* ============================================================================
   NOTIFICATION CLICK ROUTING (pure decisions, same split as policy.ts)

   The page (hooks/useNotifications.ts) shows notifications through
   `registration.showNotification` with the session's SPA path in
   `notification.data.url`. Clicks are delivered to the WORKER, not the page —
   possibly with no page open at all — so the deep link is resolved here.

   Same discipline as policy.ts: everything with a decision in it is a pure
   function over explicit arguments, importable with no generated code and no
   `self`, so `notify.test.ts` covers it on a clean checkout. The entry (sw.ts)
   only wires the decision to the real event.

   NOTHING HERE TOUCHES CACHESTORAGE. Click handling is focus/open/navigate
   only, so the worker's write invariant (installation is the only writer) is
   untouched by this feature.
   ============================================================================ */

/** The slice of a WindowClient the decision needs. Structural, so tests pass
    plain objects and the worker passes real clients. */
export interface ClientLike {
  url: string;
  focus(): Promise<unknown>;
  /** Absent in some engines; the decision falls back to open when missing. */
  navigate?(url: string): Promise<unknown>;
}

export type PushNotifyKind = 'needsYou' | 'question' | 'failed' | 'completed';

/** Runtime-validated wire payload from the daemon. It intentionally mirrors
    the app's NotificationSpec without importing DOM-bound app code into the
    worker project. */
export interface PushNotificationPayload {
  version: 1;
  eventKey: string;
  title: string;
  /** Latest line only; presentation appends the collapsed count. */
  body: string;
  tag: string;
  url: string;
  count: number;
  sessionId?: string;
  kind?: PushNotifyKind;
}

const PUSH_KINDS = new Set<PushNotifyKind>(['needsYou', 'question', 'failed', 'completed']);

/** Treat push-service bytes as hostile input even though the daemon authored
    them: a malformed payload must not become an arbitrary title, URL, or tag. */
export function parsePushPayload(value: unknown): PushNotificationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw['version'] !== 1) return null;
  const title = raw['title'];
  const body = raw['body'];
  const tag = raw['tag'];
  const url = raw['url'];
  const eventKey = raw['eventKey'];
  const count = raw['count'];
  if (typeof title !== 'string' || !title.trim() || title.length > 120) return null;
  if (typeof body !== 'string' || body.length > 240) return null;
  if (typeof tag !== 'string' || !/^kteam-[A-Za-z0-9_-]+$/u.test(tag) || tag.length > 160) return null;
  if (typeof url !== 'string' || targetPath({ url }) !== url) return null;
  if (typeof eventKey !== 'string' || !eventKey || eventKey.length > 512) return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 100) return null;
  const sessionId = raw['sessionId'];
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 160)) return null;
  const kind = raw['kind'];
  if (kind !== undefined && (typeof kind !== 'string' || !PUSH_KINDS.has(kind as PushNotifyKind))) return null;
  return {
    version: 1,
    eventKey,
    title: title.trim(),
    body,
    tag,
    url,
    count,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(kind === undefined ? {} : { kind: kind as PushNotifyKind }),
  };
}

export function groupedNotificationBody(latest: string, count: number): string {
  return count > 1 ? `${latest}\n+${count - 1} more` : latest;
}

export interface NotificationDataLike {
  eventKey?: unknown;
  count?: unknown;
}

export type NotificationPresentation =
  | { action: 'skip' }
  | {
      action: 'show';
      body: string;
      count: number;
      data: { url: string; eventKey: string; count: number; latestBody: string };
    };

/** Merge one incoming line with the notification currently active under the
    same tag. Exact event key = the WebSocket/push twin, so skip it. A genuinely
    later line replaces silently and carries the latest text plus "+N more". */
export function planNotificationPresentation(
  payload: PushNotificationPayload,
  existing: readonly NotificationDataLike[],
): NotificationPresentation {
  if (existing.some(item => item.eventKey === payload.eventKey)) return { action: 'skip' };
  let count = payload.count;
  if (payload.sessionId) {
    const activeCount = existing.reduce(
      (highest, item) =>
        typeof item.count === 'number' && Number.isSafeInteger(item.count) && item.count > highest
          ? item.count
          : highest,
      0,
    );
    if (activeCount > 0) count = Math.max(count, Math.min(100, activeCount + 1));
  }
  return {
    action: 'show',
    body: groupedNotificationBody(payload.body, count),
    count,
    data: { url: payload.url, eventKey: payload.eventKey, count, latestBody: payload.body },
  };
}

export interface NotificationRegistrationLike {
  getNotifications(options?: { tag?: string }): PromiseLike<readonly { data?: unknown }[]>;
  showNotification(title: string, options?: NotificationOptions): PromiseLike<void>;
}

/** Shared by the page's WebSocket fast path and the worker's Push path. The
    existing-notification read closes almost every race; if both transports read
    before either writes, the identical tag still collapses to one OS entry and
    `renotify:false` makes the replacement silent. */
export async function showGroupedNotification(
  registration: NotificationRegistrationLike,
  payload: PushNotificationPayload,
): Promise<'shown' | 'duplicate'> {
  const notifications = await registration.getNotifications({ tag: payload.tag });
  const plan = planNotificationPresentation(
    payload,
    notifications.map(notification =>
      notification.data && typeof notification.data === 'object'
        ? (notification.data as NotificationDataLike)
        : ({} as NotificationDataLike),
    ),
  );
  if (plan.action === 'skip') return 'duplicate';
  const options: NotificationOptions & { renotify: boolean } = {
    body: plan.body,
    tag: payload.tag,
    renotify: false,
    data: plan.data,
  };
  await registration.showNotification(payload.title, options);
  return 'shown';
}

export type ClickPlan<C extends ClientLike = ClientLike> =
  /** An app window exists: focus it, then navigate it to the target (skipped
      when it is already there — a reload would drop composer drafts). */
  | { action: 'focus'; client: C; navigate: boolean }
  /** No app window: open one at the target. */
  | { action: 'open' };

/** Read the deep-link path off `notification.data`, defensively: a malformed or
    absent payload deep-links to the dashboard rather than throwing inside an
    event the reader cannot see. Only same-origin SPA paths are honoured — a
    notification cannot be made to open an arbitrary URL. */
export function targetPath(data: unknown): string {
  if (data && typeof data === 'object') {
    const url = (data as { url?: unknown }).url;
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return url;
  }
  return '/';
}

/** True when `clientUrl` already shows `path` (ignoring query/hash — the app
    ignores both for session routes, and reloading over them helps nobody). */
export function alreadyAt(clientUrl: string, path: string, origin: string): boolean {
  try {
    const url = new URL(clientUrl);
    if (url.origin !== origin) return false;
    return url.pathname === path;
  } catch {
    return false;
  }
}

/** Decide what a notification click does. First same-origin client wins —
    the app is effectively single-window (one PWA instance / one tab), and
    focusing ANY app window beats opening a duplicate. */
export function planClick<C extends ClientLike>(clients: readonly C[], path: string, origin: string): ClickPlan<C> {
  for (const client of clients) {
    try {
      if (new URL(client.url).origin !== origin) continue;
    } catch {
      continue;
    }
    return { action: 'focus', client, navigate: !alreadyAt(client.url, path, origin) };
  }
  return { action: 'open' };
}

/** Execute a plan. Every step is best-effort: `navigate` may be unsupported or
    refused (then the focused app is simply left where it was — the badge/status
    in the UI still shows what needs attention), and a failed `openWindow`
    (popup policy) has nothing left to fall back to. */
export async function runClick<C extends ClientLike>(
  plan: ClickPlan<C>,
  path: string,
  openWindow: (url: string) => Promise<unknown>,
): Promise<void> {
  if (plan.action === 'open') {
    await openWindow(path).catch(() => undefined);
    return;
  }
  await plan.client.focus().catch(() => undefined);
  if (plan.navigate && typeof plan.client.navigate === 'function') {
    await plan.client.navigate(path).catch(() => undefined);
  }
}
