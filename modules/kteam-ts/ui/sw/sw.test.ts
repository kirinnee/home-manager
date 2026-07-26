// WORKER CONTRACT TESTS (Stage D, plan §6 "SW scope/cache/token").
//
// The worker's handlers need a real ServiceWorkerGlobalScope, which bun:test
// does not have — so `policy.ts` holds its decisions as pure functions and the
// `sw.ts` entry registers listeners only in a genuine worker scope. What is
// tested here is every decision that has a security or correctness consequence:
//
//   * that NOTHING token-bearing or session-bearing can reach CacheStorage,
//   * that the retention contract keeps exactly current + two previous,
//   * that install fails rather than half-populating a cache.
//
// IMPORTS `./policy`, NEVER `./precache.gen`. The generated file is gitignored,
// so importing it here — directly or transitively through the worker entry —
// would make this whole file fail to RESOLVE on a clean checkout: not one
// assertion failing but "Cannot find module" and 0 tests reported. These are the
// tests standing between a refactor and a token in CacheStorage, so they must
// run on a fresh clone with no build. The generated list has its own invariants
// and its own file (`precache.gen.test.ts`) which skips visibly when unbuilt.
//
// The fixture list below therefore stands in for a real build. Its shape mirrors
// one — fingerprinted assets, a release-stamped offline page — because the
// policy only ever reasons about membership, never about content.

import { describe, expect, test } from 'bun:test';
import {
  API_PREFIX,
  CACHE_PREFIX,
  INDEX_CACHE,
  INDEX_KEY,
  RETAINED_GENERATIONS,
  cacheNameFor,
  cachesToDelete,
  activateRelease,
  fetchPolicy,
  installRelease,
  nextGenerationOrder,
  offlineUrl,
  precacheAll,
  reconcileGenerationOrder,
  releasesFromCacheNames,
  respond,
  retainedGenerations,
} from './policy';
import { RELEASE_ID_RE, offlineName, workerName } from '../scripts/release';

const ORIGIN = 'http://127.0.0.1:7337';

/** A stand-in for one build's generated closure. Twelve hex chars, like a real
    release id, so `offlineUrl` and `RELEASE_ID_RE` are exercised honestly. */
const RELEASE_ID = 'abc123def456';
const PRECACHE_URLS: readonly string[] = [
  '/assets/index-Co6PIgmd.css',
  '/assets/index-DAMYNxpK.js',
  '/assets/SessionChatPage-C5SeMx2W.js',
  '/icons/apple-touch-icon.1d79d00c19.png',
  '/icons/favicon.fc09cfb83e.svg',
  `/offline.${RELEASE_ID}.html`,
];
const precached = new Set(PRECACHE_URLS);

/** Install a stub `fetch`, and return a restore function.

    Bun's `fetch` type carries extra static properties (`preconnect`), so a bare
    `as typeof fetch` on a plain async function is an unsound cast TypeScript
    rightly rejects. The stub only ever needs to be CALLED, so the properties are
    genuinely irrelevant — this narrows the lie to one place that says so, rather
    than repeating `as unknown as typeof fetch` at seven call sites. */
function stubFetch(impl: (input: Request | string | URL) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  const stub = ((input: Request | string | URL) => impl(input)) as unknown as typeof fetch;
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = original;
  };
}

function policy(path: string, opts: { method?: string; navigate?: boolean; origin?: string } = {}) {
  return fetchPolicy(
    opts.method ?? 'GET',
    new URL(path, opts.origin ?? ORIGIN),
    ORIGIN,
    precached,
    opts.navigate ?? false,
  );
}

describe('fetch policy — what may never be cached', () => {
  // THE CORE TOKEN GUARANTEE. index.html carries the daemon's loopback token,
  // substituted per request. If a navigation were ever cacheable the token would
  // be written into CacheStorage, where it outlives the tab.
  test('navigations are network-only, never cache-first', () => {
    expect(policy('/', { navigate: true })).toBe('navigate');
    expect(policy('/sessions/abc', { navigate: true })).toBe('navigate');
    expect(policy('/anything/at/all', { navigate: true })).toBe('navigate');
  });

  // Even if a list ever DID name the shell, the policy must not serve it from a
  // cache: `/` is caught by the navigate branch above, and `/index.html`
  // reached as a subresource is plain network. The list-side half of this
  // guarantee ("the build never puts them in the list") is asserted against the
  // real generated list in precache.gen.test.ts.
  test('index.html is never cache-first, even as a non-navigation request', () => {
    expect(policy('/index.html')).toBe('network');
    expect(policy('/index.html', { navigate: true })).toBe('navigate');
  });

  // EVERY /v1 SHAPE, because these carry transcripts, session metadata and the
  // token in query or header. `passthrough` means the worker does not even call
  // respondWith — the request behaves as if no worker existed.
  test.each([
    '/v1/sessions',
    '/v1/sessions/abc/messages',
    '/v1/events',
    '/v1/search?q=secret',
    '/v1/attachments/1/blob',
    '/v1',
  ])('%s is passthrough', path => {
    expect(policy(path)).toBe('passthrough');
  });

  test('a path merely starting with the letters v1 is NOT treated as API', () => {
    // Guards against a `startsWith('/v1')` bug: `/v10-icons/x.png` is a normal
    // static and must not be silently exempted from the shell rules.
    expect(policy('/v10-icons/x.png')).toBe('network');
    expect(API_PREFIX).toBe('/v1/');
  });

  test('non-GET is always passthrough, including for precached URLs', () => {
    const url = PRECACHE_URLS[0]!;
    expect(policy(url, { method: 'POST' })).toBe('passthrough');
    expect(policy(url, { method: 'HEAD' })).toBe('passthrough');
    expect(policy('/v1/sessions', { method: 'DELETE' })).toBe('passthrough');
  });

  test('cross-origin is passthrough even for an identical path', () => {
    const url = PRECACHE_URLS[0]!;
    expect(policy(url, { origin: 'https://cdn.example.com' })).toBe('passthrough');
  });

  test('precached fingerprinted statics are cache-first; unknown same-origin is network', () => {
    for (const url of PRECACHE_URLS) expect(policy(url)).toBe('cache-first');
    expect(policy('/assets/never-built-DEADBEEF.js')).toBe('network');
  });
});

// A worker cannot import a node build script, so policy.ts re-derives two names that
// scripts/release.ts also produces. Duplication is fine; SILENT divergence is
// not — a mismatch means registering a 404 or precaching a file that does not
// exist, and neither surfaces until runtime.
describe('naming agrees with the build scripts', () => {
  test('offlineUrl matches offlineName', () => {
    expect(offlineUrl(RELEASE_ID)).toBe(`/${offlineName(RELEASE_ID)}`);
  });

  test('the bundled worker filename matches workerName', () => {
    expect(workerName(RELEASE_ID)).toBe(`sw.${RELEASE_ID}.js`);
  });

  test('cache names are namespaced per release', () => {
    expect(cacheNameFor('aaaaaaaaaaaa')).toBe('kteam-shell-aaaaaaaaaaaa');
    expect(cacheNameFor(RELEASE_ID).startsWith(CACHE_PREFIX)).toBe(true);
    expect(cacheNameFor('bbbbbbbbbbbb')).not.toBe(cacheNameFor('aaaaaaaaaaaa'));
  });
});

describe('retention — current + two previous (B3)', () => {
  test('keeps exactly three generations and evicts the oldest', () => {
    let order: string[] = [];
    for (const r of ['aaa', 'bbb', 'ccc']) order = nextGenerationOrder(order, r);
    expect(retainedGenerations(order)).toEqual(['aaa', 'bbb', 'ccc']);

    order = nextGenerationOrder(order, 'ddd');
    expect(retainedGenerations(order)).toEqual(['bbb', 'ccc', 'ddd']);
    expect(RETAINED_GENERATIONS).toBe(3);
  });

  // Commit hashes do not sort, which is the whole reason an insertion-order
  // index exists. If retention ever accidentally relied on lexicographic order,
  // this ordering (descending hex) would break it.
  test('order is insertion order, not lexicographic', () => {
    let order: string[] = [];
    for (const r of ['ffffffffffff', 'aaaaaaaaaaaa', 'cccccccccccc', '111111111111']) {
      order = nextGenerationOrder(order, r);
    }
    expect(retainedGenerations(order)).toEqual(['aaaaaaaaaaaa', 'cccccccccccc', '111111111111']);
  });

  test('re-activating the same release moves it to newest without duplicating', () => {
    let order = ['aaa', 'bbb', 'ccc'];
    order = nextGenerationOrder(order, 'bbb');
    expect(order).toEqual(['aaa', 'ccc', 'bbb']);
    expect(retainedGenerations(order)).toEqual(['aaa', 'ccc', 'bbb']);
  });

  test('deletes only unretained shell caches', () => {
    const existing = ['kteam-shell-aaa', 'kteam-shell-bbb', 'kteam-shell-ccc', 'kteam-shell-ddd'];
    expect(cachesToDelete(existing, ['bbb', 'ccc', 'ddd'])).toEqual(['kteam-shell-aaa']);
  });

  // The index cache shares the prefix so a keys() sweep sees it. Deleting it
  // would erase the ordering that makes retention possible at all.
  test('never deletes the generation index', () => {
    const existing = [INDEX_CACHE, 'kteam-shell-aaa', 'kteam-shell-bbb'];
    expect(cachesToDelete(existing, ['bbb'])).toEqual(['kteam-shell-aaa']);
    expect(cachesToDelete(existing, [])).not.toContain(INDEX_CACHE);
  });

  test('never deletes caches belonging to anything else on the origin', () => {
    const existing = ['workbox-precache-v2', 'some-other-app', 'kteam-shell-aaa'];
    expect(cachesToDelete(existing, [])).toEqual(['kteam-shell-aaa']);
  });

  // Deleting by prefix rather than "index minus retained" means a generation
  // outside the retention WINDOW is collected instead of leaking forever. The
  // window it is compared against must itself be reconciled first — see the
  // index-loss suite below, which is what stops this from deleting live
  // generations when the index is gone.
  test('a shell cache outside the retention window is collected even if unnamed', () => {
    expect(cachesToDelete(['kteam-shell-orphan'], ['aaa', 'bbb', 'ccc'])).toEqual(['kteam-shell-orphan']);
  });

  test('the index key is same-origin and cannot collide with a release name', () => {
    expect(INDEX_KEY.startsWith('/')).toBe(true);
    expect(INDEX_CACHE).toBe(`${CACHE_PREFIX}index`);
    expect('index').not.toMatch(RELEASE_ID_RE);
  });
});

// LOSING THE BOOKKEEPING MUST NOT DESTROY THE DATA IT DESCRIBES.
//
// The index is a cache like any other: private-mode eviction, storage pressure,
// or a hand-cleared origin can take it while the generation caches survive.
// Before reconciliation, an absent index made the next activation retain ONLY
// the activating release and delete both prior generations — so every tab still
// running B or C lost its lazy chunks a generation early, which is precisely the
// failure the three-generation window exists to prevent.
describe('retention survives a lost or corrupt generation index', () => {
  const A = 'aaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbb';
  const C = 'cccccccccccc';
  const D = 'dddddddddddd';
  /** Creation order, which is the order CacheStorage reports names in. */
  const liveABCD = [INDEX_CACHE, cacheNameFor(A), cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)];

  test('an EMPTY record is reconstructed from cache creation order', () => {
    // The regression itself. Index gone, A/B/C on disk, D installing.
    const existing = [cacheNameFor(A), cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)];
    const order = nextGenerationOrder(reconcileGenerationOrder([], existing), D);
    const retained = retainedGenerations(order);

    expect(retained).toEqual([B, C, D]);
    expect(cachesToDelete(existing, retained)).toEqual([cacheNameFor(A)]);
  });

  test('a CORRUPT record (non-array, wrong element types) behaves like an empty one', () => {
    // readGenerationOrder() maps both to []; what matters is that [] no longer
    // means "delete everything".
    const existing = [cacheNameFor(A), cacheNameFor(B), cacheNameFor(C)];
    for (const recorded of [[], ['not-a-live-release'], [A, 'ghost']]) {
      const retained = retainedGenerations(nextGenerationOrder(reconcileGenerationOrder(recorded, existing), D));
      expect(retained).toContain(B);
      expect(retained).toContain(C);
      expect(retained).toContain(D);
    }
  });

  test('a TRUNCATED record falls back to creation order for the whole set', () => {
    // Half-written index: it names C but not A or B. Merging a recorded position
    // with two discovered ones would require inventing an order between them, so
    // the discovered order is used for all three.
    const existing = [cacheNameFor(A), cacheNameFor(B), cacheNameFor(C)];
    expect(reconcileGenerationOrder([C], existing)).toEqual([A, B, C]);
  });

  // A DUPLICATED record is damage, not history — and it is JSON-valid, so
  // `readGenerationOrder()` hands it over intact. `[A, A, C, C]` against live
  // A/B/C/D survives the alive-filter with four entries and MATCHES THE COUNT of
  // four discovered generations, so a length-only authority test trusts it: B is
  // never mentioned, falls outside the window, and is deleted a generation early,
  // while the duplicates are written back to corrupt the next activation too.
  test('a DUPLICATED record is not authoritative, even when the counts match', () => {
    const existing = [cacheNameFor(A), cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)];
    expect(reconcileGenerationOrder([A, A, C, C], existing)).toEqual([A, B, C, D]);
  });

  test('a record duplicating EVERY live generation is still rejected', () => {
    const existing = [cacheNameFor(A), cacheNameFor(B)];
    // Counts match at 4 vs 2 only after the filter — this is the shape where a
    // naive check could pass for a different reason, so it is asserted directly.
    expect(reconcileGenerationOrder([A, A, B, B], existing)).toEqual([A, B]);
    expect(reconcileGenerationOrder([B, B], existing)).toEqual([A, B]);
  });

  test('a record with duplicates whose distinct set is complete is still rejected', () => {
    // [A, B, B] filters to three entries against three live caches, and its
    // distinct set IS {A, B, C}-minus-C... the point being that "the set is
    // right" is not sufficient: a duplicate means the recorded ORDER is
    // untrustworthy, so reconstruction is the only honest answer.
    const existing = [cacheNameFor(A), cacheNameFor(B), cacheNameFor(C)];
    expect(reconcileGenerationOrder([A, B, B], existing)).toEqual([A, B, C]);
    expect(reconcileGenerationOrder([C, C, A], existing)).toEqual([A, B, C]);
  });

  test('a COMPLETE record is trusted over creation order', () => {
    // Re-activation ordering lives only in the record: B was promoted to newest
    // without its cache being re-created, so creation order cannot see it.
    const existing = [cacheNameFor(A), cacheNameFor(B), cacheNameFor(C)];
    expect(reconcileGenerationOrder([A, C, B], existing)).toEqual([A, C, B]);
  });

  test('records naming generations that are already gone are dropped', () => {
    const existing = [cacheNameFor(C), cacheNameFor(D)];
    // A and B were pruned by an earlier activation; the record must not resurrect
    // them into the retention window and displace a live generation.
    expect(reconcileGenerationOrder([A, B, C, D], existing)).toEqual([C, D]);
  });

  test('the index cache and foreign caches are never mistaken for generations', () => {
    expect(releasesFromCacheNames([...liveABCD, 'workbox-precache-v2', 'some-other-app'])).toEqual([A, B, C, D]);
    expect(reconcileGenerationOrder([], [INDEX_CACHE])).toEqual([]);
  });

  test('a first-ever install with nothing on disk still retains only itself', () => {
    const retained = retainedGenerations(nextGenerationOrder(reconcileGenerationOrder([], []), A));
    expect(retained).toEqual([A]);
    expect(cachesToDelete([], retained)).toEqual([]);
  });

  /* ---------- and through activateRelease itself ---------------------------
     The tests above compose the pure functions by hand, which is not enough:
     removing the reconciliation call from `activateRelease` left all of them
     green (verified by mutation). These drive the real function against a fake
     CacheStorage, so the WIRING is covered and not just the pieces.
     ---------------------------------------------------------------------- */

  /** A CacheStorage whose `keys()` preserves insertion order, as the spec
      requires — that ordering is the whole basis of reconstruction. */
  function fakeCacheStorage(names: readonly string[], indexBody?: string) {
    const present = [...names];
    const stored = new Map<string, string>();
    if (indexBody !== undefined) stored.set(INDEX_KEY, indexBody);
    const deleted: string[] = [];
    const storage = {
      keys: async () => [...present],
      open: async (name: string) => ({
        match: async (key: string) => {
          if (name !== INDEX_CACHE) return undefined;
          const body = stored.get(key);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (key: string, response: Response) => void stored.set(key, await response.text()),
      }),
      delete: async (name: string) => {
        deleted.push(name);
        const at = present.indexOf(name);
        if (at >= 0) present.splice(at, 1);
        return at >= 0;
      },
    };
    return { storage, deleted, index: () => stored.get(INDEX_KEY), present: () => [...present] };
  }

  async function activateWith(names: readonly string[], indexBody: string | undefined, release: string) {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    const fake = fakeCacheStorage(names, indexBody);
    (globalThis as { caches?: unknown }).caches = fake.storage;
    try {
      await activateRelease(release);
      return fake;
    } finally {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  }

  test('activateRelease with NO index keeps B and C and prunes only A', async () => {
    const fake = await activateWith(
      [INDEX_CACHE, cacheNameFor(A), cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)],
      undefined,
      D,
    );
    expect(fake.deleted).toEqual([cacheNameFor(A)]);
    expect(JSON.parse(fake.index()!)).toEqual([B, C, D]);
  });

  test('activateRelease with a CORRUPT index keeps B and C', async () => {
    const fake = await activateWith(
      [INDEX_CACHE, cacheNameFor(A), cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)],
      '{"not":"an array"}',
      D,
    );
    expect(fake.deleted).toEqual([cacheNameFor(A)]);
    expect(JSON.parse(fake.index()!)).toEqual([B, C, D]);
  });

  test('activateRelease with unparseable index JSON keeps B and C', async () => {
    const fake = await activateWith([INDEX_CACHE, cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)], 'not json', D);
    expect(fake.deleted).toEqual([]);
    expect(JSON.parse(fake.index()!)).toEqual([B, C, D]);
  });

  // THE AUDITED REPRO, end to end. A JSON-valid duplicated index is the one
  // corruption shape that reaches `activateRelease` intact, so it must be driven
  // through the real function: the helper test above passes even if the caller
  // stops consulting the helper.
  test('activateRelease with a DUPLICATED index keeps B and writes a clean order', async () => {
    const fake = await activateWith(
      [INDEX_CACHE, cacheNameFor(A), cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)],
      JSON.stringify([A, A, C, C]),
      D,
    );
    expect(fake.deleted).toEqual([cacheNameFor(A)]);
    // Not [C, C, D]: a duplicate written back would corrupt the NEXT activation
    // too, so each activation has to leave the index clean.
    expect(JSON.parse(fake.index()!)).toEqual([B, C, D]);
  });

  test('the index an activation writes is always duplicate-free', async () => {
    const fake = await activateWith(
      [INDEX_CACHE, cacheNameFor(B), cacheNameFor(C), cacheNameFor(D)],
      JSON.stringify([B, B, C, C, D, D]),
      D,
    );
    const written = JSON.parse(fake.index()!) as string[];
    expect(new Set(written).size).toBe(written.length);
    expect(written).toEqual([B, C, D]);
  });

  test('activateRelease trusts a COMPLETE index over creation order', async () => {
    // B re-activated after C, so the record's order differs from creation order
    // and is the only one that knows.
    const fake = await activateWith(
      [INDEX_CACHE, cacheNameFor(A), cacheNameFor(B), cacheNameFor(C)],
      JSON.stringify([A, C, B]),
      D,
    );
    expect(fake.deleted).toEqual([cacheNameFor(A)]);
    expect(JSON.parse(fake.index()!)).toEqual([C, B, D]);
  });

  test('activateRelease never deletes the index cache itself', async () => {
    const fake = await activateWith([INDEX_CACHE, cacheNameFor(A)], undefined, A);
    expect(fake.deleted).toEqual([]);
    expect(fake.present()).toContain(INDEX_CACHE);
  });

  test('activateRelease leaves foreign caches alone', async () => {
    const fake = await activateWith([INDEX_CACHE, 'workbox-precache-v2', cacheNameFor(A)], undefined, A);
    expect(fake.deleted).toEqual([]);
  });
});

describe('install is all-or-nothing (M6)', () => {
  function fakeCache() {
    const put = new Map<string, Response>();
    return {
      cache: { put: async (url: string, response: Response) => void put.set(url, response) } as unknown as Cache,
      put,
    };
  }

  test('every response is checked ok BEFORE it is cached', async () => {
    const { cache, put } = fakeCache();
    const restore = stubFetch(async () => new Response('ok', { status: 200 }));
    try {
      await precacheAll(cache, ['/a.js', '/b.css'], ORIGIN);
      // Keyed by the ROOT-ABSOLUTE url, which is what `caches.match(request)`
      // looks up on a later fetch event. Keying by the resolved absolute URL
      // would still "work" on the same origin but would silently miss if the
      // worker were ever served from another host.
      expect([...put.keys()].sort()).toEqual(['/a.js', '/b.css']);
    } finally {
      restore();
    }
  });

  test('requests are resolved against the worker scope before fetching', async () => {
    const { cache } = fakeCache();
    const requested: string[] = [];
    const restore = stubFetch(async input => {
      requested.push(input instanceof Request ? input.url : String(input));
      return new Response('ok', { status: 200 });
    });
    try {
      await precacheAll(cache, ['/assets/x.js'], ORIGIN);
      expect(requested).toEqual([`${ORIGIN}/assets/x.js`]);
    } finally {
      restore();
    }
  });

  // A worker that installed with a half-populated cache would serve a shell
  // missing a chunk and fail in a way no reload could fix. Rejecting keeps the
  // PREVIOUS generation serving, which is the correct outcome.
  test('one non-OK response rejects the whole install and caches NOTHING AT ALL', async () => {
    const { cache, put } = fakeCache();
    const restore = stubFetch(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('b.css') ? new Response('nope', { status: 404 }) : new Response('ok', { status: 200 });
    });
    try {
      await expect(precacheAll(cache, ['/a.js', '/b.css'], ORIGIN)).rejects.toThrow(/refusing to install.*b\.css.*404/);
      expect(put.has('/b.css')).toBe(false);
      // The SIBLING matters as much as the failing URL: asserting only that the
      // 404'd entry is absent passes for a cache left half-populated.
      expect([...put.keys()]).toEqual([]);
    } finally {
      restore();
    }
  });

  // THE TIMING CASE. A fast 200 racing a slow 404 is what a real deploy against
  // a partially-propagated origin looks like, and it is the only ordering where
  // check-then-put-per-URL is observably wrong: /a.js finishes its put while
  // /b.css is still in flight. With the fetch and write phases split, the delay
  // changes nothing.
  test('a SUCCESSFUL sibling does not survive a delayed failure', async () => {
    const { cache, put } = fakeCache();
    const restore = stubFetch(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('b.css')) return new Response('ok', { status: 200 });
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response('nope', { status: 404 });
    });
    try {
      await expect(precacheAll(cache, ['/a.js', '/b.css'], ORIGIN)).rejects.toThrow(/refusing to install/);
      expect([...put.keys()]).toEqual([]);
    } finally {
      restore();
    }
  });

  test('a network error mid-list also writes nothing', async () => {
    const { cache, put } = fakeCache();
    const restore = stubFetch(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('b.css')) throw new TypeError('network down');
      return new Response('ok', { status: 200 });
    });
    try {
      await expect(precacheAll(cache, ['/a.js', '/b.css'], ORIGIN)).rejects.toThrow(/network down/);
      expect([...put.keys()]).toEqual([]);
    } finally {
      restore();
    }
  });

  test('a 500 is fatal too, not just a 404', async () => {
    const { cache } = fakeCache();
    const restore = stubFetch(async () => new Response('boom', { status: 500 }));
    try {
      await expect(precacheAll(cache, ['/a.js'], ORIGIN)).rejects.toThrow(/refusing to install/);
    } finally {
      restore();
    }
  });

  // Belt and braces for the one failure `precacheAll`'s phase split cannot
  // prevent: a `cache.put` that fails partway through the write phase (quota
  // exceeded on the fifth of twelve entries). The named cache must be gone, so
  // the next attempt starts empty rather than from a half-populated cache it
  // could not distinguish from a complete one.
  test('a failing cache.put deletes the whole generation cache', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    const written: string[] = [];
    const deleted: string[] = [];
    const restore = stubFetch(async () => new Response('ok', { status: 200 }));
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        put: async (url: string) => {
          written.push(url);
          if (url === '/b.css') throw new DOMException('quota exceeded', 'QuotaExceededError');
        },
      }),
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    };
    try {
      await expect(installRelease(RELEASE_ID, ['/a.js', '/b.css'], ORIGIN)).rejects.toThrow(/quota exceeded/);
      expect(deleted).toEqual([cacheNameFor(RELEASE_ID)]);
    } finally {
      restore();
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });

  test('a fetch failure also deletes the generation cache, and the install error wins', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    const deleted: string[] = [];
    const restore = stubFetch(async () => new Response('nope', { status: 404 }));
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ put: async () => {} }),
      // Cleanup that itself fails must not mask WHY the install failed.
      delete: async (name: string) => {
        deleted.push(name);
        throw new Error('delete failed');
      },
    };
    try {
      await expect(installRelease(RELEASE_ID, ['/a.js'], ORIGIN)).rejects.toThrow(/refusing to install/);
      expect(deleted).toEqual([cacheNameFor(RELEASE_ID)]);
    } finally {
      restore();
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });

  test('a successful install writes every URL and deletes nothing', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    const written: string[] = [];
    let deletes = 0;
    const restore = stubFetch(async () => new Response('ok', { status: 200 }));
    (globalThis as { caches?: unknown }).caches = {
      open: async () => ({ put: async (url: string) => void written.push(url) }),
      delete: async () => {
        deletes += 1;
        return true;
      },
    };
    try {
      await installRelease(RELEASE_ID, ['/a.js', '/b.css'], ORIGIN);
      expect(written.sort()).toEqual(['/a.js', '/b.css']);
      expect(deletes).toBe(0);
    } finally {
      restore();
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });
});

describe('respond()', () => {
  test('passthrough returns undefined so the caller skips respondWith', async () => {
    expect(await respond(new Request(`${ORIGIN}/v1/sessions`), 'passthrough', RELEASE_ID)).toBeUndefined();
  });

  test('a failed navigation serves the offline page for this release', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    const restore = stubFetch(async () => {
      throw new TypeError('offline');
    });
    (globalThis as { caches?: unknown }).caches = {
      match: async (key: string) => (key === offlineUrl(RELEASE_ID) ? new Response('offline page') : undefined),
    };
    try {
      const response = await respond(new Request(`${ORIGIN}/sessions/x`), 'navigate', RELEASE_ID);
      expect(await response!.text()).toBe('offline page');
    } finally {
      restore();
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });

  test('a successful navigation is served from the network and never cached', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    let cachePutCalls = 0;
    const restore = stubFetch(async () => new Response('<html>fresh shell with token</html>'));
    (globalThis as { caches?: unknown }).caches = {
      match: async () => undefined,
      open: async () => ({
        put: async () => {
          cachePutCalls += 1;
        },
      }),
    };
    try {
      const response = await respond(new Request(`${ORIGIN}/`), 'navigate', RELEASE_ID);
      expect(await response!.text()).toContain('fresh shell');
      expect(cachePutCalls).toBe(0);
    } finally {
      restore();
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });

  test('cache-first prefers the cache and falls back to the network without repopulating', async () => {
    const originalCaches = (globalThis as { caches?: CacheStorage }).caches;
    let hit = true;
    let opened = 0;
    const restore = stubFetch(async () => new Response('from network'));
    (globalThis as { caches?: unknown }).caches = {
      match: async () => (hit ? new Response('from cache') : undefined),
      open: async () => {
        opened += 1;
        return { put: async () => {} };
      },
    };
    try {
      const cached = await respond(new Request(`${ORIGIN}/assets/x.js`), 'cache-first', RELEASE_ID);
      expect(await cached!.text()).toBe('from cache');

      hit = false;
      const network = await respond(new Request(`${ORIGIN}/assets/x.js`), 'cache-first', RELEASE_ID);
      expect(await network!.text()).toBe('from network');
      // Never writes: this worker's cache must match its install manifest.
      expect(opened).toBe(0);
    } finally {
      restore();
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });
});
