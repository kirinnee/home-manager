import { describe, expect, test } from 'bun:test';
import { actorContext, currentActor, parseActor, peerActor, resolveApiActor, wardenActor } from './actor-context';

describe('resolveApiActor', () => {
  test('a warden token with the warden session id names the specific warden', () => {
    expect(resolveApiActor({ tokenClass: 'warden', sessionId: 'warden-7' })).toBe('warden:warden-7');
  });

  test('a warden token without a session id degrades to the generic warden', () => {
    expect(resolveApiActor({ tokenClass: 'warden' })).toBe('warden');
    // A blank/whitespace header is not an identity.
    expect(resolveApiActor({ tokenClass: 'warden', sessionId: '   ' })).toBe('warden');
  });

  test('an admin token with a session id is a teammate ("peer") acting over the API', () => {
    expect(resolveApiActor({ tokenClass: 'admin', sessionId: 'georgia' })).toBe('peer:georgia');
  });

  test('an admin token with no session id splits into CLI vs UI by the client header', () => {
    expect(resolveApiActor({ tokenClass: 'admin', client: 'cli' })).toBe('admin-cli');
    // The browser SPA sends no client header → the human at the web UI.
    expect(resolveApiActor({ tokenClass: 'admin' })).toBe('admin-ui');
    expect(resolveApiActor({ tokenClass: 'admin', client: 'something-else' })).toBe('admin-ui');
  });

  test('never returns the generic daemon source — an API request always has a caller', () => {
    const every = [
      resolveApiActor({ tokenClass: 'warden', sessionId: 'w' }),
      resolveApiActor({ tokenClass: 'warden' }),
      resolveApiActor({ tokenClass: 'admin', sessionId: 'p' }),
      resolveApiActor({ tokenClass: 'admin', client: 'cli' }),
      resolveApiActor({ tokenClass: 'admin' }),
    ];
    expect(every).not.toContain('daemon');
  });
});

describe('wardenActor / peerActor helpers', () => {
  test('build the prefixed, session-tagged forms', () => {
    expect(wardenActor('w1')).toBe('warden:w1');
    expect(peerActor('p1')).toBe('peer:p1');
  });
});

describe('parseActor', () => {
  test('splits a structured kind:id value on the first colon only', () => {
    expect(parseActor('warden:ms14-abcd')).toEqual({ kind: 'warden', id: 'ms14-abcd', raw: 'warden:ms14-abcd' });
    // A session id may itself contain a colon; only the first is the separator.
    expect(parseActor('peer:a:b')).toEqual({ kind: 'peer', id: 'a:b', raw: 'peer:a:b' });
  });

  test('a colon-less value (the legacy sources) round-trips as its own kind', () => {
    expect(parseActor('daemon')).toEqual({ kind: 'daemon', raw: 'daemon' });
    expect(parseActor('admin-ui')).toEqual({ kind: 'admin-ui', raw: 'admin-ui' });
  });

  test('an UNKNOWN kind surfaces verbatim — never collapses or is dropped', () => {
    // The whole point of the taxonomy: a future kind ("cron:nightly") no consumer
    // knows about still parses and its raw value is preserved for display.
    const parsed = parseActor('cron:nightly-sweep');
    expect(parsed.kind).toBe('cron');
    expect(parsed.id).toBe('nightly-sweep');
    expect(parsed.raw).toBe('cron:nightly-sweep');
  });
});

describe('currentActor / actorContext', () => {
  test('is undefined OUTSIDE any request context — the daemon keeps its genuine source', () => {
    expect(currentActor()).toBeUndefined();
  });

  test('reflects the actor set for the enclosing run()', () => {
    let inside: string | undefined;
    actorContext.run({ actor: 'peer:georgia' }, () => {
      inside = currentActor();
    });
    expect(inside).toBe('peer:georgia');
    // …and clears again once the context exits.
    expect(currentActor()).toBeUndefined();
  });
});
