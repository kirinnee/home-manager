import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCLIProxyUsage } from './cliproxy-usage';
import type { CLIProxyUsageSource, ResolvedAgent } from './types';

const CLAUDE_CONFIG_MODEL = 'claude-fable-5[1m]';
const CLAUDE_SERVED_MODEL = 'claude-fable-5';
const CODEX_MODEL = 'gpt-5.6-sol';
const EARLY = '2030-01-01T00:00:00.000Z';
const LATE = '2030-01-01T01:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

const source: CLIProxyUsageSource = {
  url: 'http://127.0.0.1:8317',
  managementKey: 'test-management-key',
  baseAgents: ['claude-loge', 'codex-loge'],
};

const agents: ResolvedAgent[] = [
  { name: 'loge', base: 'loge', variant: 'default', kind: 'claude', env: { KTEAM_MODEL: CLAUDE_CONFIG_MODEL } },
  { name: 'auto-loge', base: 'loge', variant: 'auto', kind: 'claude', env: { KTEAM_MODEL: CLAUDE_CONFIG_MODEL } },
  { name: 'loge', base: 'loge', variant: 'default', kind: 'codex', env: { KTEAM_MODEL: CODEX_MODEL } },
];

const response = (files: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ files }))) as typeof fetch;

async function probe(files: unknown, selectedAgents = agents) {
  return await probeCLIProxyUsage([source], selectedAgents, { fetcher: response(files) });
}

const auth = (provider: 'claude' | 'codex', patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider,
  status: 'active',
  disabled: false,
  unavailable: false,
  status_message: '',
  ...patch,
});

const state = (
  patch: {
    status?: string;
    unavailable?: boolean;
    nextRetryAt?: string;
    quotaExceeded?: boolean;
    nextRecoverAt?: string;
    code?: string;
    httpStatus?: number;
  } = {},
): Record<string, unknown> => ({
  status: patch.status ?? 'error',
  unavailable: patch.unavailable ?? true,
  ...(patch.nextRetryAt !== undefined ? { next_retry_after: patch.nextRetryAt } : {}),
  quota: {
    exceeded: patch.quotaExceeded ?? false,
    ...(patch.nextRecoverAt !== undefined ? { next_recover_at: patch.nextRecoverAt } : {}),
  },
  ...(patch.code !== undefined || patch.httpStatus !== undefined
    ? {
        last_error: {
          ...(patch.code !== undefined ? { code: patch.code } : {}),
          ...(patch.httpStatus !== undefined ? { http_status: patch.httpStatus } : {}),
        },
      }
    : {}),
});

const withModel = (model: string, modelState: Record<string, unknown>): Record<string, unknown> => ({
  model_states: { [model]: modelState },
});

describe('CLIProxyAPI availability probe', () => {
  test('aggregate availability is never used as model evidence', async () => {
    const result = await probe([
      auth('claude', { unavailable: true, status: 'error', status_message: 'quota exhausted' }),
      auth('claude', { unavailable: false }),
      auth('codex', { unavailable: true, status: 'error' }),
    ]);

    expect(result.size).toBe(0);
  });

  test('all credentials cooling for the exact primary model fan out with the earliest recovery', async () => {
    const result = await probe([
      auth('claude', {
        unavailable: true,
        ...withModel(
          CLAUDE_SERVED_MODEL,
          state({ nextRetryAt: LATE, quotaExceeded: true, code: 'rate_limited', httpStatus: 429 }),
        ),
      }),
      auth('claude', {
        unavailable: true,
        ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: EARLY, quotaExceeded: true, httpStatus: 429 })),
      }),
      auth('codex'),
    ]);

    for (const binary of ['claude-loge', 'claude-auto-loge']) {
      expect(result.get(binary)).toMatchObject({
        availability: 'unavailable',
        unavailable: true,
        unavailableReason: 'cooldown',
        authOk: true,
        atLimit: true,
        retryAt: Date.parse(EARLY),
      });
      expect(result.get(binary)).not.toHaveProperty('fiveHourPercent');
      expect(result.get(binary)).not.toHaveProperty('weeklyPercent');
    }
    expect(result.has('codex-loge')).toBe(false);
  });

  test('one credential with no state for the primary model keeps the verdict unknown', async () => {
    const result = await probe([
      auth('claude', {
        ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: EARLY, quotaExceeded: true, httpStatus: 429 })),
      }),
      auth('claude'),
      auth('codex'),
    ]);

    expect(result.has('claude-loge')).toBe(false);
    expect(result.has('claude-auto-loge')).toBe(false);
  });

  test('maps Claude [1m] to the served model and falls back across a parenthesized thinking suffix', async () => {
    const thinkingAgent: ResolvedAgent = {
      name: 'loge',
      base: 'loge',
      variant: 'default',
      kind: 'claude',
      env: { KTEAM_MODEL: `${CLAUDE_CONFIG_MODEL}(high)` },
    };
    const matched = await probe(
      [auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: EARLY, quotaExceeded: true })) })],
      [thinkingAgent],
    );
    expect(matched.get('claude-loge')).toMatchObject({ unavailable: true, unavailableReason: 'cooldown' });

    const wrapperOnlyKey = await probe(
      [auth('claude', { ...withModel(CLAUDE_CONFIG_MODEL, state({ nextRetryAt: EARLY, quotaExceeded: true })) })],
      [agents[0]!],
    );
    expect(wrapperOnlyKey.size).toBe(0);
  });

  test('unavailable states without a live retry deadline remain selectable', async () => {
    for (const modelState of [state(), state({ nextRetryAt: PAST, quotaExceeded: true })]) {
      const result = await probe([auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, modelState) })], [agents[0]!]);
      expect(result.size).toBe(0);
    }
  });

  test('a live quota recovery deadline replaces the state retry deadline', async () => {
    const result = await probe(
      [
        auth('claude', {
          ...withModel(
            CLAUDE_SERVED_MODEL,
            state({ nextRetryAt: EARLY, quotaExceeded: true, nextRecoverAt: LATE, httpStatus: 429 }),
          ),
        }),
      ],
      [agents[0]!],
    );

    expect(result.get('claude-loge')).toMatchObject({ unavailableReason: 'cooldown', retryAt: Date.parse(LATE) });
  });

  test('uses only unanimous structured causes for auth, spend, and cooldown labels', async () => {
    const rejected = await probe(
      [
        auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: EARLY, code: 'invalid_grant' })) }),
        auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: LATE, httpStatus: 401 })) }),
      ],
      [agents[0]!],
    );
    expect(rejected.get('claude-loge')).toMatchObject({ unavailableReason: 'auth', authOk: false, atLimit: false });

    const spend = await probe(
      [
        auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: EARLY, code: 'payment_required' })) }),
        auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: LATE, httpStatus: 402 })) }),
      ],
      [agents[0]!],
    );
    expect(spend.get('claude-loge')).toMatchObject({ unavailableReason: 'spend_limit', authOk: true, atLimit: true });

    const mixed = await probe(
      [
        auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: EARLY, httpStatus: 401 })) }),
        auth('claude', {
          ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: LATE, quotaExceeded: true, httpStatus: 429 })),
        }),
      ],
      [agents[0]!],
    );
    expect(mixed.get('claude-loge')).toMatchObject({ unavailableReason: 'provider', authOk: true, atLimit: false });
  });

  test('all model-disabled states are unavailable without a fabricated retry time', async () => {
    const disabledState = state({ status: 'disabled', unavailable: false });
    const result = await probe(
      [
        auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, disabledState) }),
        auth('claude', { ...withModel(CLAUDE_SERVED_MODEL, disabledState) }),
      ],
      [agents[0]!],
    );

    expect(result.get('claude-loge')).toMatchObject({
      unavailableReason: 'provider',
      unavailable: true,
      atLimit: false,
    });
    expect(result.get('claude-loge')).not.toHaveProperty('retryAt');
  });

  test('missing primary model, vanilla responses, and malformed model states stay unknown', async () => {
    const noModelAgent: ResolvedAgent = { name: 'loge', base: 'loge', variant: 'default', kind: 'claude' };
    const withEvidence = [
      auth('claude', {
        ...withModel(CLAUDE_SERVED_MODEL, state({ nextRetryAt: EARLY, quotaExceeded: true, httpStatus: 429 })),
      }),
    ];
    expect((await probe(withEvidence, [noModelAgent])).size).toBe(0);
    expect((await probe([auth('claude', { unavailable: true, status: 'error' })], [agents[0]!])).size).toBe(0);
    expect(
      (
        await probe(
          [
            auth('claude', {
              model_states: { [CLAUDE_SERVED_MODEL]: { status: 'error', unavailable: true, quota: 'bad' } },
            }),
          ],
          [agents[0]!],
        )
      ).size,
    ).toBe(0);
  });

  test('missing or disabled matching credentials is a confirmed no-credentials auth failure', async () => {
    const result = await probe([auth('claude', { disabled: true })]);
    expect(result.get('claude-loge')).toMatchObject({
      unavailableReason: 'no_credentials',
      authOk: false,
      atLimit: false,
    });
    expect(result.get('codex-loge')).toMatchObject({
      unavailableReason: 'no_credentials',
      authOk: false,
      atLimit: false,
    });
  });

  test('malformed, unreachable, and unauthorized management responses leave no override', async () => {
    expect((await probe([{ provider: 42 }])).size).toBe(0);
    const unavailable = await probeCLIProxyUsage([source], agents, {
      fetcher: (async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
    });
    expect(unavailable.size).toBe(0);
    const unauthorized = await probeCLIProxyUsage([source], agents, {
      fetcher: (async () => new Response('no', { status: 401 })) as typeof fetch,
    });
    expect(unauthorized.size).toBe(0);
  });

  test('reads the management credential from a configured file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-cliproxy-key-'));
    const file = join(dir, 'management-key');
    writeFileSync(file, 'file-secret\n', { mode: 0o600 });
    try {
      let authorization = '';
      const result = await probeCLIProxyUsage(
        [{ url: source.url, managementKeyFile: file, baseAgents: ['claude-loge'] }],
        [agents[0]!],
        {
          fetcher: (async (_input, init) => {
            authorization = new Headers(init?.headers).get('authorization') ?? '';
            return new Response(
              JSON.stringify({
                files: [
                  auth('claude', {
                    ...withModel(
                      CLAUDE_SERVED_MODEL,
                      state({ nextRetryAt: EARLY, quotaExceeded: true, code: 'rate_limited', httpStatus: 429 }),
                    ),
                  }),
                ],
              }),
            );
          }) as typeof fetch,
        },
      );

      expect(authorization).toBe('Bearer file-secret');
      expect(result.get('claude-loge')).toMatchObject({ availability: 'unavailable', unavailableReason: 'cooldown' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
