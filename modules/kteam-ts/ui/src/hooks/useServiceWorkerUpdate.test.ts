// THE UPDATE LIFECYCLE, tested without a browser (plan §4.4, audit C2).
//
// `applyUpdate`'s two branches are the reason this file exists. The no-waiter
// branch is only reachable in a real browser after FOUR sequential deploys with
// a tab held open throughout — so it will never be exercised by hand, and a
// future edit that "simplifies" the branch away would look correct in every
// manual check while silently breaking the one path that rescues a stuck reader.
// Here it is one assertion.
//
// The registration/visibility/preload plumbing is asserted too, by injecting
// fakes into `startWorkerLifecycle`, `startPreloadErrorWatch` and
// `browserApplyDeps` — the SAME functions the hook calls, not a copy of them. The
// hook itself is then a five-line shell whose only untested part is wiring React
// state to those callbacks, which the browser gate covers.

import { describe, expect, test } from 'bun:test';
import {
  WORKER_SCOPE,
  applyDecision,
  browserApplyDeps,
  canRegister,
  runApplyUpdate,
  startPreloadErrorWatch,
  startWorkerLifecycle,
  workerUrl,
  type ApplyContainer,
  type ApplyDeps,
  type ContainerLike,
  type ListenerTarget,
  type RegistrationLike,
  type UpdateReason,
  type VisibilityTarget,
  type WaitingRegistration,
  type WorkerLike,
} from './useServiceWorkerUpdate';
import { RELEASE_ID_RE, workerName } from '../../scripts/release';

/** Records what each branch actually did. */
function harness(registration: WaitingRegistration | null, opts: { rejects?: boolean } = {}) {
  const calls = { armReload: 0, reload: 0, posted: [] as unknown[] };
  let armed = false;
  const deps: ApplyDeps = {
    getRegistration: () => (opts.rejects ? Promise.reject(new Error('revoked')) : Promise.resolve(registration)),
    armReload: () => {
      calls.armReload += 1;
    },
    reload: () => {
      calls.reload += 1;
    },
    isArmed: () => armed,
    setArmed: () => {
      armed = true;
    },
  };
  return { deps, calls, isArmed: () => armed };
}

function waitingRegistration() {
  const posted: unknown[] = [];
  const registration: WaitingRegistration = {
    waiting: { postMessage: (message: unknown) => void posted.push(message) },
  };
  return { registration, posted };
}

describe('applyDecision', () => {
  test('a waiting worker takes the skip-waiting branch', () => {
    expect(applyDecision(waitingRegistration().registration, false)).toBe('skip-waiting');
  });

  // THE C2 BRANCH. After a fourth deploy prunes an old tab's cache, the root
  // registration's ACTIVE worker is already the newest release and `waiting` is
  // null. Posting SKIP_WAITING to a nonexistent waiter is a no-op, so
  // `controllerchange` could never fire and a single-branch implementation would
  // leave the chip dead on the one path that exists to rescue the reader.
  test('no waiting worker takes the direct-reload branch', () => {
    expect(applyDecision({ waiting: null }, false)).toBe('direct-reload');
  });

  test('no registration at all also reloads directly rather than doing nothing', () => {
    expect(applyDecision(null, false)).toBe('direct-reload');
  });

  test('an already-armed press does nothing, in either shape', () => {
    expect(applyDecision(waitingRegistration().registration, true)).toBe('already-armed');
    expect(applyDecision({ waiting: null }, true)).toBe('already-armed');
  });
});

describe('runApplyUpdate — waiting-worker branch', () => {
  test('arms the reload and posts SKIP_WAITING exactly once', async () => {
    const { registration, posted } = waitingRegistration();
    const { deps, calls } = harness(registration);

    expect(await runApplyUpdate(deps)).toBe('skip-waiting');
    expect(calls.armReload).toBe(1);
    expect(posted).toEqual([{ type: 'SKIP_WAITING' }]);
    // The reload comes from `controllerchange`, not from here — calling both
    // would reload twice.
    expect(calls.reload).toBe(0);
  });

  test('a second press is a no-op: one reload per action', async () => {
    const { registration, posted } = waitingRegistration();
    const { deps, calls } = harness(registration);

    await runApplyUpdate(deps);
    expect(await runApplyUpdate(deps)).toBe('already-armed');
    expect(calls.armReload).toBe(1);
    expect(posted).toHaveLength(1);
  });
});

describe('runApplyUpdate — no-waiter recovery branch (C2)', () => {
  // The exact assertion the audit asked for: one direct reload, no message
  // posted, and no controllerchange listener armed.
  test('reloads directly, posts nothing, arms no listener', async () => {
    const { deps, calls } = harness({ waiting: null });

    expect(await runApplyUpdate(deps)).toBe('direct-reload');
    expect(calls.reload).toBe(1);
    expect(calls.armReload).toBe(0);
    expect(calls.posted).toEqual([]);
  });

  test('exactly one reload even if the chip is pressed repeatedly', async () => {
    const { deps, calls } = harness({ waiting: null });

    await runApplyUpdate(deps);
    await runApplyUpdate(deps);
    await runApplyUpdate(deps);
    expect(calls.reload).toBe(1);
  });

  test('a rejected registration lookup still rescues the reader', async () => {
    // Private mode revoking the API mid-session, or a browser that throws here.
    // Doing nothing would strand a reader whose tab is already broken.
    const { deps, calls } = harness(null, { rejects: true });
    expect(await runApplyUpdate(deps)).toBe('direct-reload');
    expect(calls.reload).toBe(1);
  });
});

describe('both branches are load-bearing', () => {
  // A mutation check expressed as a test: the two registration shapes must lead
  // to DIFFERENT observable behaviour. If someone collapses the branch, one of
  // these two assertions fails whichever way they collapse it.
  test('the same press does different things depending on registration shape', async () => {
    const withWaiter = harness(waitingRegistration().registration);
    const withoutWaiter = harness({ waiting: null });

    await runApplyUpdate(withWaiter.deps);
    await runApplyUpdate(withoutWaiter.deps);

    expect([withWaiter.calls.reload, withWaiter.calls.armReload]).toEqual([0, 1]);
    expect([withoutWaiter.calls.reload, withoutWaiter.calls.armReload]).toEqual([1, 0]);
  });
});

describe('registration inputs', () => {
  // A divergence from workerName() registers a 404 and the app simply never gets
  // a worker — with no error anywhere the reader could see.
  test('the worker URL matches the build script name', () => {
    expect(workerUrl('93c72ea3f8b3')).toBe(`/${workerName('93c72ea3f8b3')}`);
    expect(workerUrl('aaaaaaaaaaaa')).toBe('/sw.aaaaaaaaaaaa.js');
  });

  // Identical on every release: that is what makes a new script URL UPDATE the
  // one existing registration rather than adding a second (C4).
  test('the scope is root', () => {
    expect(WORKER_SCOPE).toBe('/');
  });

  test('release ids in worker URLs are 12-hex', () => {
    expect('93c72ea3f8b3').toMatch(RELEASE_ID_RE);
  });
});

/* ---------- lifecycle fakes ------------------------------------------------
   Minimal event targets that record what was attached and what was removed, so
   "listeners are cleaned up" is an assertion rather than a claim.
   -------------------------------------------------------------------------- */

/** Stands in for `currentRelease()`, which reads a Vite `define` that does not
    exist under bun:test — the reason `startWorkerLifecycle` takes the release as
    an argument instead of reading it. */
const RELEASE = '93c72ea3f8b3';

function fakeTarget() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  let added = 0;
  let removed = 0;
  const target = {
    addEventListener(type: string, listener: (event: Event) => void) {
      added += 1;
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      removed += 1;
      listeners.get(type)?.delete(listener);
    },
  };
  const emit = (type: string, event: Partial<Event> = {}) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event as Event);
  };
  return {
    target,
    emit,
    count: (type: string) => listeners.get(type)?.size ?? 0,
    stats: () => ({ added, removed }),
  };
}

function fakeWorker(state = 'installing') {
  const events = fakeTarget();
  const worker = { ...events.target, state } as WorkerLike & { state: string };
  return {
    worker,
    /** Move to a new state and fire `statechange`, as a browser does. */
    transition(next: string) {
      worker.state = next;
      events.emit('statechange');
    },
    events,
  };
}

function fakeRegistration(opts: { installing?: WorkerLike | null; waiting?: unknown } = {}) {
  const events = fakeTarget();
  const updates: number[] = [];
  const registration = {
    ...events.target,
    installing: opts.installing ?? null,
    waiting: opts.waiting ?? null,
    update: async () => void updates.push(1),
  } as unknown as RegistrationLike & { installing: WorkerLike | null };
  return { registration, events, updates };
}

function fakeLifecycle(opts: {
  registration?: RegistrationLike;
  registerRejects?: unknown;
  controller?: unknown;
  visibility?: string;
}) {
  const registrations: Array<{ url: string; scope: string }> = [];
  const raised: UpdateReason[] = [];
  const errors: unknown[] = [];
  const docEvents = fakeTarget();
  const doc = { ...docEvents.target, visibilityState: opts.visibility ?? 'visible' } as unknown as VisibilityTarget & {
    visibilityState: string;
  };
  const container = {
    controller: opts.controller ?? null,
    register: (url: string, options: { scope: string }) => {
      registrations.push({ url, scope: options.scope });
      return opts.registerRejects
        ? Promise.reject(opts.registerRejects)
        : Promise.resolve(opts.registration ?? fakeRegistration().registration);
    },
  } as unknown as ContainerLike;
  return { container, doc, docEvents, registrations, raised, errors };
}

/** `startWorkerLifecycle` registers asynchronously; a microtask flush is enough
    since every fake resolves immediately. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('startWorkerLifecycle — registration', () => {
  test('registers the release worker URL at the fixed root scope', async () => {
    const env = fakeLifecycle({});
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    // A wrong scope silently creates a SECOND registration instead of updating
    // the one that exists (C4).
    expect(env.registrations).toEqual([{ url: workerUrl(RELEASE), scope: '/' }]);
    stop();
  });

  test('a rejected registration is swallowed and reported, never thrown', async () => {
    const env = fakeLifecycle({ registerRejects: new Error('no worker here') });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    expect(env.errors).toHaveLength(1);
    expect(env.raised).toEqual([]);
    stop();
  });
});

describe('startWorkerLifecycle — when the chip appears', () => {
  test('an installing worker reaching installed raises the chip', async () => {
    const installing = fakeWorker('installing');
    const reg = fakeRegistration({ installing: installing.worker });
    const env = fakeLifecycle({ registration: reg.registration, controller: {} });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    expect(env.raised).toEqual([]);
    installing.transition('installed');
    expect(env.raised).toEqual(['update']);
    stop();
  });

  // THE FIRST-INSTALL GUARD. Without the controller condition, a reader's very
  // first visit would show "Update ready — reload" with nothing newer to move to.
  test('the FIRST install (no controller) raises nothing', async () => {
    const installing = fakeWorker('installing');
    const reg = fakeRegistration({ installing: installing.worker });
    const env = fakeLifecycle({ registration: reg.registration, controller: null });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    installing.transition('installed');
    expect(env.raised).toEqual([]);
    stop();
  });

  test('a worker already waiting at registration raises the chip immediately', async () => {
    // Installed during a previous visit and never taken: the event has already
    // fired, so polling `waiting` at registration is the only way to see it.
    const reg = fakeRegistration({ waiting: { postMessage: () => {} } });
    const env = fakeLifecycle({ registration: reg.registration, controller: {} });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    expect(env.raised).toEqual(['update']);
    stop();
  });

  test('a worker already at installed when watched raises without a statechange', async () => {
    // The state can be reached between `updatefound` firing and the listener
    // attaching, so the handler is also invoked once up front.
    const installing = fakeWorker('installed');
    const reg = fakeRegistration({ installing: installing.worker });
    const env = fakeLifecycle({ registration: reg.registration, controller: {} });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    expect(env.raised).toEqual(['update']);
    stop();
  });

  test('updatefound picks up a worker that appeared after registration', async () => {
    const reg = fakeRegistration({ installing: null });
    const env = fakeLifecycle({ registration: reg.registration, controller: {} });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    expect(env.raised).toEqual([]);

    // A deploy lands while the tab is open: the browser sets `installing` and
    // fires `updatefound`. Reading `reg.installing` at event time (not the value
    // captured at registration) is what makes this work.
    const late = fakeWorker('installing');
    (reg.registration as unknown as { installing: WorkerLike | null }).installing = late.worker;
    reg.events.emit('updatefound');
    late.transition('installed');
    expect(env.raised).toEqual(['update']);
    stop();
  });
});

describe('startWorkerLifecycle — visibility update checks', () => {
  test('becoming visible asks the registration to check for an update', async () => {
    const reg = fakeRegistration();
    const env = fakeLifecycle({ registration: reg.registration });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    env.docEvents.emit('visibilitychange');
    expect(reg.updates).toHaveLength(1);
    stop();
  });

  test('going hidden checks nothing', async () => {
    const reg = fakeRegistration();
    const env = fakeLifecycle({ registration: reg.registration, visibility: 'hidden' });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    env.docEvents.emit('visibilitychange');
    expect(reg.updates).toEqual([]);
    stop();
  });

  test('a visibility check before registration resolves does not throw', () => {
    const env = fakeLifecycle({});
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    // No await: `registration` is still null here.
    expect(() => env.docEvents.emit('visibilitychange')).not.toThrow();
    stop();
  });

  test('a rejected update() is swallowed', async () => {
    const reg = fakeRegistration();
    (reg.registration as unknown as { update: () => Promise<unknown> }).update = () =>
      Promise.reject(new Error('offline'));
    const env = fakeLifecycle({ registration: reg.registration });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    env.docEvents.emit('visibilitychange');
    await settle();
    expect(env.errors).toEqual([]);
    stop();
  });
});

describe('startWorkerLifecycle — cleanup', () => {
  test('every listener attached is removed on cleanup', async () => {
    const installing = fakeWorker('installing');
    const reg = fakeRegistration({ installing: installing.worker });
    const env = fakeLifecycle({ registration: reg.registration, controller: {} });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    expect(installing.events.count('statechange')).toBe(1);
    expect(reg.events.count('updatefound')).toBe(1);
    expect(env.docEvents.count('visibilitychange')).toBe(1);

    stop();
    // Leaked listeners on a hot-reloading dev server compound into a chip that
    // fires several times per update.
    expect(installing.events.count('statechange')).toBe(0);
    expect(reg.events.count('updatefound')).toBe(0);
    expect(env.docEvents.count('visibilitychange')).toBe(0);
  });

  test('nothing fires after cleanup', async () => {
    const installing = fakeWorker('installing');
    const reg = fakeRegistration({ installing: installing.worker });
    const env = fakeLifecycle({ registration: reg.registration, controller: {} });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    await settle();
    stop();
    installing.transition('installed');
    env.docEvents.emit('visibilitychange');
    expect(env.raised).toEqual([]);
    expect(reg.updates).toEqual([]);
  });

  test('unmounting while registration is in flight attaches nothing', async () => {
    const reg = fakeRegistration({ waiting: { postMessage: () => {} } });
    const env = fakeLifecycle({ registration: reg.registration, controller: {} });
    const stop = startWorkerLifecycle({
      container: env.container,
      doc: env.doc,
      release: RELEASE,
      onUpdateReady: r => env.raised.push(r),
      onError: e => env.errors.push(e),
    });
    stop(); // before the register() promise settles
    await settle();
    // The cleanup already ran, so anything attached now would leak forever.
    expect(reg.events.count('updatefound')).toBe(0);
    expect(env.raised).toEqual([]);
  });
});

describe('startPreloadErrorWatch', () => {
  test('listens for the NAMESPACED vite event, not a bare preloadError', () => {
    const win = fakeTarget();
    const stop = startPreloadErrorWatch(win.target as ListenerTarget, () => {});
    expect(win.count('vite:preloadError')).toBe(1);
    expect(win.count('preloadError')).toBe(0);
    stop();
  });

  test('calls preventDefault and raises recovery', () => {
    const win = fakeTarget();
    let recovered = 0;
    let prevented = 0;
    const stop = startPreloadErrorWatch(win.target as ListenerTarget, () => void (recovered += 1));
    // Without preventDefault this becomes an unhandled rejection in the console
    // on every pruned-generation load.
    win.emit('vite:preloadError', { preventDefault: () => void (prevented += 1) } as Partial<Event>);
    expect([recovered, prevented]).toEqual([1, 1]);
    stop();
  });

  test('cleanup removes the listener', () => {
    const win = fakeTarget();
    let recovered = 0;
    startPreloadErrorWatch(win.target as ListenerTarget, () => void (recovered += 1))();
    expect(win.count('vite:preloadError')).toBe(0);
    win.emit('vite:preloadError', { preventDefault: () => {} } as Partial<Event>);
    expect(recovered).toBe(0);
  });
});

describe('browserApplyDeps — the controller adapter', () => {
  function fakeApplyContainer(registration: WaitingRegistration | null | undefined) {
    const events = fakeTarget();
    const onceOptions: Array<{ once: true }> = [];
    const container = {
      getRegistration: async (scope: string) => {
        scopes.push(scope);
        return registration;
      },
      addEventListener: (type: string, listener: () => void, options: { once: true }) => {
        onceOptions.push(options);
        events.target.addEventListener(type, listener as (event: Event) => void);
      },
    } as unknown as ApplyContainer;
    const scopes: string[] = [];
    return { container, events, scopes, onceOptions };
  }

  function env(registration: WaitingRegistration | null | undefined) {
    const fake = fakeApplyContainer(registration);
    const calls = { reload: 0 };
    let armed = false;
    const deps = browserApplyDeps({
      container: fake.container,
      reload: () => void (calls.reload += 1),
      isArmed: () => armed,
      setArmed: () => void (armed = true),
    });
    return { ...fake, deps, calls, isArmed: () => armed };
  }

  test('looks the registration up at the ROOT scope', async () => {
    const e = env({ waiting: null });
    await e.deps.getRegistration();
    expect(e.scopes).toEqual([WORKER_SCOPE]);
  });

  test('an undefined registration is normalised to null', async () => {
    // `getRegistration()` resolves undefined when there is none; `applyDecision`
    // takes `WaitingRegistration | null`, and undefined would type-lie its way
    // into the same branch by accident rather than by intent.
    expect(await env(undefined).deps.getRegistration()).toBeNull();
  });

  // THE ADAPTER ITSELF. This listener is the entire mechanism the skip-waiting
  // branch depends on: `runApplyUpdate` posts SKIP_WAITING and never reloads, so
  // if `controllerchange` does not reload, that branch does nothing at all.
  test('armReload reloads when controllerchange fires, exactly once', () => {
    const e = env({ waiting: { postMessage: () => {} } });
    e.deps.armReload();
    expect(e.calls.reload).toBe(0);
    expect(e.onceOptions).toEqual([{ once: true }]);

    e.events.emit('controllerchange');
    expect(e.calls.reload).toBe(1);
  });

  test('no controllerchange means no reload — the listener is not fired eagerly', () => {
    const e = env({ waiting: { postMessage: () => {} } });
    e.deps.armReload();
    e.events.emit('statechange');
    expect(e.calls.reload).toBe(0);
  });

  test('with no container at all, the recovery branch still reloads', async () => {
    const calls = { reload: 0 };
    let armed = false;
    const deps = browserApplyDeps({
      container: null,
      reload: () => void (calls.reload += 1),
      isArmed: () => armed,
      setArmed: () => void (armed = true),
    });
    // Insecure context or no service-worker API: there is no registration to
    // consult, so a reader with a broken tab must still get their reload.
    expect(await runApplyUpdate(deps)).toBe('direct-reload');
    expect(calls.reload).toBe(1);
    // armReload on a null container must be a safe no-op, not a crash.
    expect(() => deps.armReload()).not.toThrow();
  });

  // END TO END through the real adapter: the waiting branch posts, arms, and
  // reloads only once the controller actually changes.
  test('a real waiting registration posts SKIP_WAITING and reloads on controllerchange', async () => {
    const posted: unknown[] = [];
    const e = env({ waiting: { postMessage: (message: unknown) => void posted.push(message) } });

    expect(await runApplyUpdate(e.deps)).toBe('skip-waiting');
    expect(posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(e.calls.reload).toBe(0);

    e.events.emit('controllerchange');
    expect(e.calls.reload).toBe(1);
  });
});

describe('canRegister', () => {
  // The loopback case is the normal one here — the daemon serves
  // http://127.0.0.1:7337, so a `protocol === 'https:'` test would disable the
  // whole feature in ordinary use. `isSecureContext` already encodes the real
  // rule including the loopback exception.
  test('an insecure context is refused even with the API present', () => {
    expect(canRegister({ serviceWorker: {} as ServiceWorkerContainer }, false)).toBe(false);
    expect(canRegister({ serviceWorker: {} as ServiceWorkerContainer }, undefined)).toBe(false);
  });

  test('a secure context without the API is refused (Firefox private windows)', () => {
    expect(canRegister({}, true)).toBe(false);
    expect(canRegister(undefined, true)).toBe(false);
  });

  test('a secure context with the API is accepted', () => {
    expect(canRegister({ serviceWorker: {} as ServiceWorkerContainer }, true)).toBe(true);
  });
});
