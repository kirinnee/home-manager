import { describe, expect, test } from 'bun:test';
import { OAuthError, READ_SCOPES, authorizeUrl, discover, parseTokenResponse, pkcePair } from './oauth';
import { createHash } from 'node:crypto';
import { fakeFetch, jsonRes } from './testutil';

describe('oauth', () => {
  test('discovers endpoints from protected-resource + authorization-server metadata', async () => {
    const f = fakeFetch(url => {
      if (url === 'https://mcp.slack.com/.well-known/oauth-protected-resource')
        return jsonRes({ resource: 'https://mcp.slack.com', authorization_servers: ['https://mcp.slack.com'] });
      if (url === 'https://mcp.slack.com/.well-known/oauth-authorization-server')
        return jsonRes({
          authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
          token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
          scopes_supported: ['chat:write', 'channels:read'],
        });
      return jsonRes({}, 404);
    });
    const as = await discover('https://mcp.slack.com/mcp', f);
    expect(as).toEqual({
      authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
      token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
      resource: 'https://mcp.slack.com',
      scopes_supported: ['chat:write', 'channels:read'],
    });
  });

  test('PKCE S256 + authorize URL', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(
      authorizeUrl(
        {
          authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
          token_endpoint: 'x',
          resource: 'https://mcp.slack.com',
          scopes_supported: [],
        },
        { clientId: 'cid', redirectUri: 'http://localhost:3118/callback', scopes: READ_SCOPES, state: 's', challenge },
      ),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3118/callback');
    expect(url.searchParams.get('resource')).toBe('https://mcp.slack.com');
    expect(
      url.searchParams
        .get('scope')!
        .split(' ')
        .some(s => s.includes('write')),
    ).toBe(false);
  });

  test('parses flat and authed_user-nested Slack token replies', () => {
    const now = 1_000_000;
    expect(
      parseTokenResponse(
        200,
        {
          ok: true,
          access_token: 'xoxe.xoxp-a',
          refresh_token: 'xoxe-r',
          expires_in: 60,
          team: { id: 'T1', name: 'Acme' },
        },
        now,
      ),
    ).toMatchObject({
      access_token: 'xoxe.xoxp-a',
      refresh_token: 'xoxe-r',
      expires_at: now + 60_000,
      team_name: 'Acme',
    });
    expect(
      parseTokenResponse(
        200,
        { ok: true, authed_user: { id: 'U9', access_token: 'xoxe.xoxp-b', refresh_token: 'xoxe-s', expires_in: 10 } },
        now,
      ),
    ).toMatchObject({
      access_token: 'xoxe.xoxp-b',
      user_id: 'U9',
    });
  });

  test('ok:false and 4xx errors become OAuthError with needsLogin, without echoing tokens', () => {
    try {
      parseTokenResponse(200, { ok: false, error: 'invalid_refresh_token', refresh_token: 'xoxe-1-SECRET' }, 0);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthError);
      expect((e as OAuthError).needsLogin).toBe(true);
      expect((e as Error).message).not.toContain('SECRET');
    }
    expect(() => parseTokenResponse(400, { error: 'invalid_grant' }, 0)).toThrow('invalid_grant');
  });
});
