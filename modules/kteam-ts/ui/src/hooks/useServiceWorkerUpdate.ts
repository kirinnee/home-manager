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
  /** Raise the recovery chip from outside the hook.
   *
   *  `vite:preloadError` is not the only way this tab learns it is broken: a
   *  rejected `React.lazy` surfaces as a render-time throw that only an error
   *  boundary sees (`components/ChunkErrorBoundary.tsx`). Both routes must end
   *  in the SAME state transition, so the boundary calls this rather than
   *  owning a second, subtly different piece of chip state. */
  raiseRecovery: () => void;
}

/** The chip's state transition, as a pure function so the priority rule is
 *  assertable without a React tree.
 *
 *  TWO RULES, AND THEY POINT THE SAME WAY: recovery is never downgraded to
 *  update, and update is always UPGRADED to recovery. `recovery` is a statement
 *  about this tab — something in it has already failed to load and it is stuck
 *  until reloaded — which stays true no matter what the worker does afterwards,
 *  and becomes true the moment anything fails even if a routine update offer
 *  got there first. Telling a stuck reader "Update ready" would be a lie about
 *  the state of their tab in exactly the case where they most need the truth. */
export function nextUpdateReason(prev: UpdateReason | null, next: UpdateReason): UpdateReason {
  if (prev === 'recovery' || next === 'recovery') return 'recovery';
  return prev ?? next;
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

/* ---------- injectable browser surfaces -----------------------------------
   The registration/listener lifecycle below used to live inline in the hook's
   effects, where the only way to reach it was to mount a component in a real
   DOM — so nothing tested it, and deleting either effect left the suite green.

   These structural interfaces are the narrowest slice of the real APIs the
   lifecycle actually touches, so a test supplies plain objects and a browser
   supplies `navigator.serviceWorker` / `document` / `window` unchanged. The point
   is that the tests drive the SAME functions the hook calls, rather than a
   reimplementation of them that can drift.
   -------------------------------------------------------------------------- */

/** `addEventListener`/`removeEventListener`, and nothing else. No options
    parameter: the lifecycle never passes one (the single `once` listener lives in
    `browserApplyDeps`, which declares its own surface). */
export interface ListenerTarget {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

export interface WorkerLike extends ListenerTarget {
  readonly state: string;
}

export interface RegistrationLike extends ListenerTarget {
  readonly installing: WorkerLike | null;
  readonly waiting: unknown;
  update: () => Promise<unknown>;
}

export interface ContainerLike {
  readonly controller: unknown;
  register: (url: string, options: { scope: string }) => Promise<RegistrationLike>;
}

/** Only `visibilityState` is read; the listener half is the target above. */
export interface VisibilityTarget extends ListenerTarget {
  readonly visibilityState: string;
}

export interface WorkerLifecycleDeps {
  container: ContainerLike;
  doc: VisibilityTarget;
  /** The release to register. Injected rather than read from `currentRelease()`
      in here, because that reads a build-time `define` which does not exist
      outside a Vite bundle — the hook reads it, so this stays callable from a
      test without stubbing a global. */
  release: string;
  /** Called when a chip should appear. Called more than once is fine — the hook
      collapses repeats and never downgrades a `recovery` chip. */
  onUpdateReady: (reason: UpdateReason) => void;
  /** Registration failure reporting, injected so a test can assert it is
      swallowed rather than thrown. */
  onError: (error: unknown) => void;
}

/** Register the worker and watch for updates. Returns the cleanup function.
 *
 *  This IS the hook's effect body — the hook passes the real browser objects and
 *  returns this function directly. Everything it does is consequential and was
 *  previously unprovable:
 *
 *    * registering at the fixed root scope (a wrong scope silently creates a
 *      second registration instead of updating the one that exists),
 *    * raising the chip only once an installing worker reaches `installed`
 *      AND a controller exists (without that second condition the FIRST install
 *      would show an "update ready" chip with nothing newer to move to),
 *    * catching a registration rejection instead of letting it break the app,
 *    * re-checking on tab visibility, because a long-lived SPA may never
 *      navigate,
 *    * removing every listener on unmount. */
export function startWorkerLifecycle(deps: WorkerLifecycleDeps): () => void {
  const { container, doc, release, onUpdateReady, onError } = deps;
  let cancelled = false;
  let registration: RegistrationLike | null = null;
  const cleanups: Array<() => void> = [];

  /** `updatefound` fires when a new worker starts installing; it becomes
   *  actionable only once it reaches `installed` (i.e. waiting). Watching the
   *  installing worker's state rather than polling `registration.waiting` means
   *  the chip appears the moment the update is genuinely ready. */
  const watchInstalling = (worker: WorkerLike | null): void => {
    if (!worker) return;
    const onState = () => {
      // `installed` while another worker controls the page = waiting. Without a
      // controller this is the FIRST install, which is not an update and must not
      // raise a chip — there is nothing newer to move to.
      if (worker.state === 'installed' && container.controller) onUpdateReady('update');
    };
    worker.addEventListener('statechange', onState);
    cleanups.push(() => worker.removeEventListener('statechange', onState));
    // Called immediately as well: the worker may already have reached
    // `installed` between the event firing and this listener attaching.
    onState();
  };

  void container
    .register(workerUrl(release), { scope: WORKER_SCOPE })
    .then(reg => {
      // Unmounted while registration was in flight: attaching listeners now
      // would leak them, since the cleanup already ran.
      if (cancelled) return;
      registration = reg;

      // Already waiting when we registered (installed during a previous visit
      // and never taken): the chip must appear without waiting for an event that
      // has already fired.
      if (reg.waiting && container.controller) onUpdateReady('update');
      watchInstalling(reg.installing);

      const onUpdateFound = () => watchInstalling(reg.installing);
      reg.addEventListener('updatefound', onUpdateFound);
      cleanups.push(() => reg.removeEventListener('updatefound', onUpdateFound));
    })
    .catch((error: unknown) => {
      // A failed registration must never break the app: without a worker the UI
      // simply has no offline shell and no chip. Logged, not surfaced.
      onError(error);
    });

  // UPDATE CHECKS ON RETURN, NOT ON A TIMER. The browser revalidates the worker
  // script on navigation, but this app is a long-lived SPA that a reader may
  // leave open for days without ever navigating. Checking when the tab becomes
  // visible again ties the check to the moment it can be acted on, and costs one
  // conditional request.
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') void registration?.update().catch(() => {});
  };
  doc.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));

  return () => {
    cancelled = true;
    for (const off of cleanups) off();
  };
}

/** VITE'S NAMESPACED EVENT — `vite:preloadError`, not `preloadError`.
 *
 *  This is the fourth-generation eviction surfacing (plan §4.4/B3): a tab whose
 *  generation's cache has been pruned tries to lazy-load its chat chunk, the URL
 *  is gone from both cache and server, and the dynamic import rejects.
 *  `preventDefault()` stops it becoming an unhandled rejection, and the chip
 *  comes up in RECOVERY wording — this tab is already broken, and the reader
 *  needs to know a reload is the fix rather than reading a spinner forever.
 *
 *  HALF THE STORY, AND THE HALF THAT CANNOT SAVE THE PAGE ON ITS OWN.
 *  `preventDefault()` suppresses only the global unhandled-rejection surface;
 *  the `React.lazy` promise still rejects and React still rethrows it during
 *  render. Stage E measured what that costs with nothing catching it: the root
 *  unmounts, `#root` is emptied and the chip this watch just raised is
 *  destroyed along with it (`drill-nocache.json`, `rootChildren: 0`,
 *  `chip: null`). The render-time half is caught by `ChunkErrorBoundary`, which
 *  raises recovery through the same `raiseRecovery` this does. The two are a
 *  pair — dropping either one puts the reader back on a blank page.
 *
 *  Watched unconditionally, with no service-worker gate: a preload can fail on a
 *  plain redeploy with no worker involved at all, and the reader is just as stuck.
 *  Returns the cleanup function. */
export function startPreloadErrorWatch(win: ListenerTarget, onRecovery: () => void): () => void {
  const onPreloadError = (event: Event) => {
    event.preventDefault();
    onRecovery();
  };
  win.addEventListener('vite:preloadError', onPreloadError);
  return () => win.removeEventListener('vite:preloadError', onPreloadError);
}

/* ---------- the real ApplyDeps --------------------------------------------- */

export interface ApplyContainer {
  getRegistration: (scope: string) => Promise<WaitingRegistration | null | undefined>;
  addEventListener: (type: string, listener: () => void, options: { once: true }) => void;
}

export interface ApplyEnv {
  /** `null` when service workers are unavailable — then there is no registration
      to consult and the recovery reload is the only sensible action. */
  container: ApplyContainer | null;
  reload: () => void;
  isArmed: () => boolean;
  setArmed: () => void;
}

/** Build the real `ApplyDeps` from browser objects.
 *
 *  Separated from the hook so the CONTROLLER ADAPTER is testable: `armReload`
 *  attaching a `once` `controllerchange` listener that reloads is the mechanism
 *  the whole skip-waiting branch depends on, and it is invisible to a test that
 *  only checks `runApplyUpdate`'s decisions against a stub. */
export function browserApplyDeps(env: ApplyEnv): ApplyDeps {
  const { container } = env;
  return {
    getRegistration: () =>
      container ? container.getRegistration(WORKER_SCOPE).then(reg => reg ?? null) : Promise.resolve(null),
    armReload: () => {
      // Scoped to THIS tab, and only on this branch: a tab that never took the
      // waiting-worker path never attaches a `controllerchange` listener, so it
      // can never be reloaded out from under its reader by someone else's
      // update. `once` plus the armed guard means exactly one reload.
      //
      // WHAT THIS DOES NOT MEAN. It is a guarantee about RELOADS, not about the
      // controller. Stage E measured the difference: when any tab on the origin
      // takes an update, `skipWaiting()` activation transfers EVERY client of
      // the replaced worker, so an untouched tab is silently repointed to the
      // new worker and receives `controllerchange` without ever having armed
      // anything (`drill-main.txt` step5: 0 listeners, 0 postMessages, load
      // count unchanged). It is not reloaded — that is what this guard buys —
      // and being repointed is safe because the fetch policy serves any
      // RETAINED generation's cache, not just the active worker's own.
      container?.addEventListener('controllerchange', () => env.reload(), { once: true });
    },
    reload: env.reload,
    isArmed: env.isArmed,
    setArmed: env.setArmed,
  };
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

  // Recovery wins in both directions — see `nextUpdateReason`.
  const raise = useCallback((reason: UpdateReason) => {
    setUpdateReady(prev => nextUpdateReason(prev, reason));
  }, []);

  // ONE recovery entry point for both halves of the failure surface: the
  // preload watch below and `ChunkErrorBoundary`'s render-time catch.
  const raiseRecovery = useCallback(() => raise('recovery'), [raise]);

  useEffect(() => {
    if (!canRegister(navigator, window.isSecureContext)) return;
    return startWorkerLifecycle({
      container: navigator.serviceWorker as unknown as ContainerLike,
      doc: document,
      release: currentRelease(),
      onUpdateReady: raise,
      onError: error => console.warn('kteam: service worker registration failed', error),
    });
  }, [raise]);

  useEffect(() => startPreloadErrorWatch(window, raiseRecovery), [raiseRecovery]);

  const applyUpdate = useCallback(() => {
    void runApplyUpdate(
      browserApplyDeps({
        container: canRegister(navigator, window.isSecureContext)
          ? (navigator.serviceWorker as unknown as ApplyContainer)
          : null,
        reload: () => window.location.reload(),
        isArmed: () => armed.current,
        setArmed: () => {
          armed.current = true;
        },
      }),
    );
  }, []);

  return { updateReady, applyUpdate, raiseRecovery };
}
