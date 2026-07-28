import { describe, expect, test } from 'bun:test';
import type { SessionView } from '../types';
import { estimateModelCost, type ModelCost } from './model-cost';
import { peerMedianCost, rollupLineageCosts, type LineageCostSession, type PeerCostRow } from './lineage-costs';

function view(id: string, parent?: string): SessionView {
  return {
    config: {
      id,
      parent,
      name: id,
      binary: 'codex',
      harness: 'codex',
      modelHint: 'gpt-5.6-sol',
      mode: 'auto',
      cwd: '/repo',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
      turn: 1,
      harnessSessionId: id,
      tmuxSession: id,
      watcherSession: id,
      intervalSeconds: 60,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 1,
      systemPromptFile: '',
      originalPromptFile: '',
    },
    state: { id, status: 'completed', turn: 1 },
    directory: '/repo',
  };
}

const known = (micros: bigint): Extract<ModelCost, { kind: 'known' }> => ({
  kind: 'known',
  usdMicros: micros,
  pricingKey: 'openai:gpt-5.6-sol@2026-07-28',
  pricingModel: 'gpt-5.6-sol',
});
const unknown: ModelCost = estimateModelCost('api_metered', {
  pricingModel: null,
  createdAt: null,
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
});
const row = (
  id: string,
  parent: string | undefined,
  billing: LineageCostSession['billing'],
  cost: ModelCost,
): LineageCostSession => ({ view: view(id, parent), billing, cost });

describe('rollupLineageCosts', () => {
  test('iteratively preserves deep chains, cycle-broken sessions and orphans in separate buckets', () => {
    const deep: LineageCostSession[] = [];
    let parent: string | undefined;
    for (let index = 0; index < 2_000; index += 1) {
      const id = `deep-${index}`;
      deep.push(row(id, parent, 'api_metered', known(1n)));
      parent = id;
    }
    const result = rollupLineageCosts([
      ...deep,
      row('orphan', 'missing', 'subscription', unknown),
      row('cycle-a', 'cycle-b', 'unknown', unknown),
      row('cycle-b', 'cycle-a', 'api_metered', unknown),
    ]);
    expect(result.nodes.get('deep-0')?.subtree.knownApiUsdMicros).toBe(2_000n);
    expect(result.rootOf('deep-1999')).toBe('deep-0');
    expect(result.roots).toEqual(['deep-0', 'orphan', 'cycle-a', 'cycle-b']);
    expect(result.fleet).toEqual({
      knownApiUsdMicros: 2_000n,
      knownApiSessions: 2_000,
      unknownApiSessions: 1,
      subscriptionSessions: 1,
      unknownBillingSessions: 1,
    });
  });
});

describe('peerMedianCost', () => {
  test('requires five matching completed API peers and returns sample size', () => {
    const target: PeerCostRow = {
      id: 'target',
      completed: true,
      billing: 'api_metered',
      cost: known(9n),
      wrapper: 'codex',
      harness: 'codex',
    };
    const peers = [1n, 2n, 50n, 4n, 5n].map((value, index) => ({ ...target, id: `peer-${index}`, cost: known(value) }));
    expect(peerMedianCost(target, peers.slice(0, 4))).toBeUndefined();
    expect(
      peerMedianCost(target, [
        ...peers,
        target,
        { ...target, id: 'other-model', cost: { ...known(999n), pricingModel: 'gpt-5.6-terra' } },
        { ...target, id: 'unfinished', completed: false, cost: known(999n) },
      ]),
    ).toEqual({ medianUsdMicros: 4n, sampleSize: 5 });
  });
});
