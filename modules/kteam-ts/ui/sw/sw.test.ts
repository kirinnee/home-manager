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
  fetchPolicy,
  nextGenerationOrder,
  offlineUrl,
  precacheAll,
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
  // whose index record was lost is still collected instead of leaking forever.
  test('a cache with no index record is still collected', () => {
    expect(cachesToDelete(['kteam-shell-orphan'], ['aaa', 'bbb', 'ccc'])).toEqual(['kteam-shell-orphan']);
  });

  test('the index key is same-origin and cannot collide with a release name', () => {
    expect(INDEX_KEY.startsWith('/')).toBe(true);
    expect(INDEX_CACHE).toBe(`${CACHE_PREFIX}index`);
    expect('index').not.toMatch(RELEASE_ID_RE);
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
  test('one non-OK response rejects the whole install and caches nothing for it', async () => {
    const { cache, put } = fakeCache();
    const restore = stubFetch(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('b.css') ? new Response('nope', { status: 404 }) : new Response('ok', { status: 200 });
    });
    try {
      await expect(precacheAll(cache, ['/a.js', '/b.css'], ORIGIN)).rejects.toThrow(/refusing to install.*b\.css.*404/);
      expect(put.has('/b.css')).toBe(false);
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
