import { describe, expect, test } from 'bun:test';
import {
  buildWaiterNotices,
  computeGraphImpact,
  graphHasWaiters,
  graphImpactEmpty,
  renderGraphHandoffSection,
  renderGraphImpactCli,
  renderGraphImpactLine,
  toGraphNode,
  type GraphNode,
} from './migrate-graph';
import type { SessionStatus } from './types';

/** Compact GraphNode builder for the table tests. */
function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return { id, status: 'running' as SessionStatus, ...over };
}

describe('computeGraphImpact — the DAG folds around the migrating id', () => {
  test('parent edge resolves and is reported (survives via the stable id)', () => {
    const nodes = [node('lead', { teammate: 'leo' }), node('mid', { parent: 'lead', teammate: 'mona' })];
    const impact = computeGraphImpact('mid', nodes);
    expect(impact.parent).toEqual({ id: 'lead', teammate: 'leo' });
    expect(impact.parentDangling).toBe(false);
    expect(impact.idStable).toBe(true);
  });

  test('children pointing at the migrating id are found (they stay attached)', () => {
    const nodes = [
      node('mid'),
      node('c1', { parent: 'mid', teammate: 'ann' }),
      node('c2', { parent: 'mid' }),
      node('other', { parent: 'somebody-else' }),
    ];
    const impact = computeGraphImpact('mid', nodes);
    expect(impact.children.map(c => c.id).sort()).toEqual(['c1', 'c2']);
    expect(impact.children.find(c => c.id === 'c1')?.teammate).toBe('ann');
  });

  test('waiters parked on the migrating id are the re-arm targets', () => {
    const nodes = [
      node('target', { teammate: 'tara' }),
      node('w1', { teammate: 'wanda', waitingPeer: 'target', waitingUntil: '2026-07-27T09:00:00Z' }),
      node('w2', { waitingPeer: 'target' }),
      node('unrelated', { waitingPeer: 'someone-else' }),
    ];
    const impact = computeGraphImpact('target', nodes);
    expect(impact.waiters.map(w => w.id).sort()).toEqual(['w1', 'w2']);
    expect(graphHasWaiters(impact)).toBe(true);
    expect(impact.waiters.find(w => w.id === 'w1')?.until).toBe('2026-07-27T09:00:00Z');
    expect(impact.waiters.find(w => w.id === 'w2')?.until).toBeUndefined();
  });

  test('a session never counts as its own parent/child/waiter', () => {
    // A self-referential edge (malformed) must not fold the node onto itself.
    const nodes = [node('x', { parent: 'x', waitingPeer: 'x' })];
    const impact = computeGraphImpact('x', nodes);
    expect(impact.children).toEqual([]);
    expect(impact.waiters).toEqual([]);
    // parent === self resolves to a node, but it is still "found"; the guard is
    // only on children/waiters where a self-loop would double-count the node.
  });

  test('a set-but-missing parent is flagged dangling, not resolved', () => {
    const impact = computeGraphImpact('orphan', [node('orphan', { parent: 'purged-parent' })]);
    expect(impact.parent).toBeUndefined();
    expect(impact.parentDangling).toBe(true);
  });

  test('a solo session has an empty impact', () => {
    const impact = computeGraphImpact('solo', [node('solo'), node('stranger')]);
    expect(graphImpactEmpty(impact)).toBe(true);
    expect(graphHasWaiters(impact)).toBe(false);
  });
});

describe('toGraphNode — projection from a SessionView', () => {
  test('lifts parent, status and the peer wait', () => {
    const gn = toGraphNode({
      config: { id: 'a', teammate: 'ann', parent: 'lead' },
      state: { status: 'waiting' as SessionStatus, waiting: { since: 'now', peer: 'lead', peerName: 'leo' } },
    });
    expect(gn).toMatchObject({
      id: 'a',
      teammate: 'ann',
      parent: 'lead',
      status: 'waiting',
      waitingPeer: 'lead',
      waitingPeerName: 'leo',
    });
  });

  test('a session with no wait has no waitingPeer', () => {
    const gn = toGraphNode({ config: { id: 'a' }, state: { status: 'running' as SessionStatus } });
    expect(gn.waitingPeer).toBeUndefined();
  });
});

describe('rendering — blast radius and handoff', () => {
  const withWaiters = computeGraphImpact('target', [
    node('target', { teammate: 'tara', parent: 'lead' }),
    node('lead', { teammate: 'leo' }),
    node('c1', { parent: 'target', teammate: 'ann', status: 'running' as SessionStatus }),
    node('w1', { teammate: 'wanda', waitingPeer: 'target' }),
  ]);

  test('renderGraphImpactLine names the waiter count first (the hazard)', () => {
    const line = renderGraphImpactLine(withWaiters);
    expect(line).toContain("1 session waiting on this session's reply");
    expect(line).toContain('1 child session');
    expect(line).toContain('parent leo (lead)');
  });

  test('empty impact renders nothing (solo migrate is unchanged)', () => {
    const empty = computeGraphImpact('solo', [node('solo')]);
    expect(renderGraphImpactLine(empty)).toBe('');
    expect(renderGraphImpactCli(empty)).toBe('');
    expect(renderGraphHandoffSection(empty)).toBe('');
  });

  test('renderGraphImpactCli lists each waiter by name', () => {
    const cli = renderGraphImpactCli(withWaiters);
    expect(cli).toContain('wanda (w1)');
    expect(cli).toContain('STABLE across migrate');
  });

  test('handoff section carries the re-arm instruction and the waiter list', () => {
    const section = renderGraphHandoffSection(withWaiters);
    expect(section).toContain('Session graph after this migrate');
    expect(section).toContain('PARKED on your reply');
    expect(section).toContain('kteam send <peer>');
    expect(section).toContain('wanda (w1)');
    // Parent + child are stated as still-attached.
    expect(section).toContain('leo (lead)');
    expect(section).toContain('ann (c1)');
  });

  test('open-ended waiters are flagged as non-self-waking in the handoff', () => {
    const impact = computeGraphImpact('target', [
      node('target'),
      node('w', { teammate: 'wanda', waitingPeer: 'target' }),
    ]);
    expect(renderGraphHandoffSection(impact)).toContain('OPEN-ENDED (will not self-wake)');
  });
});

describe('buildWaiterNotices — optional, non-resolving, per waiter', () => {
  test('one informational notice per waiter, naming the migrated session', () => {
    const impact = computeGraphImpact('target', [
      node('target', { teammate: 'tara' }),
      node('w1', { waitingPeer: 'target' }),
      node('w2', { waitingPeer: 'target' }),
    ]);
    const notices = buildWaiterNotices(impact);
    expect(notices.map(n => n.id).sort()).toEqual(['w1', 'w2']);
    expect(notices[0]!.message).toContain('tara (target)');
    expect(notices[0]!.message).toContain('resolve when it replies');
  });

  test('no waiters => no notices', () => {
    expect(buildWaiterNotices(computeGraphImpact('solo', [node('solo')]))).toEqual([]);
  });
});
