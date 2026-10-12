// Read-only Slack Web API client.
//
// Read-only BY CONSTRUCTION: `call` refuses any method that is not in
// READ_METHODS before it touches the network, so a typo or a future edit
// cannot post, react, join, open a DM or otherwise mutate the workspace.
// The token is only ever placed in the Authorization header and is scrubbed
// from every error message that leaves this module.

export const READ_METHODS: ReadonlySet<string> = new Set([
  'auth.test',
  'search.messages',
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'conversations.info',
  'conversations.members',
  'users.info',
  'users.list',
  'users.conversations',
  'chat.getPermalink',
]);

export const TOKEN_ENV = 'SLACK_USER_TOKEN';

export class KslackError extends Error {}

export class MissingTokenError extends KslackError {
  constructor() {
    super(
      `${TOKEN_ENV} is not set. kslack needs a Slack user token (xoxp-…) in the ${TOKEN_ENV} ` +
        'environment variable (sops secrets.yaml → env.SLACK_USER_TOKEN, then hms). ' +
        'See modules/kslack-ts/README.md for the Slack app setup.',
    );
  }
}

export class ForbiddenMethodError extends KslackError {
  constructor(method: string) {
    super(`refusing to call Slack method "${method}": kslack is read-only and it is not in the read allowlist`);
  }
}

export class SlackApiError extends KslackError {
  constructor(
    readonly method: string,
    readonly error: string,
    readonly needed?: string,
    readonly provided?: string,
  ) {
    let msg = `Slack ${method} failed: ${error}`;
    if (needed) msg += ` (needed scope: ${needed}`;
    if (needed && provided) msg += `; token has: ${provided}`;
    if (needed) msg += ')';
    if (error === 'missing_scope' && needed) {
      msg += ' — add the scope under User Token Scopes in the Slack app and reinstall it';
    }
    super(msg);
  }
}

export type Params = Record<string, string | number | boolean | undefined>;

export interface SlackResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: { next_cursor?: string };
  [k: string]: unknown;
}

export interface ClientOptions {
  token?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
}

/** Replace every occurrence of the token (and anything that looks like a Slack token) in s. */
export function redact(s: string, token?: string): string {
  let out = s;
  if (token) out = out.split(token).join('[redacted]');
  return out.replace(/xox[a-z]-[A-Za-z0-9-]+/g, '[redacted]');
}

export class SlackClient {
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(opts: ClientOptions = {}) {
    this.token = opts.token && opts.token.trim() !== '' ? opts.token.trim() : undefined;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseUrl = opts.baseUrl ?? 'https://slack.com/api';
  }

  static fromEnv(env: Record<string, string | undefined> = process.env, opts: Omit<ClientOptions, 'token'> = {}) {
    return new SlackClient({ ...opts, token: env[TOKEN_ENV] });
  }

  /** Wrap any error so the token can never escape in its message or stack. */
  scrub(e: unknown): Error {
    if (e instanceof KslackError) {
      e.message = redact(e.message, this.token);
      e.stack = undefined;
      return e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    return new KslackError(redact(msg, this.token));
  }

  async call<T extends SlackResponse = SlackResponse>(method: string, params: Params = {}): Promise<T> {
    if (!READ_METHODS.has(method)) throw new ForbiddenMethodError(method);
    if (!this.token) throw new MissingTokenError();
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/${method}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body,
        });
      } catch (e) {
        throw this.scrub(e);
      }

      if (res.status === 429) {
        if (attempt >= this.maxRetries)
          throw new SlackApiError(method, `ratelimited (gave up after ${attempt + 1} attempts)`);
        const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        await this.sleep((Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 1) * 1000);
        continue;
      }
      if (!res.ok) throw this.scrub(new SlackApiError(method, `HTTP ${res.status} ${res.statusText}`.trim()));

      let data: T;
      try {
        data = (await res.json()) as T;
      } catch (e) {
        throw this.scrub(new SlackApiError(method, `invalid JSON response: ${e instanceof Error ? e.message : e}`));
      }
      if (!data.ok) {
        throw this.scrub(new SlackApiError(method, data.error ?? 'unknown_error', data.needed, data.provided));
      }
      return data;
    }
  }

  /**
   * Cursor-paginate `method`, collecting `key` arrays until `max` items or the
   * last page. `pageSize` is sent as `limit`.
   */
  async paginate<I>(method: string, params: Params, key: string, max = Infinity, pageSize = 200): Promise<I[]> {
    const out: I[] = [];
    let cursor: string | undefined;
    do {
      const limit = Math.max(1, Math.min(pageSize, max - out.length));
      const res = await this.call(method, { ...params, limit, cursor });
      const items = (res[key] as I[] | undefined) ?? [];
      out.push(...items);
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor && out.length < max);
    return out.slice(0, max);
  }
}
