import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedAgent } from './types';
import { configSchema } from './types';
import {
  classifyAgent,
  classifyMinimaxBody,
  corroborateAuthFailure,
  jwtExpMs,
  oauthTokenUsable,
  parseAnthropicInferenceHeaders,
  parseAnthropicStoredUsage,
  probeAnthropicStoredUsage,
  probeUsage,
} from './usage';

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

  test('declared Claude secrets-file tokens are credential-keyed, never identity-keyed', () => {
    const agent = (name: string, ref: string): ResolvedAgent => ({
      name,
      kind: 'claude',
      identity: 'shared-name-must-not-win',
      credential: { source: 'secrets-file', key: ref },
      env: { CLAUDE_CODE_OAUTH_TOKEN: '$WRAPPER_TOKEN_MUST_NOT_BE_USED_FOR_USAGE' },
    });
    const usageEnv = {
      LOGE_1: 'oauth-token-a',
      LOGE_2: 'oauth-token-b',
      WRAPPER_TOKEN_MUST_NOT_BE_USED_FOR_USAGE: 'wrong-wrapper-token',
    };
    const a = classifyAgent(agent('loge1', 'LOGE_1'), usageEnv);
    const same = classifyAgent(agent('auto-loge1', 'LOGE_1'), usageEnv);
    const other = classifyAgent(agent('loge2', 'LOGE_2'), usageEnv);

    expect(a?.provider).toBe('anthropic');
    expect(a?.credId).toMatch(/^anthropic:secrets-file:[0-9a-f]{64}$/);
    expect(same?.credId).toBe(a?.credId); // same exact credential is safely deduped
    expect(other?.credId).not.toBe(a?.credId); // same identity can never cross-account fallback
    expect(JSON.stringify(a)).not.toContain('oauth-token-a');
  });

  test('a declared-but-missing Claude secrets-file token stays tracked as unusable', () => {
    const c = classifyAgent(
      {
        ...claude('loge1'),
        credential: {
          source: 'secrets-file',
          key: 'KFLEET_TEST_MISSING_CLAUDE_TOKEN',
        },
      },
      {},
    );
    expect(c).toEqual({
      provider: 'anthropic',
      credId: 'anthropic:secrets-file:missing:KFLEET_TEST_MISSING_CLAUDE_TOKEN',
      missingToken: 'KFLEET_TEST_MISSING_CLAUDE_TOKEN',
      missingTokenSource: 'secrets-file',
    });
  });

  test('CLAUDE_CODE_OAUTH_TOKEN alone is never inferred as the usage source', () => {
    const c = classifyAgent(claude('loge1', { CLAUDE_CODE_OAUTH_TOKEN: '$LOGE_CLAUDE_1_TOKEN' }), {
      LOGE_CLAUDE_1_TOKEN: 'must-not-be-used-without-a-declaration',
    });
    expect(c).toEqual({ provider: 'anthropic', credId: 'anthropic:id:loge1' });
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

describe('stored Anthropic OAuth JSON (0..100 percentage points)', () => {
  test('keeps stored OAuth utilization unscaled and range-checks it', () => {
    const parsed = parseAnthropicStoredUsage({
      five_hour: { utilization: 2, resets_at: '2026-07-30T20:00:00.000Z' },
      seven_day: { utilization: 74, resets_at: '2026-08-03T00:00:00.000Z' },
    });
    expect(parsed).toMatchObject({
      fiveHourPercent: 2,
      weeklyPercent: 74,
      fiveHourResetAt: Date.parse('2026-07-30T20:00:00.000Z'),
      weeklyResetAt: Date.parse('2026-08-03T00:00:00.000Z'),
    });

    const invalid = parseAnthropicStoredUsage({
      five_hour: { utilization: -1 },
      seven_day: { utilization: 101 },
    });
    expect(invalid.fiveHourPercent).toBeUndefined();
    expect(invalid.weeklyPercent).toBeUndefined();
  });
});

describe('probeUsage: direct Claude secrets-file inference quota headers (0..1 fractions)', () => {
  const config = (variants = false) =>
    configSchema.parse({
      variants: variants ? { default: {}, auto: {} } : undefined,
      agents: [
        {
          name: 'loge1',
          kind: 'claude',
          credential: { source: 'secrets-file', key: 'LOGE_CLAUDE_1_TOKEN' },
          env: { CLAUDE_CODE_OAUTH_TOKEN: '$WRONG_WRAPPER_TOKEN' },
        },
      ],
    });

  const probeDirect = async (opts: { variants?: boolean; atLimitPercent?: number } = {}) =>
    probeUsage(config(opts.variants), {
      env: {}, // equivalent to the service's stripped environment / `env -i`
      relogin: false,
      sync: false,
      atLimitPercent: opts.atLimitPercent,
      resolveExternalCredential: agent => ({
        key: agent.credential!.key,
        value: agent.credential!.key === 'LOGE_CLAUDE_1_TOKEN' ? 'exact-loge1-oauth-token' : undefined,
      }),
    });

  test('HTTP 200 scales fractional headers, parses epoch resets, and dedupes the exact token', async () => {
    const originalFetch = globalThis.fetch;
    const seenAuth: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get('authorization') ?? '');
      expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
      expect(init?.method).toBe('POST');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      });
      return new Response('', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.12',
          'anthropic-ratelimit-unified-5h-reset': '1785441600',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-utilization': '0.34',
          'anthropic-ratelimit-unified-7d-reset': '1785715200',
        },
      });
    }) as typeof fetch;

    try {
      const rows = await probeDirect({ variants: true });
      const direct = rows.filter(row => row.binary === 'claude-loge1' || row.binary === 'claude-auto-loge1');

      expect(seenAuth).toEqual(['Bearer exact-loge1-oauth-token']); // variants dedupe by exact token
      expect(direct).toHaveLength(2);
      for (const row of direct) {
        expect(row.ok).toBe(true);
        expect(row.authOk).toBe(true);
        expect(row.unavailable).not.toBe(true);
        expect(row.fiveHourPercent).toBe(12);
        expect(row.weeklyPercent).toBe(34);
        expect(row.fiveHourResetAt).toBe(1_785_441_600_000);
        expect(row.weeklyResetAt).toBe(1_785_715_200_000);
        expect(row.atLimit).toBe(false);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('HTTP 429 with valid headers is a successful probe and honors the 85% cutoff', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('', {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.42',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-utilization': '0.85',
        },
      })) as typeof fetch;

    try {
      const row = (await probeDirect({ atLimitPercent: 85 })).find(item => item.binary === 'claude-loge1')!;
      expect(row.ok).toBe(true);
      expect(row.error).toBeUndefined();
      expect(row.fiveHourPercent).toBe(42);
      expect(row.weeklyPercent).toBe(85);
      expect(row.atLimit).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejected status marks at-limit even when an over-1 utilization is discarded', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('', {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1.01',
          'anthropic-ratelimit-unified-5h-reset': '1785441600',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-utilization': '0.81',
        },
      })) as typeof fetch;

    try {
      const row = (await probeDirect()).find(item => item.binary === 'claude-loge1')!;
      expect(row.ok).toBe(true);
      expect(row.fiveHourPercent).toBeUndefined();
      expect(row.weeklyPercent).toBe(81);
      expect(row.atLimit).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('malformed and out-of-range headers remain unknown instead of poisoning quota decisions', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('', {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-5h-status': 'mystery',
          'anthropic-ratelimit-unified-5h-utilization': '-0.01',
          'anthropic-ratelimit-unified-5h-reset': 'not-an-epoch',
          'anthropic-ratelimit-unified-7d-utilization': '1.5',
          'anthropic-ratelimit-unified-7d-reset': '-1',
        },
      })) as typeof fetch;

    try {
      const row = (await probeDirect()).find(item => item.binary === 'claude-loge1')!;
      expect(row.ok).toBe(false);
      expect(row.error).toBe('http 429: missing or invalid Anthropic quota headers');
      expect(row.fiveHourPercent).toBeUndefined();
      expect(row.weeklyPercent).toBeUndefined();
      expect(row.atLimit).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a reset-only 429 is not a successful quota probe', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('', {
        status: 429,
        headers: { 'anthropic-ratelimit-unified-5h-reset': '1785441600' },
      })) as typeof fetch;

    try {
      const row = (await probeDirect()).find(item => item.binary === 'claude-loge1')!;
      expect(row.ok).toBe(false);
      expect(row.error).toBe('http 429: missing or invalid Anthropic quota headers');
      expect(row.fiveHourResetAt).toBeUndefined();
      expect(row.authOk).toBe(true);
      expect(row.atLimit).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('only Anthropic 401 condemns an external token; 403 remains inconclusive', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const probe = async (status: number) => {
        globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch;
        return (await probeDirect()).find(row => row.binary === 'claude-loge1')!;
      };

      const orgBlocked = await probe(403);
      expect(orgBlocked.ok).toBe(false);
      expect(orgBlocked.authOk).toBe(true);
      expect(orgBlocked.error).toBe('http 403');

      const invalid = await probe(401);
      expect(invalid.ok).toBe(false);
      expect(invalid.authOk).toBe(false);
      expect(invalid.error).toBe('http 401');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Observed live: three loge accounts returned 403 `permission_error` from
  // POST /v1/messages with ZERO quota headers, while healthy siblings returned
  // 429 WITH headers (a 429 is a successful quota probe). Because 403 left
  // `unavailable` unset, those accounts reported as "usage unavailable (creds
  // OK)" and stayed eligible for selection — so every teammate launched on one
  // died on arrival. Inconclusive AUTH must not mean usable.
  test('a 403 from the inference probe marks the account unavailable, not merely unmeasured', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const probe = async (status: number) => {
        globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch;
        return (await probeDirect()).find(row => row.binary === 'claude-loge1')!;
      };

      const forbidden = await probe(403);
      // authOk stays inconclusive: a 403 may be a transient org/spend block.
      expect(forbidden.authOk).toBe(true);
      // ...but it is definitively not usable right now.
      expect(forbidden.unavailable).toBe(true);
      // `atLimit: w.ok ? atLimit : w.unavailable === true` — so marking it
      // unavailable is what actually removes it from routing. That wiring
      // already existed; the 403 path simply never set the flag.
      expect(forbidden.atLimit).toBe(true);

      const invalid = await probe(401);
      expect(invalid.unavailable).toBe(true);
      expect(invalid.atLimit).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

// Live headers observed 2026-10-08. Accounts billing an org overage /
// usage-credit pool get no 5h/7d windows at all.
const OVERAGE_ALLOWED = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-reset': '1793491200',
  'anthropic-ratelimit-unified-representative-claim': 'overage',
  'anthropic-ratelimit-unified-overage-in-use': 'true',
  'anthropic-ratelimit-unified-overage-status': 'allowed',
  'anthropic-ratelimit-unified-overage-utilization': '0.0',
  'anthropic-ratelimit-unified-overage-reset': '1793491200',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
};
// loge4..6: HTTP 429, member credit limit set to zero by an org admin.
const OVERAGE_ADMIN_DISABLED = {
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'member_zero_credit_limit',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-reset': '1793491200',
  'anthropic-ratelimit-unified-status': 'rejected',
  'retry-after': '1995495',
};

describe('parseAnthropicInferenceHeaders: overage pool', () => {
  test('overage-only headers are a valid in-use quota window', () => {
    const parsed = parseAnthropicInferenceHeaders(new Headers(OVERAGE_ALLOWED));
    expect(parsed.hasValidQuotaHeader).toBe(true);
    expect(parsed.adminDisabledReason).toBeUndefined();
    expect(parsed.windows).toMatchObject({
      overagePercent: 0,
      overageResetAt: 1_793_491_200_000,
      overageInUse: true,
      providerAtLimit: false,
    });
    expect(parsed.windows.fiveHourPercent).toBeUndefined();
    expect(parsed.windows.weeklyPercent).toBeUndefined();
  });

  test('a disabled overage on a subscription account does not read as at-limit', () => {
    const parsed = parseAnthropicInferenceHeaders(
      new Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.3',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
      }),
    );
    expect(parsed.windows).toMatchObject({ fiveHourPercent: 20, weeklyPercent: 30, overageInUse: false });
    expect(parsed.windows.providerAtLimit).toBe(false);
    expect(parsed.adminDisabledReason).toBeUndefined();
  });

  test('an exhausted overage pool is at-limit, not admin-disabled', () => {
    const parsed = parseAnthropicInferenceHeaders(
      new Headers({
        ...OVERAGE_ADMIN_DISABLED,
        'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
        'anthropic-ratelimit-unified-overage-utilization': '1.0',
      }),
    );
    expect(parsed.hasValidQuotaHeader).toBe(true);
    expect(parsed.adminDisabledReason).toBeUndefined();
    expect(parsed.windows).toMatchObject({ overagePercent: 100, overageInUse: true, providerAtLimit: true });
  });

  test('an overall rejection alone is at-limit', () => {
    const parsed = parseAnthropicInferenceHeaders(new Headers({ 'anthropic-ratelimit-unified-status': 'rejected' }));
    expect(parsed.hasValidQuotaHeader).toBe(true);
    expect(parsed.windows.providerAtLimit).toBe(true);
  });

  test('an allowed status with only a reset proves nothing', () => {
    const parsed = parseAnthropicInferenceHeaders(
      new Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-reset': '1793491200',
      }),
    );
    expect(parsed.hasValidQuotaHeader).toBe(false);
  });
});

describe('probeUsage: overage and admin-disabled external Claude tokens', () => {
  const probe = async (status: number, headers: Record<string, string>, atLimitPercent?: number) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status, headers })) as typeof fetch;
    try {
      const rows = await probeUsage(
        configSchema.parse({
          agents: [
            { name: 'loge1', kind: 'claude', credential: { source: 'secrets-file', key: 'LOGE_CLAUDE_1_TOKEN' } },
          ],
        }),
        {
          env: {},
          relogin: false,
          sync: false,
          atLimitPercent,
          resolveExternalCredential: agent => ({ key: agent.credential!.key, value: 'loge1-token' }),
        },
      );
      return rows.find(row => row.binary === 'claude-loge1')!;
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  test('HTTP 200 overage headers give an ok account with real usage', async () => {
    const row = await probe(200, OVERAGE_ALLOWED);
    expect(row.ok).toBe(true);
    expect(row.error).toBeUndefined();
    expect(row.authOk).toBe(true);
    expect(row.overagePercent).toBe(0);
    expect(row.overageResetAt).toBe(1_793_491_200_000);
    expect(row.overageInUse).toBe(true);
    expect(row.atLimit).toBe(false);
  });

  test('an in-use overage at the cutoff is at-limit', async () => {
    const row = await probe(200, { ...OVERAGE_ALLOWED, 'anthropic-ratelimit-unified-overage-utilization': '0.9' }, 85);
    expect(row.ok).toBe(true);
    expect(row.overagePercent).toBe(90);
    expect(row.atLimit).toBe(true);
  });

  test('a rejected overage that is in use is at-limit', async () => {
    const row = await probe(429, {
      ...OVERAGE_ALLOWED,
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-utilization': '1.0',
    });
    expect(row.ok).toBe(true);
    expect(row.atLimit).toBe(true);
  });

  test('an admin-disabled 429 is logged in but unavailable, with the reason', async () => {
    const row = await probe(429, OVERAGE_ADMIN_DISABLED);
    expect(row.ok).toBe(false);
    expect(row.authOk).toBe(true);
    expect(row.unavailable).toBe(true);
    expect(row.atLimit).toBe(true);
    expect(row.error).toBe('disabled by admin (member_zero_credit_limit)');
  });
});

describe('probeAnthropicStoredUsage: shared cache and 429 backoff', () => {
  const body = JSON.stringify({
    five_hour: { utilization: 3, resets_at: '2026-10-09T02:20:01Z' },
    seven_day: { utilization: 40, resets_at: '2026-10-11T18:00:00Z' },
  });

  const withCache = async (
    fn: (cacheFile: string, calls: { n: number }, respond: (r: () => Response) => void) => Promise<void>,
  ) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kfleet-usage-cache-'));
    const originalFetch = globalThis.fetch;
    const calls = { n: 0 };
    let responder: () => Response = () => new Response(body, { status: 200 });
    globalThis.fetch = (async () => {
      calls.n++;
      return responder();
    }) as typeof fetch;
    try {
      await fn(path.join(dir, 'cache.json'), calls, r => {
        responder = r;
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('a fresh reading is reused across processes without a request', async () => {
    await withCache(async (cacheFile, calls) => {
      let now = 1_000_000;
      const opts = { credId: 'anthropic:id:kirin', timeoutMs: 1000, cacheFile, now: () => now };
      expect(await probeAnthropicStoredUsage('t', opts)).toMatchObject({ ok: true, weeklyPercent: 40 });
      now += 60_000;
      expect(await probeAnthropicStoredUsage('t', opts)).toMatchObject({ ok: true, weeklyPercent: 40 });
      expect(calls.n).toBe(1);
      now += 120_000; // past the fresh window: probe again
      await probeAnthropicStoredUsage('t', opts);
      expect(calls.n).toBe(2);
    });
  });

  test('a 429 serves the last good reading and backs off instead of re-probing', async () => {
    await withCache(async (cacheFile, calls, respond) => {
      let now = 1_000_000;
      const opts = { credId: 'anthropic:id:kirin', timeoutMs: 1000, cacheFile, now: () => now };
      await probeAnthropicStoredUsage('t', opts);
      now += 180_000;
      respond(() => new Response('{}', { status: 429, headers: { 'retry-after': '600' } }));
      expect(await probeAnthropicStoredUsage('t', opts)).toMatchObject({ ok: true, weeklyPercent: 40 });
      expect(calls.n).toBe(2);
      now += 300_000; // inside the 600s Retry-After: no request
      expect(await probeAnthropicStoredUsage('t', opts)).toMatchObject({ ok: true, weeklyPercent: 40 });
      expect(calls.n).toBe(2);
    });
  });

  test('a 429 with no recent reading is a labeled rate-limit, not an auth failure', async () => {
    await withCache(async (cacheFile, calls, respond) => {
      let now = 1_000_000;
      const opts = { credId: 'anthropic:id:liftoff', timeoutMs: 1000, cacheFile, now: () => now };
      respond(() => new Response('{}', { status: 429 }));
      const first = await probeAnthropicStoredUsage('t', opts);
      expect(first).toMatchObject({ ok: false, authOk: true, error: 'http 429 (usage endpoint rate-limited)' });
      now += 30_000;
      const second = await probeAnthropicStoredUsage('t', opts);
      expect(second.ok).toBe(false);
      expect(second.error).toContain('rate-limited; retry in');
      expect(calls.n).toBe(1);
    });
  });

  test('cacheFile:false always probes', async () => {
    await withCache(async (_cacheFile, calls) => {
      const opts = { credId: 'anthropic:id:kirin', timeoutMs: 1000, cacheFile: false as const };
      await probeAnthropicStoredUsage('t', opts);
      await probeAnthropicStoredUsage('t', opts);
      expect(calls.n).toBe(2);
    });
  });
});
