import { describe, expect, test } from 'bun:test';
import type { ResolvedAgent } from './types';
import { classifyAgent, classifyMinimaxBody, corroborateAuthFailure, jwtExpMs, oauthTokenUsable } from './usage';

/** Build an unsigned JWT with the given payload (header.payload.sig, base64url). */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const claude = (name: string, env?: Record<string, string>): ResolvedAgent => ({ name, kind: 'claude', env });
const codex = (name: string, env?: Record<string, string>): ResolvedAgent => ({ name, kind: 'codex', env });

describe('classifyAgent', () => {
  test('claude with no base url → anthropic OAuth, identity-keyed credId', () => {
    const c = classifyAgent(claude('auto-opus48'), {});
    expect(c?.provider).toBe('anthropic');
    expect(c?.credId).toBe('anthropic:id:auto-opus48'); // no base/identity ⇒ own name
  });

  test('anthropic: variants and identity-linked agents share ONE credId (one quota probe per account)', () => {
    const a = classifyAgent({ name: 'kirin', kind: 'claude', base: 'kirin', variant: 'default' }, {});
    const b = classifyAgent({ name: 'auto-kirin', kind: 'claude', base: 'kirin', variant: 'auto' }, {});
    const c = classifyAgent({ name: 'f5-kirin', kind: 'claude', base: 'f5-kirin', identity: 'kirin' }, {});
    expect(a?.credId).toBe('anthropic:id:kirin');
    expect(b?.credId).toBe(a!.credId);
    expect(c?.credId).toBe(a!.credId);
    // a different account stays separate
    expect(classifyAgent({ name: 'liftoff', kind: 'claude', base: 'liftoff' }, {})?.credId).toBe(
      'anthropic:id:liftoff',
    );
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

describe('classifyMinimaxBody (single-response auth verdict)', () => {
  test('status_code:0 ⇒ ok, authOk true, windows computed from REMAINING %', () => {
    const w = classifyMinimaxBody({
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 80, current_weekly_remaining_percent: 40 },
      ],
    });
    expect(w.ok).toBe(true);
    expect(w.authOk).toBe(true);
    expect(w.fiveHourPercent).toBe(20); // 100 − 80 remaining
    expect(w.weeklyPercent).toBe(60); // 100 − 40 remaining
  });

  test('status_code:1004 ("login fail") ⇒ authOk false', () => {
    const w = classifyMinimaxBody({ base_resp: { status_code: 1004, status_msg: 'login fail' } });
    expect(w.ok).toBe(false);
    expect(w.authOk).toBe(false);
  });

  test('status_code:2049 ⇒ authOk false', () => {
    expect(classifyMinimaxBody({ base_resp: { status_code: 2049 } }).authOk).toBe(false);
  });

  test('any OTHER nonzero code ⇒ authOk undefined (inconclusive, not condemned)', () => {
    const w = classifyMinimaxBody({ base_resp: { status_code: 1039, status_msg: 'rate limited' } });
    expect(w.ok).toBe(false);
    expect(w.authOk).toBeUndefined();
  });
});

describe('corroborateAuthFailure (one blip must not condemn a key)', () => {
  const noSleep = async (): Promise<void> => {};
  // A fake attempt sequence: each call returns the next scripted verdict.
  const scripted = (seq: Array<boolean | undefined>): (() => Promise<{ ok: boolean; authOk?: boolean }>) => {
    let i = 0;
    return async () => {
      const authOk = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return { ok: authOk === true, authOk };
    };
  };

  test('a SINGLE transient 1004 then a healthy probe ⇒ authOk NOT false', async () => {
    const attempt = scripted([false, true]);
    const w = await corroborateAuthFailure(attempt, { attempts: 3, sleepMs: noSleep });
    expect(w.authOk).toBe(true);
  });

  test('repeated 1004s (rejected on every probe) ⇒ authOk stays false', async () => {
    const attempt = scripted([false, false, false]);
    const w = await corroborateAuthFailure(attempt, { attempts: 3, sleepMs: noSleep });
    expect(w.authOk).toBe(false);
  });

  test('a genuinely bad key (always false) is still condemned', async () => {
    let calls = 0;
    const attempt = async (): Promise<{ ok: boolean; authOk?: boolean }> => {
      calls += 1;
      return { ok: false, authOk: false };
    };
    const w = await corroborateAuthFailure(attempt, { attempts: 3, sleepMs: noSleep });
    expect(w.authOk).toBe(false);
    expect(calls).toBe(3); // exhausts all corroborating probes before condemning
  });

  test('a transport error (authOk undefined) is inconclusive — returned WITHOUT retry', async () => {
    let calls = 0;
    const attempt = async (): Promise<{ ok: boolean; authOk?: boolean }> => {
      calls += 1;
      return { ok: false, authOk: undefined };
    };
    const w = await corroborateAuthFailure(attempt, { attempts: 3, sleepMs: noSleep });
    expect(w.authOk).toBeUndefined();
    expect(calls).toBe(1); // never re-probed: undefined is not a hard rejection
  });

  test('a healthy first probe short-circuits (no extra probes)', async () => {
    let calls = 0;
    const attempt = async (): Promise<{ ok: boolean; authOk?: boolean }> => {
      calls += 1;
      return { ok: true, authOk: true };
    };
    const w = await corroborateAuthFailure(attempt, { attempts: 3, sleepMs: noSleep });
    expect(w.authOk).toBe(true);
    expect(calls).toBe(1);
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
