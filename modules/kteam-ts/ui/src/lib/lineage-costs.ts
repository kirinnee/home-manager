import type { SessionView } from '../types';
import { buildLineage } from './lineage';
import type { BillingKind, ModelCost } from './model-cost';

export interface LineageCostSession {
  view: SessionView;
  billing: BillingKind;
  cost: ModelCost;
}

export interface CostBuckets {
  /** USD micros for only known API-metered costs. */
  knownApiUsdMicros: bigint;
  knownApiSessions: number;
  unknownApiSessions: number;
  subscriptionSessions: number;
  unknownBillingSessions: number;
}

export interface LineageCostNode {
  id: string;
  rootId: string;
  own: CostBuckets;
  subtree: CostBuckets;
  children: readonly string[];
}

export interface LineageCostRollup {
  nodes: ReadonlyMap<string, LineageCostNode>;
  roots: readonly string[];
  /** Combined buckets across all supplied sessions, including orphan roots. */
  fleet: CostBuckets;
  /** Resolves a supplied node to its topmost sanitized lineage root. */
  rootOf(id: string): string | undefined;
}

const emptyBuckets = (): CostBuckets => ({
  knownApiUsdMicros: 0n,
  knownApiSessions: 0,
  unknownApiSessions: 0,
  subscriptionSessions: 0,
  unknownBillingSessions: 0,
});
const addBuckets = (into: CostBuckets, addition: CostBuckets): CostBuckets => ({
  knownApiUsdMicros: into.knownApiUsdMicros + addition.knownApiUsdMicros,
  knownApiSessions: into.knownApiSessions + addition.knownApiSessions,
  unknownApiSessions: into.unknownApiSessions + addition.unknownApiSessions,
  subscriptionSessions: into.subscriptionSessions + addition.subscriptionSessions,
  unknownBillingSessions: into.unknownBillingSessions + addition.unknownBillingSessions,
});

function ownBuckets(session: LineageCostSession): CostBuckets {
  if (session.billing === 'subscription') return { ...emptyBuckets(), subscriptionSessions: 1 };
  if (session.billing === 'unknown') return { ...emptyBuckets(), unknownBillingSessions: 1 };
  if (session.cost.kind === 'known') {
    return { ...emptyBuckets(), knownApiUsdMicros: session.cost.usdMicros, knownApiSessions: 1 };
  }
  return { ...emptyBuckets(), unknownApiSessions: 1 };
}

/**
 * Iterative lineage aggregation. It uses buildLineage's already-sanitized
 * parent map, therefore absent parents and broken cycles remain roots instead
 * of being omitted or recursed forever.
 */
export function rollupLineageCosts(sessions: readonly LineageCostSession[]): LineageCostRollup {
  const views = sessions.map(session => session.view);
  const lineage = buildLineage(views);
  const byId = new Map(sessions.map(session => [session.view.config.id, session] as const));
  const parentOf = lineage.parentOf;
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const session of sessions) {
    const id = session.view.config.id;
    const parent = parentOf.get(id);
    if (!parent || !byId.has(parent)) roots.push(id);
    else {
      const rows = children.get(parent);
      if (rows) rows.push(id);
      else children.set(parent, [id]);
    }
  }

  const rootById = new Map<string, string>();
  const order: string[] = [];
  const pending = roots.map(root => ({ id: root, root }));
  while (pending.length) {
    const current = pending.pop()!;
    if (rootById.has(current.id)) continue;
    rootById.set(current.id, current.root);
    order.push(current.id);
    for (const child of children.get(current.id) ?? []) pending.push({ id: child, root: current.root });
  }

  // buildLineage should make all nodes reachable from roots; this final pass
  // retains every supplied record even if an exotic future index does not.
  for (const id of byId.keys()) {
    if (!rootById.has(id)) {
      rootById.set(id, id);
      roots.push(id);
      order.push(id);
    }
  }

  const subtree = new Map<string, CostBuckets>();
  for (const id of order.slice().reverse()) {
    const session = byId.get(id)!;
    let total = ownBuckets(session);
    for (const child of children.get(id) ?? []) total = addBuckets(total, subtree.get(child) ?? emptyBuckets());
    subtree.set(id, total);
  }
  const nodes = new Map<string, LineageCostNode>();
  for (const id of order) {
    const session = byId.get(id)!;
    nodes.set(id, {
      id,
      rootId: rootById.get(id)!,
      own: ownBuckets(session),
      subtree: subtree.get(id)!,
      children: children.get(id) ?? [],
    });
  }
  let fleet = emptyBuckets();
  for (const root of roots) fleet = addBuckets(fleet, subtree.get(root) ?? emptyBuckets());
  return { nodes, roots, fleet, rootOf: id => rootById.get(id) };
}

export interface PeerCostRow {
  id: string;
  completed: boolean;
  billing: BillingKind;
  cost: ModelCost;
  wrapper: string | null | undefined;
  harness: string | null | undefined;
}

export interface PeerMedian {
  medianUsdMicros: bigint;
  sampleSize: number;
}

/** Returns no benchmark until five comparable completed API sessions exist. */
export function peerMedianCost(target: PeerCostRow, candidates: readonly PeerCostRow[]): PeerMedian | undefined {
  const targetCost = target.cost;
  if (targetCost.kind !== 'known') return undefined;
  const peers = candidates
    .filter(
      candidate =>
        candidate.id !== target.id &&
        candidate.completed &&
        candidate.billing === 'api_metered' &&
        candidate.cost.kind === 'known' &&
        candidate.cost.pricingKey === targetCost.pricingKey &&
        candidate.cost.pricingModel === targetCost.pricingModel &&
        candidate.wrapper === target.wrapper &&
        candidate.harness === target.harness,
    )
    .map(candidate => (candidate.cost as Extract<ModelCost, { kind: 'known' }>).usdMicros)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (peers.length < 5) return undefined;
  const middle = Math.floor(peers.length / 2);
  const medianUsdMicros = peers.length % 2 === 1 ? peers[middle]! : (peers[middle - 1]! + peers[middle]!) / 2n;
  return { medianUsdMicros, sampleSize: peers.length };
}
