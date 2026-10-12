// Command implementations. Each takes a Ctx so tests can drive them with a
// mocked fetch and capture output.
import type { SlackClient, SlackResponse } from './client';
import { formatTs, normalizeTs, parseChannelRef, parsePermalink, parseSince } from './parse';
import { type CachedUser, displayName, matchUsers, mentionedUserIds, renderText, type UserDirectory } from './users';

export interface Ctx {
  client: SlackClient;
  users: UserDirectory;
  out: (line: string) => void;
  json?: boolean;
  /** Explicit --team; otherwise defaulted from auth.test on Enterprise Grid. */
  team?: string;
}

export interface Conversation {
  id: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  created?: number;
  updated?: number;
  [k: string]: unknown;
}

export interface Message {
  ts: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: { name?: string; title?: string }[];
  attachments?: { fallback?: string; text?: string; title?: string }[];
  [k: string]: unknown;
}

interface AuthInfo extends SlackResponse {
  user?: string;
  user_id?: string;
  team?: string;
  team_id?: string;
  enterprise_id?: string;
  url?: string;
}

const authCache = new WeakMap<SlackClient, Promise<AuthInfo>>();

export function authInfo(client: SlackClient): Promise<AuthInfo> {
  let p = authCache.get(client);
  if (!p) {
    p = client.call<AuthInfo>('auth.test');
    authCache.set(client, p);
  }
  return p;
}

/** team_id for methods that need it on Enterprise Grid: --team, else auth.test's team on Grid. */
export async function teamId(ctx: Ctx): Promise<string | undefined> {
  if (ctx.team) return ctx.team;
  const a = await authInfo(ctx.client);
  if (a.enterprise_id && a.team_id && !a.team_id.startsWith('E')) return a.team_id;
  return undefined;
}

function printJson(ctx: Ctx, v: unknown) {
  ctx.out(JSON.stringify(v, null, 2));
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map(l => pad + l)
    .join('\n');
}

const TYPE_MAP: Record<string, string> = {
  public: 'public_channel',
  public_channel: 'public_channel',
  private: 'private_channel',
  private_channel: 'private_channel',
  im: 'im',
  dm: 'im',
  mpim: 'mpim',
  group: 'mpim',
};

export function slackTypes(list: string): string {
  const out = new Set<string>();
  for (const t of list
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)) {
    const m = TYPE_MAP[t];
    if (!m) throw new Error(`unknown conversation type "${t}" (use public, private, im, mpim)`);
    out.add(m);
  }
  return [...out].join(',');
}

/** "mpdm-alice--bob--carol-1" → "@alice, @bob, @carol". */
export function mpimLabel(name: string | undefined): string {
  if (!name) return 'group DM';
  const core = name.replace(/^mpdm-/, '').replace(/-\d+$/, '');
  return core
    .split('--')
    .filter(Boolean)
    .map(h => `@${h}`)
    .join(', ');
}

export function convLabel(c: Conversation, names: Map<string, CachedUser>): string {
  if (c.is_im) return c.user ? `@${displayName(names.get(c.user), c.user)}` : (c.name ?? c.id);
  if (c.is_mpim) return mpimLabel(c.name);
  return `#${c.name ?? c.id}`;
}

function convKind(c: Conversation): string {
  if (c.is_im) return 'dm';
  if (c.is_mpim) return 'group-dm';
  return c.is_private ? 'private' : 'public';
}

async function myConversations(ctx: Ctx, types: string, max = Infinity): Promise<Conversation[]> {
  return ctx.client.paginate<Conversation>(
    'users.conversations',
    { types, exclude_archived: true, team_id: await teamId(ctx) },
    'channels',
    max,
  );
}

export interface ResolvedChannel {
  id: string;
  label: string;
  ts?: string;
  threadTs?: string;
}

/** Turn a channel ID / #name / @user / permalink into a conversation ID. Read-only: never opens DMs. */
export async function resolveChannel(ctx: Ctx, input: string): Promise<ResolvedChannel> {
  const ref = parseChannelRef(input);
  if (ref.kind === 'id' || ref.kind === 'permalink') {
    let label = ref.id;
    try {
      const info = await ctx.client.call('conversations.info', { channel: ref.id });
      const c = info.channel as Conversation;
      const names = await ctx.users.resolve(c.user ? [c.user] : []);
      label = convLabel(c, names);
    } catch {
      // label is cosmetic; history/replies will surface any real access error
    }
    return ref.kind === 'permalink' ? { id: ref.id, label, ts: ref.ts, threadTs: ref.threadTs } : { id: ref.id, label };
  }

  if (ref.kind === 'name') {
    const mine = await myConversations(ctx, 'public_channel,private_channel,mpim');
    let hit = mine.find(c => c.name?.toLowerCase() === ref.name);
    if (!hit) {
      const pub = await ctx.client.paginate<Conversation>(
        'conversations.list',
        { types: 'public_channel', exclude_archived: true, team_id: await teamId(ctx) },
        'channels',
      );
      hit = pub.find(c => c.name?.toLowerCase() === ref.name);
    }
    if (!hit) throw new Error(`no channel named #${ref.name} found (you may not be a member of a private channel)`);
    return { id: hit.id, label: convLabel(hit, new Map()) };
  }

  // @user → find the existing DM with that user among your conversations.
  const ims = await myConversations(ctx, 'im');
  const names = await ctx.users.resolve(ims.map(c => c.user).filter((u): u is string => !!u));
  const partners = [...names.values()];
  const q = ref.user;
  const byId = ims.find(c => c.user === q);
  const matches = byId ? [] : matchUsers(partners, q);
  const exact = matches.filter(u =>
    [u.name, u.displayName, u.realName, u.email].some(f => f?.toLowerCase() === q.toLowerCase()),
  );
  const pick = byId ? undefined : exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
  const im = byId ?? (pick && ims.find(c => c.user === pick.id));
  if (im) return { id: im.id, label: convLabel(im, names) };
  if (matches.length > 1) {
    const list = matches
      .slice(0, 10)
      .map(u => `@${u.name ?? u.id} (${displayName(u, u.id)})`)
      .join(', ');
    throw new Error(`@${q} is ambiguous among your DMs: ${list}`);
  }
  throw new Error(`no existing DM with @${q} found (kslack is read-only and cannot open a new DM)`);
}

/** Resolve all authors + mentioned users in messages. */
async function namesFor(ctx: Ctx, msgs: Message[]): Promise<Map<string, CachedUser>> {
  const ids: string[] = [];
  for (const m of msgs) {
    if (m.user) ids.push(m.user);
    ids.push(...mentionedUserIds(m.text));
  }
  return ctx.users.resolve(ids);
}

function author(m: Message, names: Map<string, CachedUser>): string {
  if (m.user) return `@${displayName(names.get(m.user), m.user)}`;
  return m.bot_profile?.name ?? m.username ?? (m.subtype ? `(${m.subtype})` : '(unknown)');
}

export function formatMessage(
  m: Message,
  names: Map<string, CachedUser>,
  opts: { channel?: string; pad?: string } = {},
): string {
  const pad = opts.pad ?? '';
  const lines = [`${pad}[${formatTs(m.ts)}] ${author(m, names)}  (ts ${m.ts})`];
  const body = renderText(m.text, names);
  if (body) lines.push(indent(body, `${pad}    `));
  for (const f of m.files ?? []) lines.push(`${pad}    [file: ${f.title || f.name || 'untitled'}]`);
  for (const a of m.attachments ?? []) {
    const t = a.title || a.fallback || a.text;
    if (t) lines.push(`${pad}    [attachment: ${renderText(t, names).split('\n')[0]}]`);
  }
  if (m.reply_count && opts.channel && (!m.thread_ts || m.thread_ts === m.ts)) {
    lines.push(
      `${pad}    ↳ ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'} — kslack thread ${opts.channel} ${m.ts}`,
    );
  }
  return lines.join('\n');
}

// ── commands ──────────────────────────────────────────────────────────────

export async function cmdAuth(ctx: Ctx) {
  const a = await authInfo(ctx.client);
  if (ctx.json) return printJson(ctx, a);
  ctx.out(`user:          ${a.user ?? '?'} (${a.user_id ?? '?'})`);
  ctx.out(`team:          ${a.team ?? '?'} (${a.team_id ?? '?'})`);
  ctx.out(`enterprise_id: ${a.enterprise_id ?? '-'}`);
  if (a.url) ctx.out(`url:           ${a.url}`);
}

interface SearchMatch extends Message {
  channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string };
  permalink?: string;
}

export async function cmdSearch(ctx: Ctx, query: string, opts: { count: number; sort?: string }) {
  const matches: SearchMatch[] = [];
  let total: number | undefined;
  const team_id = await teamId(ctx);
  for (let page = 1; matches.length < opts.count; page++) {
    const res = await ctx.client.call('search.messages', {
      query,
      count: Math.min(100, opts.count),
      page,
      sort: opts.sort ?? 'timestamp',
      sort_dir: 'desc',
      highlight: false,
      team_id,
    });
    const m = res.messages as { matches?: SearchMatch[]; total?: number; paging?: { pages?: number } } | undefined;
    total = m?.total;
    matches.push(...(m?.matches ?? []));
    if (!m?.matches?.length || page >= (m.paging?.pages ?? 1)) break;
  }
  const shown = matches.slice(0, opts.count);
  if (ctx.json) return printJson(ctx, { query, total, matches: shown });

  const ids: string[] = [];
  for (const m of shown) {
    if (m.channel?.is_im && m.channel.user) ids.push(m.channel.user);
    if (m.channel?.is_im && /^[UW][A-Z0-9]+$/.test(m.channel.name ?? '')) ids.push(m.channel.name!);
  }
  const names = await namesFor(ctx, shown);
  for (const [k, v] of await ctx.users.resolve(ids)) names.set(k, v);

  if (!shown.length) return ctx.out(`no messages match ${JSON.stringify(query)}`);
  ctx.out(`${shown.length} of ${total ?? '?'} matches for ${JSON.stringify(query)}\n`);
  for (const m of shown) {
    const ch = m.channel ?? {};
    let where: string;
    if (ch.is_im) {
      const uid = ch.user ?? ch.name;
      where = `DM @${uid ? displayName(names.get(uid), uid) : '?'}`;
    } else if (ch.is_mpim) where = mpimLabel(ch.name);
    else where = `#${ch.name ?? ch.id ?? '?'}`;
    ctx.out(`${where}  ${formatMessage(m, names)}`);
    if (m.permalink) ctx.out(`    ${m.permalink}`);
    ctx.out('');
  }
}

export async function cmdChannels(ctx: Ctx, opts: { type: string; limit: number }) {
  const convs = await myConversations(ctx, slackTypes(opts.type), opts.limit);
  if (ctx.json) return printJson(ctx, convs);
  const names = await ctx.users.resolve(convs.map(c => c.user).filter((u): u is string => !!u));
  const order = ['public', 'private', 'group-dm', 'dm'];
  const rows = convs
    .map(c => ({ c, kind: convKind(c), label: convLabel(c, names) }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label));
  for (const r of rows) ctx.out(`${r.c.id.padEnd(12)} ${r.kind.padEnd(9)} ${r.label}`);
  ctx.out(`\n${rows.length} conversation(s)`);
}

export async function cmdDms(ctx: Ctx, opts: { limit: number }) {
  const all = await myConversations(ctx, 'im,mpim');
  // Pre-sort by the conversation's own timestamps, then fetch the latest
  // message for the top slice so the final order reflects real activity.
  const candidates = all
    .sort((a, b) => (b.updated ?? (b.created ?? 0) * 1000) - (a.updated ?? (a.created ?? 0) * 1000))
    .slice(0, Math.max(opts.limit * 2, opts.limit + 10));
  const latest = new Map<string, Message | undefined>();
  const queue = [...candidates];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const res = await ctx.client.call('conversations.history', { channel: c.id, limit: 1 });
        latest.set(c.id, (res.messages as Message[] | undefined)?.[0]);
      } catch {
        latest.set(c.id, undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  const rows = candidates
    .map(c => ({ c, last: latest.get(c.id) }))
    .sort((a, b) => Number(b.last?.ts ?? 0) - Number(a.last?.ts ?? 0))
    .slice(0, opts.limit);
  if (ctx.json)
    return printJson(
      ctx,
      rows.map(r => ({ ...r.c, latest: r.last })),
    );

  const ids = rows
    .flatMap(r => [r.c.user, r.last?.user, ...mentionedUserIds(r.last?.text)])
    .filter((u): u is string => !!u);
  const names = await ctx.users.resolve(ids);
  for (const { c, last } of rows) {
    const preview = last ? renderText(last.text, names).replace(/\s+/g, ' ').slice(0, 80) : '';
    const who = last ? author(last, names) : '';
    ctx.out(`${c.id.padEnd(12)} ${convLabel(c, names)}`);
    if (last) ctx.out(`    [${formatTs(last.ts)}] ${who}: ${preview}`);
  }
}

export async function cmdHistory(ctx: Ctx, channel: string, opts: { limit: number; since?: string }) {
  const ch = await resolveChannel(ctx, channel);
  const oldest = opts.since ? parseSince(opts.since) : undefined;
  const msgs = await ctx.client.paginate<Message>(
    'conversations.history',
    { channel: ch.id, oldest },
    'messages',
    opts.limit,
  );
  if (ctx.json) return printJson(ctx, { channel: ch, messages: msgs });
  const names = await namesFor(ctx, msgs);
  ctx.out(`${ch.label} (${ch.id}) — ${msgs.length} message(s), oldest first\n`);
  for (const m of [...msgs].reverse()) ctx.out(formatMessage(m, names, { channel: ch.id }));
}

export async function cmdThread(ctx: Ctx, a: string, b: string | undefined, opts: { limit: number }) {
  let ch: ResolvedChannel;
  let ts: string;
  if (b === undefined) {
    const link = parsePermalink(a);
    if (!link) throw new Error('thread: pass <channel> <ts> or a Slack message permalink');
    ch = await resolveChannel(ctx, a);
    ts = link.threadTs ?? link.ts;
  } else {
    ch = await resolveChannel(ctx, a);
    ts = normalizeTs(b);
  }
  const msgs = await ctx.client.paginate<Message>(
    'conversations.replies',
    { channel: ch.id, ts },
    'messages',
    opts.limit,
  );
  if (ctx.json) return printJson(ctx, { channel: ch, thread_ts: ts, messages: msgs });
  const names = await namesFor(ctx, msgs);
  ctx.out(`${ch.label} (${ch.id}) thread ${ts} — ${msgs.length} message(s)\n`);
  msgs.forEach((m, i) => ctx.out(formatMessage(m, names, { pad: i === 0 ? '' : '  ' })));
}

export async function cmdUsers(ctx: Ctx, query: string, opts: { limit: number; refresh?: boolean }) {
  const all = await ctx.users.all({ refresh: opts.refresh, team: await teamId(ctx) });
  const hits = matchUsers(all, query).slice(0, opts.limit);
  if (ctx.json) return printJson(ctx, hits);
  if (!hits.length) return ctx.out(`no users match ${JSON.stringify(query)}`);
  for (const u of hits) {
    const flags = [u.deleted && 'deleted', u.isBot && 'bot'].filter(Boolean).join(',');
    const cols = [
      u.id.padEnd(12),
      `@${u.name ?? '?'}`,
      displayName(u, ''),
      u.realName && u.realName !== displayName(u, '') ? `(${u.realName})` : '',
      u.email ?? '',
      flags ? `[${flags}]` : '',
    ];
    ctx.out(cols.filter(Boolean).join('  '));
  }
}
