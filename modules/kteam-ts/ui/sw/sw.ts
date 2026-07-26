/* ============================================================================
   APP-SHELL SERVICE WORKER ENTRY (Stage D, plan §4.4)

   Bundled by scripts/postbuild-pwa.ts to `/sw.<RELEASE_ID>.js` and registered at
   root scope by src/hooks/useServiceWorkerUpdate.ts.

   This file is deliberately THIN. It is the only place that imports the
   generated `precache.gen.ts`, and its whole job is to bind that build-specific
   data to the pure decisions in `policy.ts` and attach them to real events.
   Every rule worth testing — what may be cached, what must never be, how
   generations are retained and pruned — lives in `policy.ts`, which imports no
   generated code and is therefore testable on a clean checkout.

   ── WHY A FINGERPRINTED SCRIPT URL ────────────────────────────────────────
   Registrations are keyed by (origin, scope). The scope literal is always `/`,
   so a new script URL at the same scope UPDATES THE ONE EXISTING REGISTRATION
   rather than creating a second one; the changed URL is what starts the
   install path, and it also sidesteps any immutable HTTP-cache hit on the
   previous worker script (the api-server serves every fingerprinted static
   `immutable`, which would otherwise pin the old worker for a year).

   ── NO clients.claim() ────────────────────────────────────────────────────
   Claiming is omitted because it would seize the uncontrolled first-visit page.
   It does NOT protect already-controlled tabs from an update: a skipWaiting
   activation transfers every client of the replaced worker and fires
   `controllerchange` in each one. Open tabs keep their old worker only while the
   update sits in `waiting`. After any tab takes the update chip, old tabs' lazy
   chunks remain available because the new worker serves from every retained
   generation's shell cache.
   ============================================================================ */

import { PRECACHE_URLS, RELEASE_ID } from './precache.gen';
import { activateRelease, fetchPolicy, installRelease, respond } from './policy';

/* `lib: WebWorker` types `self` as WorkerGlobalScope, which lacks
   skipWaiting/clients/the extendable events. Casting once here keeps every use
   below honestly typed instead of sprinkling `as any` through the handlers. */
const scope = self as unknown as ServiceWorkerGlobalScope;

export async function onInstall(): Promise<void> {
  await installRelease(RELEASE_ID, PRECACHE_URLS, scope.location.href);
}

export async function onActivate(): Promise<void> {
  await activateRelease(RELEASE_ID);
}

/** Wire the worker's events. Exported and called conditionally (bottom of file)
    so importing this module from a test does not attach listeners to the test
    runner's global scope. */
export function registerWorkerEvents(sw: ServiceWorkerGlobalScope): void {
  sw.addEventListener('install', event => {
    // NOT skipWaiting(): the new worker must sit in `waiting` until the reader
    // takes the update chip. That protection lasts only until the first chip
    // click anywhere in the origin; activation then transfers all controlled
    // clients, while retained-cache serving protects their old lazy chunks.
    event.waitUntil(onInstall());
  });

  sw.addEventListener('activate', event => {
    event.waitUntil(onActivate());
  });

  sw.addEventListener('fetch', event => {
    const request = event.request;
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return; // Unparseable: not ours to handle.
    }
    const policy = fetchPolicy(request.method, url, sw.location.origin, request.mode === 'navigate');
    if (policy === 'passthrough') return;
    event.respondWith(respond(request, policy, RELEASE_ID) as Promise<Response>);
  });

  sw.addEventListener('message', event => {
    // The ONLY message this worker honours. Sent by `applyUpdate` to the
    // waiting worker after that tab has armed its single guarded reload.
    if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
      void sw.skipWaiting();
    }
  });
}

/* Real worker only. In a test runner `ServiceWorkerGlobalScope` is undefined, so
   the module imports as a plain library. */
if (typeof ServiceWorkerGlobalScope !== 'undefined' && scope instanceof ServiceWorkerGlobalScope) {
  registerWorkerEvents(scope);
}
