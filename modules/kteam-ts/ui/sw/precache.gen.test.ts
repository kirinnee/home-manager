// GENERATED-PRECACHE-LIST INVARIANTS (Stage D, plan §6 "SW scope/cache/token").
//
// `sw.test.ts` proves the worker's POLICY is safe — that a navigation is never
// cache-first, that `/v1/*` is passthrough. But the policy is a decision about a
// list, and a wrong list satisfies every one of those tests while still caching
// the shell: `fetchPolicy` would happily return 'cache-first' for `/index.html`
// if the build ever put it in the closure. So the list itself is checked here,
// against the real generated file.
//
// SKIPS VISIBLY WHEN UNBUILT, rather than failing or silently vanishing.
// `sw/precache.gen.ts` is written by `scripts/postbuild-pwa.ts` and gitignored,
// so on a clean checkout there is nothing to assert against. A static import
// would make this file error out at resolution and report zero tests — which
// reads exactly like "nothing to check here" and is how a coverage hole hides.
// The specifier is held in a variable so TypeScript does not try to resolve it
// either, and the reason for every skip is printed once below.

import { describe, expect, test } from 'bun:test';
import { API_PREFIX, offlineUrl } from './policy';
import { RELEASE_ID_RE } from '../scripts/release';

interface GeneratedPrecache {
  RELEASE_ID: string;
  PRECACHE_URLS: readonly string[];
}

/* Non-literal on purpose: keeps both `tsc` and the bundler from resolving a
   file that is absent until the build runs. */
const GENERATED = './precache.gen';

const generated: GeneratedPrecache | null = await import(GENERATED).then(
  module => module as GeneratedPrecache,
  () => null,
);

if (!generated) {
  console.log(
    'sw/precache.gen.ts absent (no build in this tree) — skipping generated precache-list invariants. ' +
      'The worker POLICY tests in sw.test.ts still ran; run `bun run build` to check the list itself.',
  );
}

/* `describe.skipIf` skips the TESTS but still runs the callback body, so the
   generated values cannot be unpacked at describe scope — that throws before any
   skipping happens. Each test reads them through here instead, which only ever
   runs when the suite is not skipped. */
function built(): GeneratedPrecache {
  if (!generated) throw new Error('unreachable: suite is skipped when unbuilt');
  return generated;
}

describe.skipIf(!generated)('the generated precache list', () => {
  test('names only content- or release-addressed URLs, and no API or shell', () => {
    const { RELEASE_ID, PRECACHE_URLS } = built();
    expect(PRECACHE_URLS.length).toBeGreaterThan(0);
    for (const url of PRECACHE_URLS) {
      expect(url.startsWith('/')).toBe(true);
      expect(url.startsWith(API_PREFIX)).toBe(false);
      expect(url.endsWith('.html') && !url.includes(RELEASE_ID)).toBe(false);
    }
  });

  // THE LIST-SIDE HALF OF THE TOKEN GUARANTEE. index.html carries the daemon's
  // substituted loopback token; the shell is also the one document naming the
  // current release, so a cached copy would pin a reader to an old generation.
  test('never names the shell document', () => {
    const { PRECACHE_URLS } = built();
    expect(PRECACHE_URLS).not.toContain('/index.html');
    expect(PRECACHE_URLS).not.toContain('/');
  });

  test('includes the offline page for exactly this release', () => {
    const { RELEASE_ID, PRECACHE_URLS } = built();
    expect(PRECACHE_URLS).toContain(offlineUrl(RELEASE_ID));
  });

  // The stable legacy /favicon.ico is intentionally allowed to go stale (C3);
  // caching it would freeze a stale copy twice over.
  test('excludes the stable legacy /favicon.ico', () => {
    expect(built().PRECACHE_URLS).not.toContain('/favicon.ico');
  });

  test('the release id is a real 12-hex release', () => {
    expect(built().RELEASE_ID).toMatch(RELEASE_ID_RE);
  });
});
