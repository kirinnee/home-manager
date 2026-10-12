// User directory: resolves user IDs to display names, with a small on-disk
// cache under ~/.cache/kslack/users.json. Only user profile fields are cached —
// never message content.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SlackClient } from './client';

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string; email?: string; title?: string };
  [k: string]: unknown;
}

export interface CachedUser {
  id: string;
  name?: string;
  realName?: string;
  displayName?: string;
  email?: string;
  title?: string;
  deleted?: boolean;
  isBot?: boolean;
  at: number;
}

interface CacheFile {
  version: 1;
  users: Record<string, CachedUser>;
  /** When a full users.list sweep last completed (ms). */
  listedAt?: number;
}

const USER_TTL_MS = 7 * 86400_000;
const LIST_TTL_MS = 86400_000;

export function defaultCacheDir(env: Record<string, string | undefined> = process.env): string {
  if (env.KSLACK_CACHE_DIR) return env.KSLACK_CACHE_DIR;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'kslack');
}

export function toCached(u: SlackUser, now = Date.now()): CachedUser {
  return {
    id: u.id,
    name: u.name,
    realName: u.profile?.real_name || u.real_name,
    displayName: u.profile?.display_name || undefined,
    email: u.profile?.email,
    title: u.profile?.title || undefined,
    deleted: u.deleted || undefined,
    isBot: u.is_bot || undefined,
    at: now,
  };
}

export function displayName(u: CachedUser | undefined, fallback: string): string {
  if (!u) return fallback;
  return u.displayName || u.realName || u.name || fallback;
}

export class UserDirectory {
  private cache: CacheFile;
  private dirty = false;
  private readonly file: string;

  constructor(
    private readonly client: SlackClient,
    private readonly cacheDir: string | null = defaultCacheDir(),
    private readonly now: () => number = Date.now,
  ) {
    this.file = cacheDir ? join(cacheDir, 'users.json') : '';
    this.cache = { version: 1, users: {} };
    if (!cacheDir) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as CacheFile;
      if (parsed?.version === 1 && parsed.users) this.cache = parsed;
    } catch {
      // missing or corrupt cache → start empty
    }
  }

  private fresh(u: CachedUser | undefined): u is CachedUser {
    return !!u && this.now() - u.at < USER_TTL_MS;
  }

  remember(users: SlackUser[]): void {
    const now = this.now();
    for (const u of users) if (u?.id) this.cache.users[u.id] = toCached(u, now);
    if (users.length) this.dirty = true;
  }

  peek(id: string): CachedUser | undefined {
    return this.cache.users[id];
  }

  /** Resolve the given user IDs (fetching misses via users.info). Unknown IDs are skipped. */
  async resolve(ids: Iterable<string>): Promise<Map<string, CachedUser>> {
    const out = new Map<string, CachedUser>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const c = this.cache.users[id];
      if (this.fresh(c)) out.set(id, c);
      else missing.push(id);
    }
    const queue = [...missing];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const res = await this.client.call('users.info', { user: id });
          const u = res.user as SlackUser | undefined;
          if (u) {
            this.remember([u]);
            out.set(id, this.cache.users[id]!);
          }
        } catch {
          // user_not_found, bot IDs, etc. — fall back to stale cache or the raw ID
          const stale = this.cache.users[id];
          if (stale) out.set(id, stale);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    this.save();
    return out;
  }

  async name(id: string): Promise<string> {
    const m = await this.resolve([id]);
    return displayName(m.get(id), id);
  }

  /** Every user in the workspace (users.list), using the cache if a sweep is < 1 day old. */
  async all(opts: { refresh?: boolean; team?: string } = {}): Promise<CachedUser[]> {
    const listedAt = this.cache.listedAt ?? 0;
    if (opts.refresh || this.now() - listedAt >= LIST_TTL_MS) {
      const users = await this.client.paginate<SlackUser>('users.list', { team_id: opts.team }, 'members');
      this.remember(users);
      this.cache.listedAt = this.now();
      this.dirty = true;
      this.save();
    }
    return Object.values(this.cache.users);
  }

  save(): void {
    if (!this.cacheDir || !this.dirty) return;
    try {
      mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.cache), { mode: 0o600 });
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      // cache is best-effort
    }
  }
}

/** Case-insensitive match against handle, display name, real name and email. */
export function matchUsers(users: CachedUser[], query: string): CachedUser[] {
  const q = query.trim().replace(/^@/, '').toLowerCase();
  if (!q) return [];
  const fields = (u: CachedUser) => [u.name, u.displayName, u.realName, u.email, u.id].filter(Boolean) as string[];
  const exact = users.filter(u => fields(u).some(f => f.toLowerCase() === q));
  const partial = users.filter(u => !exact.includes(u) && fields(u).some(f => f.toLowerCase().includes(q)));
  const rank = (u: CachedUser) => (u.deleted ? 2 : 0) + (u.isBot ? 1 : 0);
  return [...exact, ...partial.sort((a, b) => rank(a) - rank(b))];
}

/** Collect every user ID mentioned as <@U…> in text. */
export function mentionedUserIds(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]!);
}

/** Render Slack mrkdwn entities as plain text: mentions, channels, links, specials, HTML escapes. */
export function renderText(text: string | undefined, names: Map<string, CachedUser>): string {
  if (!text) return '';
  return text
    .replace(
      /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_, id: string, label?: string) => `@${displayName(names.get(id), label || id)}`,
    )
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label || id}`)
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => label || `@${id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, w: string) => `@${w}`)
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, (_, fb: string) => fb)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_, url: string) => url)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
