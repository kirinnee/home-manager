import { describe, expect, test } from 'bun:test';
import { BLOCKED_CODE } from './policy';
import { NOT_LOGGED_IN_CODE, createProxy } from './proxy';
import { TOKEN_ENDPOINT, UPSTREAM, fakeFetch, jsonRes, refreshReply, sseRes, tempStore, tokenSet } from './testutil';
import { TokenManager } from './tokens';
import type { FetchLike } from './oauth';

const TOOLS = [
  { name: 'slack_search_public' },
  { name: 'slack_send_message' },
  { name: 'slack_read_thread' },
  { name: 'slack_future_write_tool' },
];
const toolsResult = { jsonrpc: '2.0', id: 2, result: { tools: TOOLS } };

function setup(upstream: FetchLike, o: { loggedIn?: boolean; allowWrites?: boolean; logs?: string[] } = {}) {
  const store = tempStore();
  if (o.loggedIn !== false) store.write(tokenSet());
  const logs = o.logs ?? [];
  const tokens = new TokenManager({ store, fetch: upstream, log: m => logs.push(m) });
  const proxy = createProxy({
    tokens,
    upstream: UPSTREAM,
    allowWrites: o.allowWrites ?? false,
    fetch: upstream,
    log: m => logs.push(m),
  });
  return { proxy, store, tokens, logs };
}

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:37373/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

describe('proxy pass-through', () => {
  test('injects bearer, strips client Authorization, forwards MCP headers both ways', async () => {
    const up = fakeFetch(() =>
      jsonRes({ jsonrpc: '2.0', id: 1, result: {} }, 200, { 'mcp-session-id': 'sess-42', 'content-encoding': 'gzip' }),
    );
    const { proxy } = setup(up);
    const res = await proxy(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { authorization: 'Bearer client-junk', 'mcp-session-id': 'sess-41', 'mcp-protocol-version': '2025-06-18' },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('sess-42');
    expect(res.headers.get('content-encoding')).toBeNull();
    const c = up.calls[0];
    expect(c.url).toBe(UPSTREAM);
    expect(c.headers.get('authorization')).toBe(`Bearer ${tokenSet().access_token}`);
    expect(c.headers.get('mcp-session-id')).toBe('sess-41');
    expect(c.headers.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(c.headers.get('accept')).toBe('application/json, text/event-stream');
    expect(c.headers.get('host')).toBeNull();
  });

  test('GET (SSE) and DELETE are forwarded with the session id', async () => {
    const up = fakeFetch((_u, c) =>
      c.init.method === 'GET'
        ? sseRes([{ jsonrpc: '2.0', method: 'notifications/x' }])
        : new Response(null, { status: 204 }),
    );
    const { proxy } = setup(up);
    const g = await proxy(
      new Request('http://127.0.0.1/mcp', { headers: { accept: 'text/event-stream', 'mcp-session-id': 's1' } }),
    );
    expect(g.headers.get('content-type')).toBe('text/event-stream');
    expect(await g.text()).toContain('notifications/x');
    const d = await proxy(
      new Request('http://127.0.0.1/mcp', { method: 'DELETE', headers: { 'mcp-session-id': 's1' } }),
    );
    expect(d.status).toBe(204);
    expect(up.calls.map(c => [c.init.method, c.headers.get('mcp-session-id')])).toEqual([
      ['GET', 's1'],
      ['DELETE', 's1'],
    ]);
  });

  test('SSE is streamed, not buffered: first event arrives before upstream finishes', async () => {
    let finish!: () => void;
    const up = fakeFetch(() => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(ctl) {
          ctl.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 9, result: { ok: 1 } })}\n\n`));
          await new Promise<void>(r => (finish = r));
          ctl.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const { proxy } = setup(up);
    const res = await proxy(rpc({ jsonrpc: '2.0', id: 9, method: 'ping' }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"id":9');
    finish();
    expect((await reader.read()).done).toBe(true);
  });

  test('401 → one refresh → retry once with the new token', async () => {
    const reply = refreshReply();
    const up = fakeFetch((url, c) => {
      if (url === TOKEN_ENDPOINT) return jsonRes(reply);
      return c.headers.get('authorization') === `Bearer ${reply.access_token}`
        ? jsonRes({ jsonrpc: '2.0', id: 1, result: {} })
        : jsonRes({}, 401);
    });
    const { proxy, store } = setup(up);
    const res = await proxy(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(res.status).toBe(200);
    expect(up.calls.map(c => c.url)).toEqual([UPSTREAM, TOKEN_ENDPOINT, UPSTREAM]);
    expect(up.calls[2].body).toBe(up.calls[0].body); // request body replayed
    expect(store.read()!.access_token).toBe(reply.access_token as string);
  });

  test('401 again after refresh → clear login error, no third attempt', async () => {
    const up = fakeFetch(url =>
      url === TOKEN_ENDPOINT ? jsonRes(refreshReply()) : jsonRes({}, 401, { 'www-authenticate': 'Bearer x' }),
    );
    const { proxy } = setup(up);
    const res = await proxy(rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const body = (await res.json()) as { id: number; error: { code: number; message: string } };
    expect(body.id).toBe(5);
    expect(body.error.message).toContain('kslack-proxy login');
    expect(up.calls.length).toBe(3);
  });

  test('concurrent 401s share a single refresh', async () => {
    const reply = refreshReply();
    const up = fakeFetch(async (url, c) => {
      if (url === TOKEN_ENDPOINT) {
        await Bun.sleep(10);
        return jsonRes(reply);
      }
      return c.headers.get('authorization') === `Bearer ${reply.access_token}`
        ? jsonRes({ jsonrpc: '2.0', id: 1, result: {} })
        : jsonRes({}, 401);
    });
    const { proxy } = setup(up);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => proxy(rpc({ jsonrpc: '2.0', id: i, method: 'ping' }))),
    );
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(up.calls.filter(c => c.url === TOKEN_ENDPOINT).length).toBe(1);
  });

  test('not logged in → 503 JSON-RPC error telling the human to log in, nothing sent upstream', async () => {
    const up = fakeFetch(() => jsonRes({}));
    const { proxy } = setup(up, { loggedIn: false });
    const res = await proxy(rpc({ jsonrpc: '2.0', id: 3, method: 'initialize' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { id: number; error: { code: number; message: string } };
    expect(body).toMatchObject({ id: 3, error: { code: NOT_LOGGED_IN_CODE } });
    expect(body.error.message).toContain('kslack-proxy login');
    expect(up.calls.length).toBe(0);
    const h = await proxy(new Request('http://127.0.0.1/healthz'));
    expect(await h.json()).toMatchObject({ ok: true, loggedIn: false, readOnly: true });
  });
});

describe('read-only policy', () => {
  test('tools/list (JSON) keeps only allowlisted read tools', async () => {
    const { proxy } = setup(fakeFetch(() => jsonRes(toolsResult)));
    const body = (await (
      await proxy(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    ).json()) as typeof toolsResult;
    expect(body.result.tools.map(t => t.name)).toEqual(['slack_search_public', 'slack_read_thread']);
  });

  test('tools/list inside SSE frames is filtered too (split across chunks)', async () => {
    const enc = new TextEncoder();
    const frame = `id: 7\nevent: message\ndata: ${JSON.stringify(toolsResult)}\n\n`;
    const up = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctl) {
              ctl.enqueue(enc.encode(frame.slice(0, 40)));
              ctl.enqueue(enc.encode(frame.slice(40)));
              ctl.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const { proxy } = setup(up);
    const text = await (await proxy(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).text();
    expect(text).toStartWith('id: 7\nevent: message\ndata: ');
    expect(text).toEndWith('\n\n');
    const data = JSON.parse(
      text
        .split('\n')
        .find(l => l.startsWith('data: '))!
        .slice(6),
    ) as typeof toolsResult;
    expect(data.result.tools.map(t => t.name)).toEqual(['slack_search_public', 'slack_read_thread']);
  });

  test('tools/call for a write tool (or an unknown tool) is rejected without reaching Slack', async () => {
    const up = fakeFetch(() => jsonRes({}));
    const { proxy } = setup(up);
    for (const name of ['slack_send_message', 'slack_future_write_tool']) {
      const res = await proxy(rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name, arguments: {} } }));
      const body = (await res.json()) as { id: number; error: { code: number; message: string } };
      expect(body.id).toBe(11);
      expect(body.error.code).toBe(BLOCKED_CODE);
      expect(body.error.message).toContain(name);
    }
    expect(up.calls.length).toBe(0);
  });

  test('batched tools/call with a write tool is rejected', async () => {
    const up = fakeFetch(() => jsonRes({}));
    const { proxy } = setup(up);
    const res = await proxy(
      rpc([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_read_thread' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slack_add_reaction' } },
      ]),
    );
    const body = (await res.json()) as { id: number }[];
    expect(body.map(b => b.id)).toEqual([2]);
    expect(up.calls.length).toBe(0);
  });

  test('read tools/call passes through', async () => {
    const up = fakeFetch(() => jsonRes({ jsonrpc: '2.0', id: 4, result: { content: [] } }));
    const { proxy } = setup(up);
    const res = await proxy(
      rpc({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'slack_search_public_and_private', arguments: { query: 'x' } },
      }),
    );
    expect(res.status).toBe(200);
    expect(up.calls.length).toBe(1);
  });

  test('KSLACK_PROXY_ALLOW_WRITES lifts both filters', async () => {
    const up = fakeFetch(() => jsonRes(toolsResult));
    const { proxy } = setup(up, { allowWrites: true });
    const list = (await (
      await proxy(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    ).json()) as typeof toolsResult;
    expect(list.result.tools.length).toBe(4);
    await proxy(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slack_send_message' } }));
    expect(up.calls.length).toBe(2);
  });
});

describe('secrets never leak', () => {
  test('tokens are absent from logs and error bodies, even on refresh/network failures', async () => {
    const logs: string[] = [];
    const old = tokenSet();
    const up = fakeFetch(url => {
      if (url === TOKEN_ENDPOINT) throw new Error(`boom refresh_token=${old.refresh_token} Bearer ${old.access_token}`);
      return jsonRes({}, 401);
    });
    const { proxy } = setup(up, { logs });
    const res = await proxy(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    const text = await res.text();
    const everything = [text, ...logs].join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [old.access_token, old.refresh_token!, 'OLDACCESS', 'OLDREFRESH', 'xoxe', 'xoxp'])
      expect(everything).not.toContain(secret);
  });

  test('upstream network error messages are scrubbed', async () => {
    const logs: string[] = [];
    const up = fakeFetch(() => {
      throw new Error(`connect failed for Authorization: Bearer ${tokenSet().access_token}`);
    });
    const { proxy } = setup(up, { logs });
    const res = await proxy(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(res.status).toBe(502);
    const all = [await res.text(), ...logs].join('\n');
    expect(all).not.toContain('OLDACCESS');
    expect(all).toContain('[redacted]');
  });
});
