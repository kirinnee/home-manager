// Pure parsing helpers: channel references, permalinks, timestamps, durations.

export type ChannelRef =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string }
  | { kind: 'user'; user: string }
  | { kind: 'permalink'; id: string; ts: string; threadTs?: string };

export interface Permalink {
  channel: string;
  ts: string;
  threadTs?: string;
}

const CHANNEL_ID = /^[CDG][A-Z0-9]{6,}$/;

/** Parse a Slack message permalink: https://x.slack.com/archives/C123/p1700000000123456[?thread_ts=…]. */
export function parsePermalink(input: string): Permalink | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (!/(^|\.)slack\.com$/.test(url.hostname)) return undefined;
  const m = url.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/);
  if (!m) return undefined;
  const threadTs = url.searchParams.get('thread_ts') ?? undefined;
  return { channel: m[1]!, ts: `${m[2]}.${m[3]}`, threadTs: threadTs && normalizeTs(threadTs) };
}

/** Accept a channel ID, #name, @user, or a message permalink. */
export function parseChannelRef(input: string): ChannelRef {
  const s = input.trim();
  const link = parsePermalink(s);
  if (link) return { kind: 'permalink', id: link.channel, ts: link.ts, threadTs: link.threadTs };
  if (s.startsWith('#')) return { kind: 'name', name: s.slice(1).toLowerCase() };
  if (s.startsWith('@')) return { kind: 'user', user: s.slice(1) };
  if (CHANNEL_ID.test(s)) return { kind: 'id', id: s };
  // A bare channel name is the friendliest fallback.
  return { kind: 'name', name: s.toLowerCase() };
}

/** Normalize "1700000000.123456" or "p1700000000123456" to the API's "1700000000.123456". */
export function normalizeTs(ts: string): string {
  const s = ts.trim();
  const p = s.match(/^p?(\d{10})(\d{6})$/);
  if (p) return `${p[1]}.${p[2]}`;
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  throw new Error(`not a Slack message timestamp: "${ts}" (expected e.g. 1700000000.123456)`);
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** "--since" → Unix seconds. Accepts 30m / 6h / 2d / 1w durations or any Date-parsable date. */
export function parseSince(input: string, now: number = Date.now()): number {
  const s = input.trim();
  const d = s.match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (d) return Math.floor(now / 1000 - Number(d[1]) * UNITS[d[2]!.toLowerCase()]!);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--since: cannot parse "${input}" (use e.g. 2h, 3d, 1w or 2026-10-01)`);
  return Math.floor(t / 1000);
}

/** Slack ts → "YYYY-MM-DD HH:MM" in local time. */
export function formatTs(ts: string | undefined): string {
  if (!ts) return '?';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function parseIntOption(name: string, v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${v}"`);
  return n;
}
