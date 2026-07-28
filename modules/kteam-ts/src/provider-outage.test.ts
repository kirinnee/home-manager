import { describe, expect, test } from 'bun:test';
import { fingerprintAnomalies } from './warden-detect';
import {
  detectProviderOutages,
  providerFailureFromSnapshot,
  reduceProviderOutages,
  type ProviderFailureObservation,
  type ProviderSnapshotView,
} from './provider-outage';

const NOW = Date.parse('2026-07-28T04:00:00.000Z');

function view(snapshot: string, patch: Partial<ProviderSnapshotView> = {}): ProviderSnapshotView {
  return {
    config: {
      id: 'session-a',
      binary: 'claude-auto-loge',
      harness: 'claude',
      mode: 'auto',
      teammate: 'daphne',
      ...patch.config,
    },
    state: { status: 'running', ...patch.state },
    snapshot,
  };
}

function observation(
  sessionId: string,
  provider = 'claude',
  failureClass: ProviderFailureObservation['failureClass'] = 'cooling_down',
  binary = 'claude-auto-loge',
): ProviderFailureObservation {
  return {
    sessionId,
    teammate: sessionId,
    status: 'running',
    binary,
    provider,
    failureClass,
    ...(failureClass === 'cooling_down' ? { model: 'claude-fable-5' } : {}),
    evidence: '429 cooling down',
  };
}

describe('provider failure snapshot classifier', () => {
  test('extracts the exact CLIProxy API error and canonicalizes provider', () => {
    const result = providerFailureFromSnapshot(
      view(
        '● API Error: Request rejected (429) · All credentials for model claude-fable-5 are cooling down via provider CLAUDE\n',
      ),
    );
    expect(result).toMatchObject({
      provider: 'claude',
      failureClass: 'cooling_down',
      model: 'claude-fable-5',
      sessionId: 'session-a',
    });
  });

  test('accepts the live retry footer and strips terminal controls from evidence', () => {
    const result = providerFailureFromSnapshot(
      view(
        '\u001b[31m✻ 429 All credentials for model claude-fable-5 are cooling down via provider claude · Retrying in 0s · attempt 8/10\u001b[0m\n',
      ),
    );
    expect(result?.provider).toBe('claude');
    expect(result?.evidence).not.toContain('\u001b');
  });

  test('maps a harness-rendered monthly spend limit without guessing from wrapper names', () => {
    const result = providerFailureFromSnapshot(
      view(
        "  ⎿  You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit\n",
      ),
    );
    expect(result).toMatchObject({ provider: 'claude', failureClass: 'monthly_spend_limit' });
  });

  test('rejects bare 429/API-error prose and old errors outside the visual tail', () => {
    expect(providerFailureFromSnapshot(view('● API Error: Request rejected (429)\n'))).toBeUndefined();
    expect(
      providerFailureFromSnapshot(
        view(
          [
            '● API Error: Request rejected (429) · All credentials for model old are cooling down via provider claude',
            ...Array.from({ length: 25 }, (_, index) => `new healthy output ${index}`),
          ].join('\n'),
        ),
      ),
    ).toBeUndefined();
  });

  test('rejects interactive, waiting, terminal, warden, and ordinary discussion panes', () => {
    expect(
      providerFailureFromSnapshot(
        view('● API Error: Request rejected (429) · All credentials for model x are cooling down via provider claude', {
          config: { mode: 'interactive' } as ProviderSnapshotView['config'],
        }),
      ),
    ).toBeUndefined();
    expect(
      providerFailureFromSnapshot(
        view('● API Error: Request rejected (429) · All credentials for model x are cooling down via provider claude', {
          state: { status: 'completed' },
        }),
      ),
    ).toBeUndefined();
    expect(
      providerFailureFromSnapshot(
        view('✻ 429 All credentials for model x are cooling down via provider claude', {
          state: { status: 'awaiting_user' },
        }),
      ),
    ).toBeUndefined();
    expect(
      providerFailureFromSnapshot(
        view('✻ 429 All credentials for model x are cooling down via provider claude', {
          config: { label: 'kteam-warden' } as ProviderSnapshotView['config'],
        }),
      ),
    ).toBeUndefined();
    expect(providerFailureFromSnapshot(view("The task says 'monthly spend limit' in prose."))).toBeUndefined();
  });
});

describe('provider outage persistence and aggregation', () => {
  test('requires two distinct sessions in two real-time-separated sweeps', () => {
    expect(reduceProviderOutages({}, [observation('a')], NOW).state.signatures).toEqual({});
    const corroborated = [observation('a'), observation('b')];
    const first = reduceProviderOutages({}, corroborated, NOW);
    expect(first.anomalies).toEqual([]);
    expect(first.state.signatures?.['provider:claude|cooling_down']?.consecutiveSweeps).toBe(1);

    const tooSoon = reduceProviderOutages(first.state, corroborated, NOW + 59_999);
    expect(tooSoon.anomalies).toEqual([]);
    expect(tooSoon.state.signatures?.['provider:claude|cooling_down']?.consecutiveSweeps).toBe(1);

    const confirmed = reduceProviderOutages(tooSoon.state, corroborated, NOW + 60_000);
    expect(confirmed.anomalies).toHaveLength(1);
    expect(confirmed.anomalies[0]).toMatchObject({
      kind: 'provider_unavailable',
      provider: 'claude',
      fleetKey: 'provider:claude',
      affectedSessionIds: ['a', 'b'],
      generation: 1,
    });
  });

  test('many failing sessions become one provider-keyed anomaly', () => {
    const observations = [observation('c'), observation('a'), observation('b')];
    const first = reduceProviderOutages({}, observations, NOW);
    const second = reduceProviderOutages(first.state, observations, NOW + 60_000);
    expect(second.anomalies).toHaveLength(1);
    expect(second.anomalies[0]?.affectedSessionIds).toEqual(['a', 'b', 'c']);
  });

  test('different providers remain separate and a clean sweep resets persistence', () => {
    const observations = [observation('a'), observation('b'), observation('o', 'openai'), observation('p', 'openai')];
    const first = reduceProviderOutages({}, observations, NOW);
    const second = reduceProviderOutages(first.state, observations, NOW + 60_000);
    expect(second.anomalies.map(item => item.provider)).toEqual(['claude', 'openai']);

    const clean = reduceProviderOutages(second.state, [], NOW + 120_000);
    expect(clean.state.signatures).toEqual({});
    expect(clean.state.activeProviders).toEqual([]);
    const recurrence = reduceProviderOutages(clean.state, [observation('a'), observation('b')], NOW + 180_000);
    expect(recurrence.anomalies).toEqual([]);
    expect(recurrence.state.signatures?.['provider:claude|cooling_down']?.consecutiveSweeps).toBe(1);
  });

  test('only a matching class and monthly-limit wrapper can advance a streak', () => {
    const first = reduceProviderOutages({}, [observation('a'), observation('b')], NOW);
    const changedClass = reduceProviderOutages(
      first.state,
      [observation('a', 'claude', 'monthly_spend_limit'), observation('b', 'claude', 'monthly_spend_limit')],
      NOW + 60_000,
    );
    expect(changedClass.anomalies).toEqual([]);

    const splitWrappers = reduceProviderOutages(
      {},
      [
        observation('a', 'claude', 'monthly_spend_limit', 'claude-auto-loge'),
        observation('b', 'claude', 'monthly_spend_limit', 'claude-auto-atomi'),
      ],
      NOW,
    );
    expect(splitWrappers.state.signatures).toEqual({});
  });

  test('a clean recovery increments the provider-wide recurrence generation', () => {
    const observations = [observation('a'), observation('b')];
    const first = reduceProviderOutages({}, observations, NOW);
    const confirmed = reduceProviderOutages(first.state, observations, NOW + 60_000);
    const clean = reduceProviderOutages(confirmed.state, [], NOW + 120_000);
    const recurring = reduceProviderOutages(clean.state, observations, NOW + 180_000);
    const reconfirmed = reduceProviderOutages(recurring.state, observations, NOW + 240_000);
    expect(reconfirmed.anomalies[0]?.generation).toBe(2);
  });

  test('fingerprint stays provider-keyed when the representative session changes', () => {
    const first = reduceProviderOutages({}, [observation('y'), observation('z')], NOW);
    const z = reduceProviderOutages(first.state, [observation('y'), observation('z')], NOW + 60_000).anomalies;
    const a = reduceProviderOutages(first.state, [observation('a'), observation('b')], NOW + 60_000).anomalies;
    expect(fingerprintAnomalies(z)).toBe('provider_unavailable:provider:claude');
    expect(fingerprintAnomalies(a)).toBe(fingerprintAnomalies(z));
  });

  test('end-to-end helper excludes warden lineage and anchors on a normal session', () => {
    const snapshots = [
      view('✻ 429 All credentials for model claude-fable-5 are cooling down via provider claude', {
        config: {
          id: 'a-warden',
          binary: 'claude-auto-loge',
          harness: 'claude',
          mode: 'auto',
          label: 'kteam-warden',
        },
      }),
      view('✻ 429 All credentials for model claude-fable-5 are cooling down via provider claude', {
        config: {
          id: 'b-warden-child',
          parent: 'a-warden',
          binary: 'claude-auto-loge',
          harness: 'claude',
          mode: 'auto',
        },
      }),
      view('✻ 429 All credentials for model claude-fable-5 are cooling down via provider claude', {
        config: {
          id: 'y-normal',
          binary: 'claude-auto-loge',
          harness: 'claude',
          mode: 'auto',
          teammate: 'yara',
        },
      }),
      view('✻ 429 All credentials for model claude-fable-5 are cooling down via provider claude', {
        config: {
          id: 'z-normal',
          binary: 'claude-auto-loge',
          harness: 'claude',
          mode: 'auto',
          teammate: 'zelda',
        },
      }),
    ];
    const first = detectProviderOutages({}, snapshots, NOW);
    const second = detectProviderOutages(first.state, snapshots, NOW + 60_000);
    expect(second.anomalies[0]?.sessionId).toBe('y-normal');
    expect(second.anomalies[0]?.affectedSessionIds).toEqual(['y-normal', 'z-normal']);
  });
});
