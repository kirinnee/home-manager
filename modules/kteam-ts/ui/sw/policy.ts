/* ============================================================================
   APP-SHELL WORKER POLICY (Stage D, plan §4.4)

   Every decision the service worker makes, as pure functions over explicit
   arguments. `sw.ts` is the worker ENTRY: it imports the generated release id
   and precache list and wires these decisions to real events. Nothing in this
   file imports generated code, touches `self`, or registers a listener.

   ── WHY THE SPLIT ─────────────────────────────────────────────────────────
   `sw/precache.gen.ts` is written by the build and GITIGNORED — it names content
   hashes from one specific build, so a committed copy would be a lie. A test
   that imported it (directly, or transitively through the worker entry) would
   therefore fail to RESOLVE on a clean checkout: not one assertion failing, the
   whole file erroring out with "Cannot find module" and reporting 0 tests. The
   contract tests are the only thing standing between a refactor and a token in
   CacheStorage, so they must run on a fresh clone with no build.

   So the security-relevant logic lives here, importable with no generated
   input, and `sw.test.ts` tests it directly. The entry keeps only the wiring
   that genuinely needs the generated data.

   ── WHAT IS AND IS NOT CACHED ─────────────────────────────────────────────
   Only the app SHELL: the fingerprinted JS/CSS/icon closure plus the offline
   page. Never `/`, never `index.html`, never anything under `/v1/`. Two
   independent reasons, and both matter:

     * TOKEN SAFETY. The daemon substitutes a real loopback token into
       index.html at serve time. Caching that document would write the token
       into CacheStorage, where it would outlive the tab and be readable by
       anything that can reach the cache. `/v1/*` responses carry session
       transcripts for the same reason.
     * STALENESS. The shell is the one document that names the current release.
       A cached shell would pin a reader to an old generation permanently — the
       failure mode the fingerprinting exists to prevent.

   So there is NO opportunistic runtime caching. An asset is either in the
   generated precache closure (cache-first, safe because content-addressed) or
   it goes to the network untouched.
   ============================================================================ */

/** Every shell cache starts with this. One prefix is what makes "delete the
    generations I am not retaining" expressible without a registry. */
export const CACHE_PREFIX = 'kteam-shell-';

/** Insertion-order index for the retention contract.

    Commit hashes DO NOT SORT — `93c72ea` is not "before" or "after" `1318266`
    in any ordering git respects, and lexicographic order on hex is meaningless
    as history. So the worker cannot look at the set of existing caches and work
    out which three are newest; it has to have recorded the order itself. This
    cache holds that record and nothing else.

    It shares CACHE_PREFIX (so a `caches.keys()` sweep sees it) which is why
    every deletion path must exempt it explicitly — see `cachesToDelete`. The
    suffix `index` can never collide with a release id, which is 12 hex chars. */
export const INDEX_CACHE = `${CACHE_PREFIX}index`;

/** Synthetic key for the index entry. Same-origin so the Cache API accepts it,
    and deliberately shaped like nothing the daemon serves: it is only ever read
    from and written to the index cache, never fetched. */
export const INDEX_KEY = '/__kteam-shell-generations';

/** Current + TWO previous (plan §4.4, B3).

    The two previous generations are what let a tab that has been open across
    two deploys still lazy-load its own chat chunk: its chunk URLs are content-
    addressed into ITS generation's cache, and that cache is still here. On the
    fourth generation the oldest is pruned, and that tab's next dynamic import
    fails — which is the documented, drilled degradation path, surfaced as
    `vite:preloadError` → recovery chip → one reload. */
export const RETAINED_GENERATIONS = 3;

export function cacheNameFor(release: string): string {
  return `${CACHE_PREFIX}${release}`;
}

/** The offline page's URL for a release.

    Duplicates `offlineName()` in scripts/release.ts because a worker cannot
    import a node build script. `sw/sw.test.ts` asserts the two agree, so the
    duplication is checked rather than hoped for. */
export function offlineUrl(release: string): string {
  return `/offline.${release}.html`;
}

/* ---------- fetch policy --------------------------------------------------
   A pure function over (method, URL, precache set) because it is the
   security-relevant decision in this design: it is what guarantees no token and
   no transcript ever reaches CacheStorage. A policy embedded in the fetch
   handler could only be tested by driving real FetchEvents; as a function it is
   tested exhaustively, including the cases that MUST be passthrough.
   -------------------------------------------------------------------------- */

export type FetchPolicy =
  /** Not ours: hand the request to the network untouched, no respondWith. */
  | 'passthrough'
  /** Network-only; on failure serve the cached offline page. Never cached. */
  | 'navigate'
  /** In the precache closure: content-addressed, so cache-first is safe. */
  | 'cache-first'
  /** Same-origin but not precached: plain network, never written to a cache. */
  | 'network';

/** Everything the daemon serves under this prefix is live API surface: REST,
    the `/v1/events` WebSocket, streams, search, attachments. All of it is
    either session content or token-bearing, and none of it is ever cached or
    even observed. */
export const API_PREFIX = '/v1/';

export function fetchPolicy(
  method: string,
  url: URL,
  workerOrigin: string,
  precached: ReadonlySet<string>,
  isNavigate: boolean,
): FetchPolicy {
  // A non-GET is a mutation. There is nothing to serve from a cache and
  // nothing safe to store, and intercepting one risks replaying it.
  if (method !== 'GET') return 'passthrough';
  // Cross-origin (CDN fonts, avatars, anything) is not our shell to manage.
  if (url.origin !== workerOrigin) return 'passthrough';
  // Checked BEFORE the navigate branch: a navigation is never under /v1/, but
  // if one ever were, API passthrough is the stronger of the two guarantees.
  if (url.pathname === '/v1' || url.pathname.startsWith(API_PREFIX)) return 'passthrough';
  // The shell document: always from the network so the token substitution and
  // the current release names are fresh. Never stored.
  if (isNavigate) return 'navigate';
  if (precached.has(url.pathname)) return 'cache-first';
  return 'network';
}

/* ---------- retention ----------------------------------------------------- */

/** Append this release to the recorded order, moving it to newest if it is
    already known (a re-activation of the same release must not duplicate it,
    and must not leave it looking older than it is). */
export function nextGenerationOrder(existing: readonly string[], release: string): string[] {
  return [...existing.filter(r => r !== release), release];
}

/** The newest `keep` generations, oldest-first order preserved. */
export function retainedGenerations(order: readonly string[], keep: number = RETAINED_GENERATIONS): string[] {
  return keep <= 0 ? [] : order.slice(-keep);
}

/** Which existing caches to delete.

    Deletes by PREFIX rather than by "everything in the index I am not keeping",
    so a generation whose index record was lost (private-mode eviction, a failed
    write, an index cache deleted by hand) is still collected instead of leaking
    forever. The index cache itself is exempt — it is bookkeeping, not a
    generation, and deleting it would erase the ordering that makes retention
    possible at all. */
export function cachesToDelete(existing: readonly string[], retained: readonly string[]): string[] {
  const keep = new Set(retained.map(cacheNameFor));
  return existing.filter(name => name.startsWith(CACHE_PREFIX) && name !== INDEX_CACHE && !keep.has(name));
}

export async function readGenerationOrder(): Promise<string[]> {
  try {
    const cache = await caches.open(INDEX_CACHE);
    const hit = await cache.match(INDEX_KEY);
    if (!hit) return [];
    const parsed: unknown = await hit.json();
    // Defensive: this is persisted state from an older worker build. A shape
    // change must degrade to "no history" (which prunes conservatively by
    // prefix) rather than throwing inside activate.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    return [];
  }
}

export async function writeGenerationOrder(order: readonly string[]): Promise<void> {
  const cache = await caches.open(INDEX_CACHE);
  await cache.put(
    INDEX_KEY,
    new Response(JSON.stringify(order), {
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/* ---------- lifecycle ----------------------------------------------------- */

/** Precache the generated closure.

    Every response is checked `ok` BEFORE `cache.put` and the whole install
    REJECTS on any failure, which leaves this worker non-current: a worker that
    installed with a half-populated cache would serve a shell missing one chunk
    and fail in a way no reload could fix. Failing install keeps the previous
    generation serving, which is the correct outcome.

    `cache: 'reload'` bypasses the HTTP cache for the fetch itself. These URLs
    are served `immutable`, so a poisoned or partial intermediary entry would
    otherwise be copied straight into CacheStorage and pinned there.

    `base` is passed in rather than read from `self.location` so this function is
    callable outside a worker (the contract tests). A real worker resolves
    root-absolute URLs against its own scope, which is exactly what passing
    `location.href` reproduces. The cache is keyed by the original root-absolute
    string, matching what `caches.match(request)` looks up on a fetch event. */
export async function precacheAll(cache: Cache, urls: readonly string[], base: string): Promise<void> {
  await Promise.all(
    urls.map(async url => {
      const response = await fetch(new Request(new URL(url, base).href, { cache: 'reload' }));
      if (!response.ok) {
        throw new Error(`sw: refusing to install — ${url} responded ${response.status}`);
      }
      await cache.put(url, response);
    }),
  );
}

/** Open this release's cache and fill it. Rejects (failing install) on any
    non-OK response — see `precacheAll`. */
export async function installRelease(release: string, urls: readonly string[], base: string): Promise<void> {
  const cache = await caches.open(cacheNameFor(release));
  await precacheAll(cache, urls, base);
}

/** Record this release as newest, prune everything outside the retention
    window, and persist the trimmed order. */
export async function activateRelease(release: string): Promise<void> {
  const order = nextGenerationOrder(await readGenerationOrder(), release);
  const retained = retainedGenerations(order);
  const existing = await caches.keys();
  await Promise.all(cachesToDelete(existing, retained).map(name => caches.delete(name)));
  // Written AFTER the deletions so a failure mid-prune leaves the index naming
  // caches that still exist, never caches that are already gone.
  await writeGenerationOrder(retained);
}

/** Serve a request under the resolved policy.

    Returns `undefined` for `passthrough`, and the caller then does NOT call
    `respondWith` — letting the browser do exactly what it would have done with
    no worker installed, rather than proxying it through here. */
export async function respond(request: Request, policy: FetchPolicy, release: string): Promise<Response | undefined> {
  if (policy === 'passthrough') return undefined;

  if (policy === 'navigate') {
    try {
      return await fetch(request);
    } catch {
      const offline = await caches.match(offlineUrl(release));
      // If even the offline page is missing there is nothing honest left to
      // show, so the browser's own network error is the better answer.
      return offline ?? Response.error();
    }
  }

  if (policy === 'cache-first') {
    const hit = await caches.match(request);
    if (hit) return hit;
    // A precached URL that is missing means the cache was evicted under storage
    // pressure. Go to the network, but do NOT repopulate: writing here would
    // make this worker's cache diverge from its install manifest, and the URL
    // is content-addressed so the network copy is identical anyway.
    return await fetch(request);
  }

  return await fetch(request);
}
