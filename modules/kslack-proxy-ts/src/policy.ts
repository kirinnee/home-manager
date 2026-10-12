// Read-only policy. An ALLOWLIST, so any tool Slack adds later is blocked until
// someone reviews it and adds it here.
//
// Full tool list observed on mcp.slack.com (2026-10, from real fleet sessions):
//   read  → allowed below
//   write → slack_send_message, slack_send_message_draft, slack_schedule_message,
//           slack_create_canvas, slack_update_canvas, slack_create_conversation,
//           slack_add_reaction, slack_get_file_upload_url, slack_complete_file_upload,
//           slack_create_list, slack_update_list, slack_add_list_record,
//           slack_update_list_record
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'slack_search_public',
  'slack_search_public_and_private',
  'slack_search_channels',
  'slack_search_users',
  'slack_search_emojis',
  'slack_read_channel',
  'slack_read_thread',
  'slack_read_canvas',
  'slack_read_file',
  'slack_read_list',
  'slack_read_user_profile',
  'slack_list_user_channels',
  'slack_list_channel_members',
  'slack_get_reactions',
]);

export const isAllowedTool = (name: unknown): boolean => typeof name === 'string' && READ_TOOLS.has(name);

/** JSON-RPC error code for a tool blocked by the read-only policy. */
export const BLOCKED_CODE = -32003;

type Msg = Record<string, unknown>;
const isMsg = (v: unknown): v is Msg => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Drop non-allowlisted tools from any JSON-RPC result carrying `result.tools`. */
export function filterMessage(msg: unknown): { changed: boolean; msg: unknown } {
  if (Array.isArray(msg)) {
    let changed = false;
    const out = msg.map(m => {
      const r = filterMessage(m);
      changed ||= r.changed;
      return r.msg;
    });
    return { changed, msg: out };
  }
  if (!isMsg(msg) || !isMsg(msg.result) || !Array.isArray(msg.result.tools)) return { changed: false, msg };
  const tools = msg.result.tools as unknown[];
  const kept = tools.filter(t => isMsg(t) && isAllowedTool(t.name));
  if (kept.length === tools.length) return { changed: false, msg };
  return { changed: true, msg: { ...msg, result: { ...msg.result, tools: kept } } };
}

/** tools/call requests in a (possibly batched) JSON-RPC body that the policy blocks. */
export function blockedCalls(body: unknown): Msg[] {
  const items = Array.isArray(body) ? body : [body];
  return items.filter(
    (m): m is Msg =>
      isMsg(m) && m.method === 'tools/call' && !isAllowedTool(isMsg(m.params) ? m.params.name : undefined),
  );
}

export function blockedError(req: Msg): Msg {
  const name = isMsg(req.params) && typeof req.params.name === 'string' ? req.params.name : '(unnamed)';
  return {
    jsonrpc: '2.0',
    id: req.id ?? null,
    error: {
      code: BLOCKED_CODE,
      message: `kslack-proxy is read-only: Slack tool "${name}" is blocked. Only read tools are allowed (set KSLACK_PROXY_ALLOW_WRITES=1 on the proxy to lift this).`,
    },
  };
}

/** Rewrite an SSE stream, filtering `tools` out of every `data:` JSON payload. */
export function sseFilter(): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  const rewrite = (block: string): string => {
    const lines = block.split(/\r?\n/);
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''));
    if (data.length === 0) return block;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      return block;
    }
    const r = filterMessage(parsed);
    if (!r.changed) return block;
    const others = lines.filter(l => !l.startsWith('data:'));
    return [...others, `data: ${JSON.stringify(r.msg)}`].join('\n');
  };
  return new TransformStream({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      // events end at a blank line; emit each complete one as soon as it lands
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        controller.enqueue(enc.encode(`${rewrite(block)}${m[0]}`));
      }
    },
    flush(controller) {
      buf += dec.decode();
      if (buf) controller.enqueue(enc.encode(rewrite(buf)));
    },
  });
}
