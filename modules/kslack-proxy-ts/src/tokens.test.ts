import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { TokenStore } from './store';
import { TOKEN_ENDPOINT, fakeFetch, jsonRes, refreshReply, tempStore, tokenSet } from './testutil';
import { NotLoggedInError, TokenManager } from './tokens';

describe('TokenStore', () => {
  test('atomic persist: 0700 dir, 0600 file, no temp files left, round-trips', () => {
    const store = tempStore();
    store.write(tokenSet());
    store.write(tokenSet({ access_token: 'xoxe.xoxp-second-eeeeeeee' }));
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(store.dir)).toEqual(['token.json']);
    expect(store.read()?.access_token).toBe('xoxe.xoxp-second-eeeeeeee');
  });

  test('a failed write leaves the previous token file intact', () => {
    const store = tempStore();
    store.write(tokenSet());
    const before = readFileSync(store.file, 'utf8');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.write(circular as never)).toThrow();
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    expect(readdirSync(store.dir)).toEqual(['token.json']);
  });

  test('logout deletes the token', () => {
    const store = tempStore();
    store.write(tokenSet());
    expect(store.delete()).toBe(true);
    expect(store.read()).toBeNull();
    expect(store.delete()).toBe(false);
  });
});

describe('TokenManager', () => {
  test('not logged in → NotLoggedInError with the login hint', async () => {
    const tm = new TokenManager({ store: tempStore(), fetch: fakeFetch(() => jsonRes({})) });
    await expect(tm.accessToken()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(tm.accessToken()).rejects.toThrow('kslack-proxy login');
  });

  test('fresh token is returned without refreshing', async () => {
    const store = tempStore();
    store.write(tokenSet());
    const f = fakeFetch(() => jsonRes(refreshReply()));
    const tm = new TokenManager({ store, fetch: f });
    expect(await tm.accessToken()).toBe(tokenSet().access_token);
    expect(f.calls.length).toBe(0);
  });

  test('refresh mutex: N concurrent callers near expiry → exactly 1 refresh', async () => {
    const store = tempStore();
    store.write(tokenSet({ expires_at: Date.now() + 60_000 }));
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const reply = refreshReply();
    const f = fakeFetch(async url => {
      expect(url).toBe(TOKEN_ENDPOINT);
      await gate;
      return jsonRes(reply);
    });
    const tm = new TokenManager({ store, fetch: f });
    const all = Promise.all(Array.from({ length: 20 }, () => tm.accessToken()));
    await Bun.sleep(5);
    release();
    const tokens = await all;
    expect(f.calls.length).toBe(1);
    expect(new Set(tokens)).toEqual(new Set([reply.access_token as string]));
    const body = new URLSearchParams(f.calls[0].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('refresh_token')).toBe(tokenSet().refresh_token!);
    expect(body.has('client_secret')).toBe(false);
  });

  test('new token set is persisted before it is handed out', async () => {
    const store = tempStore();
    store.write(tokenSet({ expires_at: Date.now() - 1 }));
    const reply = refreshReply();
    const seenOnDisk: string[] = [];
    const tm = new TokenManager({ store, fetch: fakeFetch(() => jsonRes(reply)) });
    const tok = await tm.accessToken();
    seenOnDisk.push(new TokenStore(store.file).read()!.access_token);
    expect(seenOnDisk[0]).toBe(tok);
    const disk = store.read()!;
    expect(disk.refresh_token).toBe(reply.refresh_token as string);
    expect(disk.last_refresh_at).toBeGreaterThan(0);
    expect(disk.user_id).toBe('U123'); // identity survives the refresh
  });

  test('refresh with an already-replaced stale token does not spend the refresh token', async () => {
    const store = tempStore();
    store.write(tokenSet());
    const f = fakeFetch(() => jsonRes(refreshReply()));
    const tm = new TokenManager({ store, fetch: f });
    const t = await tm.refresh('xoxe.xoxp-some-older-token-zzzz');
    expect(t.access_token).toBe(tokenSet().access_token);
    expect(f.calls.length).toBe(0);
  });

  test('dead refresh token → NotLoggedIn until a new login lands', async () => {
    const store = tempStore();
    store.write(tokenSet({ expires_at: Date.now() - 1 }));
    const f = fakeFetch(() => jsonRes({ ok: false, error: 'invalid_refresh_token' }));
    const tm = new TokenManager({ store, fetch: f });
    await expect(tm.accessToken()).rejects.toBeInstanceOf(NotLoggedInError);
    await expect(tm.accessToken()).rejects.toBeInstanceOf(NotLoggedInError);
    expect(f.calls.length).toBe(1); // never hammers Slack with a spent token
    await Bun.sleep(5);
    store.write(tokenSet({ access_token: 'xoxe.xoxp-relogin-ffffffff' }));
    expect(await tm.accessToken()).toBe('xoxe.xoxp-relogin-ffffffff');
  });
});
