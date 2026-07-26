// SERVICE-WORKER LIFECYCLE (Stage D, plan §4.4 "Update UX").
//
// The whole lifecycle lives in this module rather than in App.tsx so it is
// TESTABLE: registration, the visibility-driven update check, the waiting-worker
// bridge, the no-waiter recovery branch and the single-reload guard are all
// exported functions over injected dependencies. The React hook is a thin shell
// over them. The two `applyUpdate` branches are the part most likely to be
// "simplified" into one, and the no-waiter branch is unreachable in casual
// manual testing (it needs four sequential deploys), so it has to be provable
// without a browser.
//
// WHAT THE READER SEES: one chip in the AppBar. Never a modal, never an
// auto-reload. A reload discards unsent composer text and scroll position, so it
// only ever happens because someone clicked.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Compiled in by vite.config.ts `define`. A literal, so if the define is ever
 *  dropped this is a build-time "cannot find name" rather than the string
 *  "undefined" silently landing inside a worker URL. */
declare const __KTEAM_RELEASE__: string;

/** The release this bundle belongs to. Read through a function so tests can
 *  exercise the URL shape without the define existing. */
export function currentRelease(): string {
  return __KTEAM_RELEASE__;
}

/** The worker script URL for a release. MUST match `workerName()` in
 *  scripts/release.ts — asserted by a test, since a silent divergence here
 *  registers a 404 and the app simply never gets a worker. */
export function workerUrl(release: string): string {
  return `/sw.${release}.js`;
}

/** Root scope, identical on every release — that is what makes a new script URL
 *  update the ONE existing registration instead of adding a second (plan §4.4,
 *  C4). A root-level script already has maximum default scope, so no
 *  `Service-Worker-Allowed` header is involved. */
export const WORKER_SCOPE = '/';

/** Why the chip is up. `null` = no chip.
 *
 *  The distinction is honest wording, not cosmetics: a normal update is an offer
 *  ("there is a newer version"), while recovery means something in this tab has
 *  ALREADY failed to load and the reader is stuck until they reload. Telling
 *  them the second is the first would be a lie about the state of their tab. */
export type UpdateReason = 'update' | 'recovery';

export interface ServiceWorkerUpdate {
  /** Non-null when the chip should be shown. */
  updateReady: UpdateReason | null;
  /** Chip click. Idempotent per action — see `applyUpdate`. */
  applyUpdate: () => void;
}

/* ---------- capability gate ----------------------------------------------- */

/** Service workers exist only in secure contexts, and `localhost` counts as one
 *  — which matters here because the daemon is reached at `http://127.0.0.1:7337`
 *  and a naive `location.protocol === 'https:'` check would disable the entire
 *  feature in normal use.
 *
 *  `isSecureContext` is the property that already encodes the real rule
 *  (including the loopback exception), so it is what we ask. The `serviceWorker`
 *  presence check covers Firefox private windows, where the property exists on
 *  the prototype but the API is unavailable. */
export function canRegister(nav: Partial<Navigator> | undefined, secure: boolean | undefined): boolean {
  return Boolean(secure) && Boolean(nav && 'serviceWorker' in nav && nav.serviceWorker);
}

/* ---------- the two-branch apply (plan §4.4, C2) --------------------------- */

/** The minimum registration surface both branches need. Structural, so a test
 *  can supply a plain object and a browser supplies the real thing. */
export interface WaitingRegistration {
  waiting: { postMessage: (message: unknown) => void } | null;
}

export type ApplyDecision =
  /** A waiting worker exists: arm this tab's guarded reload, then tell it to
      skip waiting. The reload happens on `controllerchange`. */
  | 'skip-waiting'
  /** No waiting worker: reload directly, right now. */
  | 'direct-reload'
  /** Already acted on this chip press — do nothing at all. */
  | 'already-armed';

/** Decide what a chip press does.
 *
 *  THE BRANCH IS LOAD-BEARING (C2). The supported degradation path — a tab open
 *  across four deploys whose cache has been pruned — has the root registration's
 *  ACTIVE worker already at the newest release and `waiting === null`. Posting
 *  `SKIP_WAITING` to a nonexistent waiter is a no-op, so `controllerchange`
 *  could never fire, so a single-branch implementation leaves the reader looking
 *  at a chip that does nothing, forever, on the one code path that exists
 *  specifically to rescue them. Hence: no waiter → reload directly.
 *
 *  `alreadyArmed` collapses double-clicks and a second press while the first is
 *  in flight into one action. */
export function applyDecision(registration: WaitingRegistration | null, alreadyArmed: boolean): ApplyDecision {
  if (alreadyArmed) return 'already-armed';
  return registration?.waiting ? 'skip-waiting' : 'direct-reload';
}

export interface ApplyDeps {
  /** FRESH lookup, never hook state. Between the chip appearing and the click,
   *  the worker may have activated on its own (another tab took the update) or
   *  the registration may have been replaced. Deciding from a remembered
   *  `waiting` reference would take the wrong branch on exactly the races this
   *  design exists to survive. */
  getRegistration: () => Promise<WaitingRegistration | null>;
  /** Arms the one-shot `controllerchange` reload for THIS tab only. */
  armReload: () => void;
  reload: () => void;
  /** Read+set the one-shot guard so exactly one reload happens per press. */
  isArmed: () => boolean;
  setArmed: () => void;
}

/** Run a chip press. Exported (rather than living inside the hook's callback) so
 *  both branches are directly assertable. */
export async function runApplyUpdate(deps: ApplyDeps): Promise<ApplyDecision> {
  if (deps.isArmed()) return 'already-armed';
  // A rejected lookup (private mode revoking mid-session) must not strand the
  // reader: treat it as "no waiter" and reload, which is the recovery branch.
  const registration = await deps.getRegistration().catch(() => null);
  const decision = applyDecision(registration, deps.isArmed());
  if (decision === 'already-armed') return decision;

  deps.setArmed();
  if (decision === 'skip-waiting') {
    // ORDER MATTERS: arm before posting. `skipWaiting()` can activate fast
    // enough that `controllerchange` fires before the next statement runs, and
    // a listener attached after that point would miss the only event it exists
    // to hear.
    deps.armReload();
    registration!.waiting!.postMessage({ type: 'SKIP_WAITING' });
  } else {
    deps.reload();
  }
  return decision;
}

/* ---------- the hook ------------------------------------------------------- */

export function useServiceWorkerUpdate(): ServiceWorkerUpdate {
  const [updateReady, setUpdateReady] = useState<UpdateReason | null>(null);

  /** One-shot reload guard, per chip press.
   *
   *  A ref, not state: it must be readable and writable synchronously inside an
   *  event handler, and a re-render is neither needed nor wanted. Its job is to
   *  make a reload loop impossible — if the navigation after a direct reload
   *  itself fails, the fresh page's guard starts false but nothing has armed it,
   *  so the offline/error surface takes over instead of a reload cycle. */
  const armed = useRef(false);

  useEffect(() => {
    if (!canRegister(navigator, window.isSecureContext)) return;
    const container = navigator.serviceWorker;

    let cancelled = false;
    let registration: ServiceWorkerRegistration | null = null;
    const cleanups: Array<() => void> = [];

    /** `updatefound` fires when a new worker starts installing; it becomes
     *  actionable only once it reaches `installed` (i.e. waiting). Watching the
     *  installing worker's state rather than polling `registration.waiting`
     *  means the chip appears the moment the update is genuinely ready. */
    const watchInstalling = (worker: ServiceWorker | null): void => {
      if (!worker) return;
      const onState = () => {
        // `installed` while another worker controls the page = waiting. Without
        // a controller this is the FIRST install, which is not an update and
        // must not raise a chip — there is nothing newer to move to.
        if (worker.state === 'installed' && container.controller) {
          setUpdateReady(prev => prev ?? 'update');
        }
      };
      worker.addEventListener('statechange', onState);
      cleanups.push(() => worker.removeEventListener('statechange', onState));
      onState();
    };

    void container
      .register(workerUrl(currentRelease()), { scope: WORKER_SCOPE })
      .then(reg => {
        if (cancelled) return;
        registration = reg;

        // Already waiting when we registered (installed during a previous visit
        // and never taken): the chip must appear without waiting for an event
        // that has already fired.
        if (reg.waiting && container.controller) setUpdateReady(prev => prev ?? 'update');
        watchInstalling(reg.installing);

        const onUpdateFound = () => watchInstalling(reg.installing);
        reg.addEventListener('updatefound', onUpdateFound);
        cleanups.push(() => reg.removeEventListener('updatefound', onUpdateFound));
      })
      .catch((error: unknown) => {
        // A failed registration must never break the app: without a worker the
        // UI simply has no offline shell and no chip. Logged, not surfaced.
        console.warn('kteam: service worker registration failed', error);
      });

    // UPDATE CHECKS ON RETURN, NOT ON A TIMER. The browser revalidates the
    // worker script on navigation, but this app is a long-lived SPA that a
    // reader may leave open for days without ever navigating. Checking when the
    // tab becomes visible again ties the check to the moment it can be acted on,
    // and costs one conditional request.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

    return () => {
      cancelled = true;
      for (const off of cleanups) off();
    };
  }, []);

  // VITE'S NAMESPACED EVENT — `vite:preloadError`, not `preloadError`.
  //
  // This is the fourth-generation eviction surfacing (plan §4.4/B3): a tab whose
  // generation's cache has been pruned tries to lazy-load its chat chunk, the
  // URL is gone from both cache and server, and the dynamic import rejects.
  // `preventDefault()` stops it becoming an unhandled rejection, and the chip
  // comes up in RECOVERY wording — this tab is already broken, and the reader
  // needs to know a reload is the fix rather than reading a spinner forever.
  useEffect(() => {
    const onPreloadError = (event: Event) => {
      event.preventDefault();
      setUpdateReady('recovery');
    };
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => window.removeEventListener('vite:preloadError', onPreloadError);
  }, []);

  const applyUpdate = useCallback(() => {
    void runApplyUpdate({
      getRegistration: () =>
        canRegister(navigator, window.isSecureContext)
          ? navigator.serviceWorker.getRegistration(WORKER_SCOPE).then(reg => reg ?? null)
          : Promise.resolve(null),
      armReload: () => {
        // Scoped to THIS tab, and only on this branch: a tab that never took the
        // waiting-worker path never attaches a `controllerchange` listener, so
        // it can never be reloaded out from under its reader by someone else's
        // update. `once` plus the armed guard means exactly one reload.
        navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
      },
      reload: () => window.location.reload(),
      isArmed: () => armed.current,
      setArmed: () => {
        armed.current = true;
      },
    });
  }, []);

  return { updateReady, applyUpdate };
}
