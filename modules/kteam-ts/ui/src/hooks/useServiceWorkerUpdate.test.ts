// THE UPDATE LIFECYCLE, tested without a browser (plan §4.4, audit C2).
//
// `applyUpdate`'s two branches are the reason this file exists. The no-waiter
// branch is only reachable in a real browser after FOUR sequential deploys with
// a tab held open throughout — so it will never be exercised by hand, and a
// future edit that "simplifies" the branch away would look correct in every
// manual check while silently breaking the one path that rescues a stuck reader.
// Here it is one assertion.
//
// The registration/visibility plumbing needs a real document and is covered by
// the browser gate; what is asserted here is every decision that is pure.

import { describe, expect, test } from 'bun:test';
import {
  WORKER_SCOPE,
  applyDecision,
  canRegister,
  runApplyUpdate,
  workerUrl,
  type ApplyDeps,
  type WaitingRegistration,
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
