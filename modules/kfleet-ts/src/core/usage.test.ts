import { describe, expect, test } from 'bun:test';
import type { ResolvedAgent } from './types';
import { classifyAgent, jwtExpMs, oauthTokenUsable } from './usage';

/** Build an unsigned JWT with the given payload (header.payload.sig, base64url). */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const claude = (name: string, env?: Record<string, string>): ResolvedAgent => ({ name, kind: 'claude', env });
const codex = (name: string, env?: Record<string, string>): ResolvedAgent => ({ name, kind: 'codex', env });

describe('classifyAgent', () => {
  test('claude with no base url → anthropic OAuth, keychain-suffix credId', () => {
    const c = classifyAgent(claude('auto-opus48'), {});
    expect(c?.provider).toBe('anthropic');
    expect(c?.credId).toMatch(/^anthropic:[0-9a-f]{8}$/);
  });

  test('claude with explicit anthropic.com base url → anthropic', () => {
    const c = classifyAgent(claude('x', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), {});
    expect(c?.provider).toBe('anthropic');
  });

  test('claude pointed at z.ai → zai, credId derived from the resolved key', () => {
    const env = { ZAI_API_KEY_A: 'secret-key-a' };
    const agent = claude('auto-glm52a', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY_A',
    });
    const c = classifyAgent(agent, env);
    expect(c?.provider).toBe('zai');
    expect(c?.credId).toMatch(/^zai:[0-9a-f]{12}$/);
  });

  test('two z.ai wrappers sharing one key get the SAME credId (deduped)', () => {
    const env = { ZAI_API_KEY_A: 'secret-key-a' };
    const a = classifyAgent(
      claude('glm52a', {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY_A',
      }),
      env,
    );
    const b = classifyAgent(
      claude('auto-glm52a', {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY_A',
      }),
      env,
    );
    expect(a?.credId).toBe(b!.credId);
  });

  test('z.ai key missing from env → tracked failed probe (cannot silently select)', () => {
    const agent = claude('glm', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY_A',
    });
    const c = classifyAgent(agent, {});
    expect(c?.provider).toBe('zai');
    expect(c?.credId).toBe('zai:missing:ZAI_API_KEY_A');
    expect(c?.missingToken).toBe('ZAI_API_KEY_A');
  });

  test('claude pointed at minimax coding plan → minimax, credId from the key', () => {
    const env = { MINIMAX_API_KEY: 'sk-cp-secret' };
    const c = classifyAgent(
      claude('mm3', {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$MINIMAX_API_KEY',
      }),
      env,
    );
    expect(c?.provider).toBe('minimax');
    expect(c?.credId).toMatch(/^minimax:[0-9a-f]{12}$/);
  });

  test('minimax key missing from env → tracked failed probe (flagged, not silently selectable)', () => {
    const c = classifyAgent(
      claude('mm', {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_AUTH_TOKEN: '$MINIMAX_API_KEY',
      }),
      {},
    );
    expect(c?.provider).toBe('minimax');
    expect(c?.credId).toBe('minimax:missing:MINIMAX_API_KEY');
    expect(c?.missingToken).toBe('MINIMAX_API_KEY');
  });

  test('claude pointed at deepseek → still untracked (non-windowed API key)', () => {
    expect(classifyAgent(claude('ds', { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }), {})).toBeNull();
  });

  test('${VAR} brace form resolves to the same minimax cred as $VAR', () => {
    const env = { MINIMAX_API_KEY: 'sk-cp-x' };
    const a = classifyAgent(
      claude('a', {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_AUTH_TOKEN: '${MINIMAX_API_KEY}',
      }),
      env,
    );
    const b = classifyAgent(
      claude('b', { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_AUTH_TOKEN: '$MINIMAX_API_KEY' }),
      env,
    );
    expect(a?.credId).toBe(b!.credId);
  });

  test('codex with no auth.json on disk → untracked', () => {
    // A name that won't have a real ~/.codex-<name>/auth.json.
    expect(classifyAgent(codex('auto-this-account-does-not-exist-xyz'), {})).toBeNull();
  });

  test('${VAR} brace form is expanded too', () => {
    const env = { ZAI_API_KEY_B: 'kb' };
    const a = classifyAgent(
      claude('g', { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '${ZAI_API_KEY_B}' }),
      env,
    );
    const b = classifyAgent(
      claude('g2', { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '$ZAI_API_KEY_B' }),
      env,
    );
    expect(a?.provider).toBe('zai');
    expect(a?.credId).toBe(b!.credId); // same resolved key ⇒ same credId
  });
});

describe('oauthTokenUsable (auth_ok = currently-usable token)', () => {
  const now = 1_000_000;
  test('a valid, unexpired access token ⇒ usable', () => {
    expect(oauthTokenUsable({ accessToken: 'a', expiresAt: now + 1000 }, now)).toBe(true);
  });
  test('an EXPIRED access token ⇒ NOT usable (relogin already had its chance; refresh is dead)', () => {
    expect(oauthTokenUsable({ accessToken: 'a', expiresAt: now - 1000 }, now)).toBe(false);
  });
  test('no access token ⇒ not usable', () => {
    expect(oauthTokenUsable({}, now)).toBe(false);
  });
  test('a token with unknown expiry ⇒ usable (can not prove it expired)', () => {
    expect(oauthTokenUsable({ accessToken: 'a' }, now)).toBe(true);
  });
});

describe('jwtExpMs (codex token expiry decode)', () => {
  test('decodes the exp claim to epoch ms', () => {
    expect(jwtExpMs(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });
  test('undefined / malformed / no-exp ⇒ undefined', () => {
    expect(jwtExpMs(undefined)).toBeUndefined();
    expect(jwtExpMs('not-a-jwt')).toBeUndefined();
    expect(jwtExpMs(jwt({ sub: 'x' }))).toBeUndefined();
  });
});
