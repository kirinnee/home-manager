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

/** Which existing caches to delete: every shell cache outside the retention
    window, by PREFIX.

    Prefix-based rather than "everything named in the index that I am not
    keeping", so a generation the index never knew about cannot leak forever.
    That is safe only because the retention window itself is reconciled against
    the live caches first — see `reconcileGenerationOrder`. Feed this a window
    computed from an EMPTY order and it will happily delete generations that are
    still in use, which is exactly the bug reconciliation exists to prevent.

    The index cache itself is exempt — it is bookkeeping, not a generation, and
    deleting it would erase the ordering that makes retention possible at all. */
export function cachesToDelete(existing: readonly string[], retained: readonly string[]): string[] {
  const keep = new Set(retained.map(cacheNameFor));
  return existing.filter(name => name.startsWith(CACHE_PREFIX) && name !== INDEX_CACHE && !keep.has(name));
}

/** The release ids of the shell caches that actually exist, in the order
    CacheStorage reports them.

    That order is not incidental: the Cache API's name list is specified as an
    ordered list appended to on first `caches.open()`, so iteration order IS
    creation order. For shell caches, creation happens once per release during
    install — which makes this a genuine reconstruction of deploy history and the
    only one available when the index is gone. */
export function releasesFromCacheNames(existing: readonly string[]): string[] {
  return existing
    .filter(name => name.startsWith(CACHE_PREFIX) && name !== INDEX_CACHE)
    .map(name => name.slice(CACHE_PREFIX.length));
}

/** Reconcile the recorded generation order against the caches that are really
    there, and return the order retention should be computed from.

    WHY THIS EXISTS. `readGenerationOrder()` degrades a missing or corrupt index
    to `[]`, and an empty order means "retain only the release activating now" —
    so a single lost index entry made the next activation delete BOTH prior
    generations, and every tab still running one of them lost its lazy chunks a
    generation early. The index is a cache like any other: private-mode
    eviction, storage pressure or a hand-cleared origin can take it while the
    generation caches survive. Losing bookkeeping must not destroy the data the
    bookkeeping describes.

    Two cases, and each is the best answer available for its case:

      * The record accounts for every live cache → TRUST THE RECORD. It is the
        only source that knows about re-activations, where a release is promoted
        to newest without its cache being re-created, so creation order cannot
        see it.
      * Anything live is unaccounted for (index missing, truncated, corrupt, or
        a cache created by a build whose activation never finished) → TRUST
        CREATION ORDER for the whole set. Recorded positions cannot be merged
        with discovered ones without inventing an ordering between them, and
        guessing wrong here means pruning a live generation.

    Recorded ids with no surviving cache are dropped in both cases: they are
    history about generations that are already gone. */
export function reconcileGenerationOrder(recorded: readonly string[], existing: readonly string[]): string[] {
  const discovered = releasesFromCacheNames(existing);
  const alive = new Set(discovered);
  const known = recorded.filter(r => alive.has(r));
  return known.length === discovered.length ? known : discovered;
}

export async function readGenerationOrder(): Promise<string[]> {
  try {
    const cache = await caches.open(INDEX_CACHE);
    const hit = await cache.match(INDEX_KEY);
    if (!hit) return [];
    const parsed: unknown = await hit.json();
    // Defensive: this is persisted state from an older worker build. A shape
    // change must degrade to "no history" — which is then RECONCILED against the
    // live caches rather than acted on directly, so degrading here costs the
    // re-activation nuance and nothing else.
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

/** Precache the generated closure, ALL-OR-NOTHING.

    TWO PHASES, and the split is the whole point. Phase one fetches every URL and
    checks every response `ok`; phase two writes. Nothing is written until every
    response has arrived and passed, so a failure cannot leave a partially
    populated cache behind.

    The obvious one-pass version — check `ok`, then `cache.put`, all inside one
    `Promise.all` — is wrong, and wrong in a way that only shows up under real
    network timing: a fast 200 for `/a.js` completes its `put` while a slow 404
    for `/b.css` is still in flight. The install promise rejects, so this worker
    never activates, but CacheStorage has no transaction tied to worker
    installation and `/a.js` stays written. The next install of the same release
    then opens a cache that already has content, and "all-or-nothing" is a
    comment rather than a property. `installRelease` additionally deletes the
    named cache on any failure, so even a rejected phase-two write cannot leave a
    remnant.

    Responses are buffered as `Response` objects; their bodies are not read here,
    so a shell of a few hundred KB costs no more memory than the streaming
    version would have held anyway.

    `cache: 'reload'` bypasses the HTTP cache for the fetch itself. These URLs
    are served `immutable`, so a poisoned or partial intermediary entry would
    otherwise be copied straight into CacheStorage and pinned there.

    `base` is passed in rather than read from `self.location` so this function is
    callable outside a worker (the contract tests). A real worker resolves
    root-absolute URLs against its own scope, which is exactly what passing
    `location.href` reproduces. The cache is keyed by the original root-absolute
    string, matching what `caches.match(request)` looks up on a fetch event. */
export async function precacheAll(cache: Cache, urls: readonly string[], base: string): Promise<void> {
  const fetched = await Promise.all(
    urls.map(async url => {
      const response = await fetch(new Request(new URL(url, base).href, { cache: 'reload' }));
      if (!response.ok) {
        throw new Error(`sw: refusing to install — ${url} responded ${response.status}`);
      }
      return { url, response };
    }),
  );
  // Only reached when every fetch above resolved OK: `Promise.all` rejects on the
  // first failure, so no `put` has run by this point.
  await Promise.all(fetched.map(({ url, response }) => cache.put(url, response)));
}

/** Open this release's cache and fill it. Rejects (failing install) on any
    non-OK response — see `precacheAll`.

    On ANY failure the named cache is DELETED before rejecting. `precacheAll`
    already withholds every write until all responses pass, so this covers the
    remaining cases: a `cache.put` that fails partway through phase two (quota
    exceeded on the fifth of twelve entries), or a retry after some earlier
    interrupted install. Deleting is safe precisely because this worker is not
    active — the generation currently serving readers is a different cache — and
    it means the next install attempt starts from empty rather than from a
    half-populated cache it would have no way to distinguish from a complete one.

    Deletion failure is swallowed: the install error is the one worth reporting,
    and masking it with a cleanup error would hide why the install failed. */
export async function installRelease(release: string, urls: readonly string[], base: string): Promise<void> {
  const name = cacheNameFor(release);
  const cache = await caches.open(name);
  try {
    await precacheAll(cache, urls, base);
  } catch (error) {
    await caches.delete(name).catch(() => false);
    throw error;
  }
}

/** Record this release as newest, prune everything outside the retention
    window, and persist the trimmed order.

    The order is RECONCILED against the caches that actually exist before
    anything is deleted (see `reconcileGenerationOrder`), so a missing or corrupt
    index degrades to "prune by discovered creation order" instead of "delete
    every generation but this one". */
export async function activateRelease(release: string): Promise<void> {
  const existing = await caches.keys();
  const recorded = reconcileGenerationOrder(await readGenerationOrder(), existing);
  const order = nextGenerationOrder(recorded, release);
  const retained = retainedGenerations(order);
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
