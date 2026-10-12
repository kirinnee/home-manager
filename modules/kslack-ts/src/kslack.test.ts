import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenMethodError, MissingTokenError, READ_METHODS, redact, SlackApiError, SlackClient } from './client';
import {
  cmdAuth,
  cmdDms,
  cmdHistory,
  cmdSearch,
  cmdThread,
  cmdUsers,
  type Ctx,
  mpimLabel,
  resolveChannel,
  slackTypes,
} from './commands';
import { normalizeTs, parseChannelRef, parsePermalink, parseSince } from './parse';
import { matchUsers, mentionedUserIds, renderText, toCached, UserDirectory } from './users';

const TOKEN = 'xoxp-1111-2222-3333-abcdefSECRET';

type Handler = (method: string, params: URLSearchParams) => Response | Record<string, unknown>;

function mockFetch(handler: Handler) {
  const calls: { method: string; params: URLSearchParams; auth: string | null }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/api/')[1]!;
    const params = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ method, params, auth: new Headers(init?.headers).get('authorization') });
    const r = handler(method, params);
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function makeCtx(handler: Handler, extra: Partial<Ctx> = {}) {
  const { f, calls } = mockFetch(handler);
  const client = new SlackClient({ token: TOKEN, fetch: f, sleep: async () => {} });
  const lines: string[] = [];
  const ctx: Ctx = { client, users: new UserDirectory(client, null), out: l => lines.push(l), ...extra };
  return { ctx, calls, lines, client };
}

const AUTH = { ok: true, user: 'me', user_id: 'UME', team: 'Acme', team_id: 'T1' };
const USERS: Record<string, Record<string, unknown>> = {
  UALICE: {
    id: 'UALICE',
    name: 'alice',
    profile: { display_name: 'Alice A', real_name: 'Alice Anders', email: 'alice@acme.io' },
  },
  UBOB: { id: 'UBOB', name: 'bob', profile: { display_name: '', real_name: 'Bob Brown', email: 'bob@acme.io' } },
};
function usersInfo(p: URLSearchParams) {
  const u = USERS[p.get('user')!];
  return u ? { ok: true, user: u } : { ok: false, error: 'user_not_found' };
}

describe('read-only allowlist', () => {
  test('write methods are rejected before any network call', async () => {
    const { f, calls } = mockFetch(() => ({ ok: true }));
    const c = new SlackClient({ token: TOKEN, fetch: f });
    for (const m of [
      'chat.postMessage',
      'chat.update',
      'chat.delete',
      'reactions.add',
      'conversations.open',
      'conversations.join',
      'files.upload',
      'auth.revoke',
    ]) {
      await expect(c.call(m)).rejects.toBeInstanceOf(ForbiddenMethodError);
    }
    expect(calls).toHaveLength(0);
  });

  test('allowlist contains only read methods', () => {
    for (const m of READ_METHODS) {
      expect(m).toMatch(
        /^(auth\.test|search\.|conversations\.(list|history|replies|info|members)|users\.(info|list|conversations)|chat\.getPermalink)/,
      );
    }
  });

  test('allowed methods send the token only as a bearer header', async () => {
    const { f, calls } = mockFetch(() => AUTH);
    await new SlackClient({ token: TOKEN, fetch: f }).call('auth.test');
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.params.toString()).not.toContain(TOKEN);
  });
});

describe('token handling', () => {
  test('missing token → clear error naming SLACK_USER_TOKEN', async () => {
    const c = SlackClient.fromEnv({});
    await expect(c.call('auth.test')).rejects.toBeInstanceOf(MissingTokenError);
    await expect(c.call('auth.test')).rejects.toThrow(/SLACK_USER_TOKEN is not set/);
  });

  test('token never appears in Slack errors, HTTP errors or network errors', async () => {
    const handlers: Handler[] = [
      () => ({ ok: false, error: `invalid_auth ${TOKEN}` }),
      () => new Response(`bad ${TOKEN}`, { status: 500, statusText: `boom ${TOKEN}` }),
      () => {
        throw new Error(`connect failed for Bearer ${TOKEN}`);
      },
    ];
    for (const h of handlers) {
      const { f } = mockFetch(h);
      const c = new SlackClient({ token: TOKEN, fetch: f });
      const err = await c.call('auth.test').then(
        () => undefined,
        e => c.scrub(e),
      );
      expect(err).toBeDefined();
      expect(err!.message).not.toContain(TOKEN);
      expect(err!.message).not.toContain('xoxp-');
      expect(String(err!.stack ?? '')).not.toContain(TOKEN);
    }
  });

  test('token never appears in command output', async () => {
    const { ctx, lines } = makeCtx(() => ({ ...AUTH, url: 'https://acme.slack.com/' }));
    await cmdAuth(ctx);
    await cmdAuth({ ...ctx, json: true });
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).toContain('me (UME)');
  });

  test('redact scrubs any xox token', () => {
    expect(redact('a xoxb-123-abc b', undefined)).toBe('a [redacted] b');
  });
});

describe('errors', () => {
  test('missing_scope surfaces error and needed scope verbatim', async () => {
    const { f } = mockFetch(() => ({
      ok: false,
      error: 'missing_scope',
      needed: 'im:history',
      provided: 'channels:history',
    }));
    const c = new SlackClient({ token: TOKEN, fetch: f });
    const e = (await c.call('conversations.history', { channel: 'D1' }).catch(e => e)) as SlackApiError;
    expect(e).toBeInstanceOf(SlackApiError);
    expect(e.message).toContain('missing_scope');
    expect(e.message).toContain('needed scope: im:history');
    expect(e.message).toContain('token has: channels:history');
  });
});

describe('pagination + rate limits', () => {
  test('follows next_cursor and stops at max', async () => {
    const pages: Record<string, { ids: string[]; next: string }> = {
      '': { ids: ['C1', 'C2'], next: 'c2' },
      c2: { ids: ['C3', 'C4'], next: 'c3' },
      c3: { ids: ['C5'], next: '' },
    };
    const { f, calls } = mockFetch((_m, p) => {
      const pg = pages[p.get('cursor') ?? '']!;
      return { ok: true, channels: pg.ids.map(id => ({ id })), response_metadata: { next_cursor: pg.next } };
    });
    const c = new SlackClient({ token: TOKEN, fetch: f });
    const all = await c.paginate<{ id: string }>('users.conversations', {}, 'channels', Infinity, 2);
    expect(all.map(x => x.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
    expect(calls).toHaveLength(3);
    const some = await c.paginate<{ id: string }>('users.conversations', {}, 'channels', 3, 2);
    expect(some.map(x => x.id)).toEqual(['C1', 'C2', 'C3']);
    expect(calls.at(-1)!.params.get('limit')).toBe('1');
  });

  test('retries 429 honoring Retry-After', async () => {
    let n = 0;
    const slept: number[] = [];
    const { f } = mockFetch(() =>
      n++ < 2 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : AUTH,
    );
    const c = new SlackClient({ token: TOKEN, fetch: f, sleep: async ms => void slept.push(ms) });
    const r = await c.call('auth.test');
    expect(r.ok).toBe(true);
    expect(slept).toEqual([3000, 3000]);
  });

  test('gives up after maxRetries', async () => {
    const { f } = mockFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '1' } }));
    const c = new SlackClient({ token: TOKEN, fetch: f, sleep: async () => {}, maxRetries: 2 });
    await expect(c.call('auth.test')).rejects.toThrow(/ratelimited/);
  });
});

describe('parsing', () => {
  test('permalinks', () => {
    expect(parsePermalink('https://acme.slack.com/archives/C0123ABCD/p1700000000123456')).toEqual({
      channel: 'C0123ABCD',
      ts: '1700000000.123456',
      threadTs: undefined,
    });
    expect(
      parsePermalink(
        'https://acme.enterprise.slack.com/archives/C0123ABCD/p1700000099000200?thread_ts=1700000000.123456&cid=C0123ABCD',
      ),
    ).toEqual({ channel: 'C0123ABCD', ts: '1700000099.000200', threadTs: '1700000000.123456' });
    expect(parsePermalink('https://evil.example.com/archives/C1/p1700000000123456')).toBeUndefined();
    expect(parsePermalink('#general')).toBeUndefined();
  });

  test('channel refs', () => {
    expect(parseChannelRef('C0123ABCD')).toEqual({ kind: 'id', id: 'C0123ABCD' });
    expect(parseChannelRef('D0123ABCD')).toEqual({ kind: 'id', id: 'D0123ABCD' });
    expect(parseChannelRef('#General')).toEqual({ kind: 'name', name: 'general' });
    expect(parseChannelRef('@alice')).toEqual({ kind: 'user', user: 'alice' });
    expect(parseChannelRef('random')).toEqual({ kind: 'name', name: 'random' });
    expect(parseChannelRef('https://acme.slack.com/archives/G0AAAAAAA/p1700000000123456')).toMatchObject({
      kind: 'permalink',
      id: 'G0AAAAAAA',
      ts: '1700000000.123456',
    });
  });

  test('timestamps and --since', () => {
    expect(normalizeTs('p1700000000123456')).toBe('1700000000.123456');
    expect(normalizeTs('1700000000.123456')).toBe('1700000000.123456');
    expect(() => normalizeTs('yesterday')).toThrow();
    const now = Date.parse('2026-10-12T00:00:00Z');
    expect(parseSince('2h', now)).toBe(now / 1000 - 7200);
    expect(parseSince('1w', now)).toBe(now / 1000 - 604800);
    expect(parseSince('2026-10-01T00:00:00Z', now)).toBe(Date.parse('2026-10-01T00:00:00Z') / 1000);
    expect(() => parseSince('soon', now)).toThrow(/--since/);
  });

  test('conversation types and mpim labels', () => {
    expect(slackTypes('public,private,im,mpim')).toBe('public_channel,private_channel,im,mpim');
    expect(() => slackTypes('bogus')).toThrow();
    expect(mpimLabel('mpdm-alice--bob--carol-1')).toBe('@alice, @bob, @carol');
  });
});

describe('mention resolution', () => {
  test('renders mentions, channels, links and escapes', () => {
    const names = new Map([['UALICE', toCached(USERS.UALICE as never)]]);
    const t = renderText(
      'hi <@UALICE> and <@UNOPE|nope> in <#C1|general> <!here> see <https://x.io|docs> &amp; <https://y.io>',
      names,
    );
    expect(t).toBe('hi @Alice A and @nope in #general @here see docs (https://x.io) & https://y.io');
    expect(mentionedUserIds('<@UALICE> <@W123|x> <#C1>')).toEqual(['UALICE', 'W123']);
  });

  test('history resolves authors and mentions via users.info and caches users on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kslack-'));
    const { ctx, lines, calls, client } = makeCtx((m, p) => {
      if (m === 'auth.test') return AUTH;
      if (m === 'conversations.info') return { ok: true, channel: { id: 'C0123ABCD', name: 'general' } };
      if (m === 'users.info') return usersInfo(p);
      if (m === 'conversations.history')
        return {
          ok: true,
          messages: [
            { ts: '1700000100.000000', user: 'UBOB', text: 'thanks <@UALICE>' },
            {
              ts: '1700000000.000000',
              user: 'UALICE',
              text: 'deploy done',
              reply_count: 2,
              thread_ts: '1700000000.000000',
            },
          ],
        };
      throw new Error(`unexpected ${m}`);
    });
    ctx.users = new UserDirectory(client, dir);
    await cmdHistory(ctx, 'C0123ABCD', { limit: 10 });
    const out = lines.join('\n');
    expect(out).toContain('#general (C0123ABCD)');
    expect(out.indexOf('deploy done')).toBeLessThan(out.indexOf('thanks @Alice A')); // oldest first
    expect(out).toContain('@Bob Brown');
    expect(out).toContain('kslack thread C0123ABCD 1700000000.000000');
    expect(calls.filter(c => c.method === 'users.info')).toHaveLength(2);

    const cached = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'));
    expect(Object.keys(cached.users).sort()).toEqual(['UALICE', 'UBOB']);
    expect(JSON.stringify(cached)).not.toContain('deploy done'); // no message content cached

    // second directory instance reads the cache → no more users.info
    const again = new UserDirectory(client, dir);
    expect((await again.resolve(['UALICE'])).get('UALICE')?.displayName).toBe('Alice A');
    expect(calls.filter(c => c.method === 'users.info')).toHaveLength(2);
  });
});

describe('channel resolution', () => {
  const ims = [
    { id: 'D1', is_im: true, user: 'UALICE' },
    { id: 'D2', is_im: true, user: 'UBOB' },
  ];
  const handler: Handler = (m, p) => {
    if (m === 'auth.test') return AUTH;
    if (m === 'users.info') return usersInfo(p);
    if (m === 'users.conversations') {
      if (p.get('types') === 'im') return { ok: true, channels: ims };
      return { ok: true, channels: [{ id: 'C9', name: 'eng-private', is_private: true }] };
    }
    if (m === 'conversations.list') return { ok: true, channels: [{ id: 'C1', name: 'general' }] };
    throw new Error(`unexpected ${m}`);
  };

  test('@user finds the existing DM by handle, display name or email', async () => {
    const { ctx } = makeCtx(handler);
    expect((await resolveChannel(ctx, '@alice')).id).toBe('D1');
    expect((await resolveChannel(ctx, '@Bob Brown')).id).toBe('D2');
    expect((await resolveChannel(ctx, '@bob@acme.io')).id).toBe('D2');
    expect((await resolveChannel(ctx, '@UBOB')).id).toBe('D2');
    await expect(resolveChannel(ctx, '@carol')).rejects.toThrow(/cannot open a new DM/);
  });

  test('#name prefers member channels, falls back to public list', async () => {
    const { ctx } = makeCtx(handler);
    expect(await resolveChannel(ctx, '#eng-private')).toEqual({ id: 'C9', label: '#eng-private' });
    expect((await resolveChannel(ctx, '#general')).id).toBe('C1');
    await expect(resolveChannel(ctx, '#nope')).rejects.toThrow(/no channel named/);
  });
});

describe('commands', () => {
  test('thread <permalink> uses thread_ts and conversations.replies', async () => {
    const { ctx, calls, lines } = makeCtx((m, p) => {
      if (m === 'conversations.info') return { ok: true, channel: { id: 'C0123ABCD', name: 'general' } };
      if (m === 'users.info') return usersInfo(p);
      if (m === 'conversations.replies')
        return {
          ok: true,
          messages: [
            { ts: p.get('ts'), user: 'UALICE', text: 'parent', thread_ts: p.get('ts') },
            { ts: '1700000099.000200', user: 'UBOB', text: 'reply' },
          ],
        };
      throw new Error(`unexpected ${m}`);
    });
    await cmdThread(
      ctx,
      'https://acme.slack.com/archives/C0123ABCD/p1700000099000200?thread_ts=1700000000.123456&cid=C0123ABCD',
      undefined,
      { limit: 100 },
    );
    const replies = calls.find(c => c.method === 'conversations.replies')!;
    expect(replies.params.get('ts')).toBe('1700000000.123456');
    expect(replies.params.get('channel')).toBe('C0123ABCD');
    expect(lines.join('\n')).toContain('  [');
  });

  test('search pages, passes team_id on Enterprise Grid, shows permalink', async () => {
    const { ctx, calls, lines } = makeCtx((m, p) => {
      if (m === 'auth.test') return { ...AUTH, enterprise_id: 'E1' };
      if (m === 'users.info') return usersInfo(p);
      if (m === 'search.messages') {
        const page = Number(p.get('page'));
        return {
          ok: true,
          messages: {
            total: 3,
            paging: { pages: 2 },
            matches:
              page === 1
                ? [
                    {
                      ts: '1700000000.000001',
                      user: 'UALICE',
                      text: 'a',
                      channel: { id: 'C1', name: 'general' },
                      permalink: 'https://acme.slack.com/archives/C1/p1700000000000001',
                    },
                    {
                      ts: '1700000000.000002',
                      user: 'UBOB',
                      text: 'b',
                      channel: { id: 'D1', name: 'UALICE', is_im: true },
                    },
                  ]
                : [{ ts: '1700000000.000003', user: 'UBOB', text: 'c', channel: { id: 'C1', name: 'general' } }],
          },
        };
      }
      throw new Error(`unexpected ${m}`);
    });
    await cmdSearch(ctx, 'deploy', { count: 3 });
    const s = calls.filter(c => c.method === 'search.messages');
    expect(s).toHaveLength(2);
    expect(s[0]!.params.get('team_id')).toBe('T1');
    const out = lines.join('\n');
    expect(out).toContain('#general');
    expect(out).toContain('DM @Alice A');
    expect(out).toContain('https://acme.slack.com/archives/C1/p1700000000000001');
  });

  test('--team overrides auth.test default', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true, messages: { matches: [], total: 0 } }), { team: 'T42' });
    await cmdSearch(ctx, 'x', { count: 5 });
    expect(calls.some(c => c.method === 'auth.test')).toBe(false);
    expect(calls[0]!.params.get('team_id')).toBe('T42');
  });

  test('dms sorts by latest message', async () => {
    const latest: Record<string, string> = { D1: '1700000000.000000', D2: '1700009999.000000' };
    const { ctx, lines } = makeCtx((m, p) => {
      if (m === 'auth.test') return AUTH;
      if (m === 'users.info') return usersInfo(p);
      if (m === 'users.conversations')
        return {
          ok: true,
          channels: [
            { id: 'D1', is_im: true, user: 'UALICE' },
            { id: 'D2', is_im: true, user: 'UBOB' },
            { id: 'G1', is_mpim: true, name: 'mpdm-alice--bob-1' },
          ],
        };
      if (m === 'conversations.history') {
        const ts = latest[p.get('channel')!];
        return { ok: true, messages: ts ? [{ ts, user: 'UALICE', text: 'yo' }] : [] };
      }
      throw new Error(`unexpected ${m}`);
    });
    await cmdDms(ctx, { limit: 10 });
    const heads = lines.filter(l => !l.startsWith(' '));
    expect(heads[0]).toContain('@Bob Brown');
    expect(heads[1]).toContain('@Alice A');
    expect(heads[2]).toContain('@alice, @bob');
  });

  test('users matches by name/email and uses the users.list sweep', async () => {
    const { ctx, lines } = makeCtx(m => {
      if (m === 'auth.test') return AUTH;
      if (m === 'users.list') return { ok: true, members: Object.values(USERS) };
      throw new Error(`unexpected ${m}`);
    });
    await cmdUsers(ctx, 'acme.io', { limit: 10 });
    expect(lines).toHaveLength(2);
    lines.length = 0;
    await cmdUsers(ctx, 'anders', { limit: 10 });
    expect(lines[0]).toContain('@alice');
  });

  test('matchUsers ranks exact matches first', () => {
    const us = [toCached({ id: 'U2', name: 'alicia' }), toCached({ id: 'U1', name: 'ali' })];
    expect(matchUsers(us, 'ali').map(u => u.id)).toEqual(['U1', 'U2']);
  });
});
