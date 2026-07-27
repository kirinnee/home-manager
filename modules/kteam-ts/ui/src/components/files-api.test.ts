import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from '../lib/api';
import {
  changesUrl,
  describeFsError,
  diffUrl,
  fileUrl,
  fsApi,
  fsTabAvailable,
  isUnknownRoute,
  listUrl,
  loadFsChanges,
  readFsProbe,
  resetFsProbes,
} from './files-api';

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => Response | Promise<Response>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    seen.push(url);
    return handler(url);
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  globalThis.fetch = realFetch;
  resetFsProbes();
});

describe('route construction', () => {
  test('paths are query-encoded, never interpolated into the route', () => {
    expect(listUrl('ms1-a', '')).toBe('/v1/sessions/ms1-a/fs');
    expect(listUrl('ms1-a', 'src/lib')).toBe('/v1/sessions/ms1-a/fs?path=src%2Flib');
    expect(fileUrl('ms1-a', 'a b/c.ts')).toBe('/v1/sessions/ms1-a/fs/file?path=a+b%2Fc.ts');
    expect(fileUrl('ms1-a', 'x.md', 'head')).toBe('/v1/sessions/ms1-a/fs/file?path=x.md&rev=head');
    expect(diffUrl('ms1-a', 'a.ts')).toBe('/v1/sessions/ms1-a/fs/diff?path=a.ts');
    expect(changesUrl('ms/1')).toBe('/v1/sessions/ms%2F1/fs/changes');
  });

  test('a path that would break out is still only ever a query value', () => {
    expect(fileUrl('ms1-a', '../../etc/passwd')).toBe('/v1/sessions/ms1-a/fs/file?path=..%2F..%2Fetc%2Fpasswd');
  });
});

describe('transport', () => {
  test('the diff route is read as text, not parsed as JSON', async () => {
    stubFetch(() => new Response('@@ -1 +1 @@\n-a\n+b\n', { headers: { 'content-type': 'text/plain' } }));
    await expect(fsApi.diff('ms1-a', 'a.ts')).resolves.toContain('@@');
  });

  test('an error body becomes an ApiError carrying the daemon’s code', async () => {
    stubFetch(() => json({ error: 'no route GET /v1/sessions/x/fs/changes', code: 'unknown_route' }, 404));
    const error = await fsApi.changes('ms1-a').catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('unknown_route');
  });

  test('an error body with no message still reads as something', async () => {
    stubFetch(() => new Response('', { status: 403 }));
    const error = await fsApi.changes('ms1-a').catch(e => e);
    expect(describeFsError(error)).toContain('forbidden');
  });
});

describe('capability probe', () => {
  test('unknown_route — and only that — means the daemon has no Files feature', async () => {
    expect(isUnknownRoute(new ApiError(404, 'x', 'unknown_route'))).toBe(true);
    expect(isUnknownRoute(new ApiError(404, 'unknown kteam session'))).toBe(false);
    expect(isUnknownRoute(new ApiError(403, 'x', 'unknown_route'))).toBe(false);
    expect(isUnknownRoute(new TypeError('offline'))).toBe(false);
  });

  test('an old daemon resolves to absent, which hides the tab', async () => {
    stubFetch(() => json({ error: 'no route', code: 'unknown_route' }, 404));
    await loadFsChanges('ms1-old');
    expect(readFsProbe('ms1-old').state).toBe('absent');
    expect(fsTabAvailable('absent')).toBe(false);
    expect(fsTabAvailable('probing')).toBe(false);
  });

  test('a real failure keeps the tab and reports the error', async () => {
    stubFetch(() => json({ error: 'git exploded' }, 500));
    await loadFsChanges('ms1-broken');
    const probe = readFsProbe('ms1-broken');
    expect(probe.state).toBe('error');
    expect(probe.error).toBe('git exploded');
    expect(fsTabAvailable('error')).toBe(true);
  });

  test('an offline daemon is an error, not a missing feature', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await loadFsChanges('ms1-offline');
    expect(readFsProbe('ms1-offline').state).toBe('error');
    expect(readFsProbe('ms1-offline').error).toBe('could not reach the daemon');
  });

  test('the probe doubles as the Changes payload — one request, both readers', async () => {
    const seen = stubFetch(() => json({ repo: true, branch: 'main', changes: [{ path: 'a.ts', status: ' M' }] }));
    await loadFsChanges('ms1-ok');
    // A redundant call while the record is loaded is not a second request…
    await loadFsChanges('ms1-ok');
    expect(seen).toHaveLength(1);
    const probe = readFsProbe('ms1-ok');
    expect(probe.state).toBe('ready');
    expect(probe.changes?.branch).toBe('main');
    expect(probe.changes?.changes).toHaveLength(1);
    // …but an explicit refresh is.
    await loadFsChanges('ms1-ok', true);
    expect(seen).toHaveLength(2);
    expect(readFsProbe('ms1-ok').refreshing).toBe(false);
  });

  test('a slow first probe cannot overwrite the refresh that superseded it', async () => {
    let resolveSlow: ((value: Response) => void) | undefined;
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return new Promise<Response>(resolve => (resolveSlow = resolve));
      return json({ repo: true, branch: 'fresh', changes: [] });
    }) as unknown as typeof fetch;

    const slow = loadFsChanges('ms1-race');
    const fresh = loadFsChanges('ms1-race', true);
    await fresh;
    expect(readFsProbe('ms1-race').changes?.branch).toBe('fresh');
    // The stale response lands last and must be ignored.
    resolveSlow?.(json({ repo: true, branch: 'stale', changes: [] }));
    await slow;
    expect(readFsProbe('ms1-race').changes?.branch).toBe('fresh');
  });

  test('each session gets its own record', async () => {
    stubFetch(url => json({ repo: true, branch: url.includes('ms1-a') ? 'a' : 'b', changes: [] }));
    await Promise.all([loadFsChanges('ms1-a'), loadFsChanges('ms1-b')]);
    expect(readFsProbe('ms1-a').changes?.branch).toBe('a');
    expect(readFsProbe('ms1-b').changes?.branch).toBe('b');
  });
});
