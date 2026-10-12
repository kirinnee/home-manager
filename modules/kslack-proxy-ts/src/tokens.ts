// TokenManager: the single owner of the rotating Slack refresh token.
//
// Slack rotates BOTH tokens on every refresh and the old refresh token is
// single-use, so two refreshes racing would burn the session. Every caller
// therefore funnels through one in-flight refresh promise, and the new set is
// persisted (atomically) BEFORE anyone is handed the new access token.
import { type FetchLike, OAuthError, refreshTokens } from './oauth';
import { REFRESH_MARGIN_MS } from './paths';
import { type Logger, errorMessage, registerSecret } from './redact';
import type { TokenSet, TokenStore } from './store';

export const LOGIN_HINT = 'run `kslack-proxy login` on this machine (see `kslack-proxy status`)';

export class NotLoggedInError extends Error {
  constructor(reason = 'kslack-proxy is not logged in to Slack') {
    super(`${reason} — ${LOGIN_HINT}`);
    this.name = 'NotLoggedInError';
  }
}

export interface TokenManagerOptions {
  store: TokenStore;
  fetch?: FetchLike;
  now?: () => number;
  marginMs?: number;
  log?: Logger;
}

export class TokenManager {
  private cache: TokenSet | null = null;
  private cacheMtime: number | null = null;
  private inflight: Promise<TokenSet> | null = null;
  /** set when a refresh came back with a dead refresh token; cleared by a new login */
  private dead: string | null = null;
  readonly store: TokenStore;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly marginMs: number;
  private readonly log: Logger;
  refreshCount = 0;

  constructor(o: TokenManagerOptions) {
    this.store = o.store;
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.marginMs = o.marginMs ?? REFRESH_MARGIN_MS;
    this.log = o.log ?? (() => {});
  }

  /** Current token set, re-read when the file changed (e.g. a fresh `login`). */
  current(): TokenSet | null {
    const m = this.store.mtime();
    if (m === null) {
      this.cache = null;
      this.cacheMtime = null;
      return null;
    }
    if (this.cache === null || m !== this.cacheMtime) {
      this.cache = this.store.read();
      this.cacheMtime = m;
      registerSecret(this.cache?.access_token);
      registerSecret(this.cache?.refresh_token);
      if (this.cache && this.dead && this.cache.access_token !== this.dead) this.dead = null;
    }
    return this.cache;
  }

  needsRefresh(t: TokenSet): boolean {
    return t.expires_at !== undefined && t.expires_at - this.now() < this.marginMs;
  }

  /** A usable access token, refreshing first when it is close to expiry. */
  async accessToken(): Promise<string> {
    const t = this.current();
    if (!t) throw new NotLoggedInError();
    if (this.dead === t.access_token) throw new NotLoggedInError('the Slack session expired or was revoked');
    if (this.needsRefresh(t)) return (await this.refresh(t.access_token)).access_token;
    return t.access_token;
  }

  /**
   * Refresh because `stale` is (about to be) invalid. Concurrent callers share
   * one in-flight refresh; a caller whose stale token was already replaced gets
   * the replacement without spending the refresh token again.
   */
  refresh(stale: string): Promise<TokenSet> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh(stale).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(stale: string): Promise<TokenSet> {
    const t = this.current();
    if (!t) throw new NotLoggedInError();
    if (t.access_token !== stale && !this.needsRefresh(t)) return t;
    if (!t.refresh_token) {
      this.dead = t.access_token;
      throw new NotLoggedInError('the stored Slack token cannot be refreshed');
    }
    let next: Awaited<ReturnType<typeof refreshTokens>>;
    try {
      this.refreshCount++;
      next = await refreshTokens(this.fetchFn, t, this.now);
    } catch (e) {
      if (e instanceof OAuthError && e.needsLogin) {
        this.dead = t.access_token;
        this.log(`refresh failed permanently (${e.code}); waiting for a new login`);
        throw new NotLoggedInError('the Slack session expired or was revoked');
      }
      this.log(`refresh failed: ${errorMessage(e)}`);
      throw e;
    }
    const merged: TokenSet = {
      ...t,
      ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)),
      // keep the old refresh token only when Slack did not rotate it
      refresh_token: next.refresh_token ?? t.refresh_token,
      last_refresh_at: this.now(),
    } as TokenSet;
    // Persist BEFORE use: if we crash after this, the new refresh token survives.
    this.store.write(merged);
    this.cache = merged;
    this.cacheMtime = this.store.mtime();
    this.log(
      `refreshed Slack token; expires ${merged.expires_at ? new Date(merged.expires_at).toISOString() : 'unknown'}`,
    );
    return merged;
  }
}
