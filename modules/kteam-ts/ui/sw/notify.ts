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
