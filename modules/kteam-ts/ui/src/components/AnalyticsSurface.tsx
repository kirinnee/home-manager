// ANALYTICS LEDGER — a session-scoped reading surface.  It deliberately keeps
// cost maths in lib/model-cost and lineage-costs: this layer only asks bounded
// raw questions and explains the coverage those questions can prove.

import { useEffect, useId, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { AnalyticsRawResponse, AnalyticsResponse, AnalyticsRawSession } from '../../../src/analytics-types';
import { api, ApiError } from '../lib/api';
import { buildLineage } from '../lib/lineage';
import {
  peerMedianCost,
  rollupLineageCosts,
  type CostBuckets,
  type LineageCostSession,
  type PeerCostRow,
} from '../lib/lineage-costs';
import {
  billingFromUsageFeed,
  estimateModelCost,
  type BillingEvidence,
  type BillingKind,
  type ModelCost,
} from '../lib/model-cost';
import { useFleet, useSession } from '../lib/store';
import type { SessionView } from '../types';
import { useUsage } from '../hooks/useUsage';

/** A deliberately small query fan-out. The remaining members are disclosed,
 * never silently treated as zero-cost history. */
export const ANALYTICS_TREE_QUERY_LIMIT = 32;

type CostRow = AnalyticsRawSession;

type AnalyticsState =
  | { phase: 'loading'; data: null; error: null }
  | { phase: 'ready'; data: LoadedAnalytics; error: null }
  | { phase: 'error'; data: null; error: string };

interface LoadedAnalytics {
  rowsById: ReadonlyMap<string, CostRow>;
  comparison: AnalyticsRawResponse | null;
  index: AnalyticsResponse['index'] | null;
}

export interface CostedRow {
  view: SessionView;
  row: CostRow;
  billing: BillingKind;
  billingEvidence: BillingEvidence;
  cost: ModelCost;
}

export function analyticsErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503)
    return 'Analytics index is unavailable while the daemon catches up (503).';
  if (error instanceof Error) return error.message;
  return String(error);
}

/** JSON quoting is the analytics grammar's quoted-string escape mechanism. */
export function analyticsIdQuery(id: string): string {
  return `{id=${JSON.stringify(id)}}`;
}

export function analyticsRows(response: AnalyticsResponse): CostRow[] {
  return response.kind === 'raw' ? (response.results as CostRow[]) : [];
}

function childrenFor(rootId: string, sessions: readonly SessionView[]): string[] {
  const lineage = buildLineage(sessions);
  let root = rootId;
  const seen = new Set<string>();
  while (lineage.parentOf.has(root) && !seen.has(root)) {
    seen.add(root);
    root = lineage.parentOf.get(root)!;
  }
  const ids: string[] = [];
  const included = new Set<string>();
  const pending = [root];
  while (pending.length) {
    const id = pending.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    ids.push(id);
    pending.push(...(lineage.childrenOf.get(id)?.map(view => view.config.id) ?? []));
  }
  return ids;
}

/** Reserve evidence for the selected session (and its resolved root) before
 * filling the bounded tree ledger with other descendants. */
export function boundedTreeQueries(treeIds: readonly string[], selectedId: string): string[] {
  const priority = [treeIds[0], selectedId].filter((id): id is string => Boolean(id));
  const result: string[] = [];
  for (const id of [...priority, ...treeIds]) {
    if (!result.includes(id) && result.length < ANALYTICS_TREE_QUERY_LIMIT) result.push(id);
  }
  return result;
}

function asCosted(view: SessionView, row: CostRow, feed: ReturnType<typeof useUsage>['feed']): CostedRow {
  const billingEvidence = billingFromUsageFeed(feed, row.wrapper ?? view.config.binary);
  const billing = billingEvidence.billing;
  return {
    view,
    row,
    billing,
    billingEvidence,
    cost: estimateModelCost(billing, {
      migrated: row.migrated,
      pricingModel: row.pricingModel,
      createdAt: row.createdAt ?? view.config.createdAt,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheWriteInputTokens: row.cacheWriteInputTokens,
      cacheWrite5mInputTokens: row.cacheWrite5mInputTokens,
      cacheWrite1hInputTokens: row.cacheWrite1hInputTokens,
      outputTokens: row.outputTokens,
    }),
  };
}

export function formatUsdMicros(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const micros = (absolute % 1_000_000n).toString().padStart(6, '0');
  const fraction = micros.replace(/0+$/, '').padEnd(2, '0');
  return `${sign}$${whole.toLocaleString('en-US')}.${fraction}`;
}

function countLabel(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

export function bucketCoverage(buckets: CostBuckets, returned: number, total: number): string {
  const unqueried = Math.max(0, total - returned);
  return [
    `${buckets.knownApiSessions} API rows priced`,
    `${buckets.unknownApiSessions} API costs unknown`,
    `${buckets.subscriptionSessions} subscriptions`,
    `${buckets.unknownBillingSessions} billing-unknown`,
    unqueried ? `${unqueried} unqueried` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function tokenText(
  rows: readonly CostRow[],
  key: keyof Pick<CostRow, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens'>,
): string {
  if (!rows.length) return 'Unknown';
  let total = 0n;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'Unknown';
    total += BigInt(value);
  }
  return new Intl.NumberFormat('en-US').format(total);
}

export function ownCostCopy(costed: CostedRow | undefined, fallbackBilling: BillingEvidence): string {
  if (!costed) {
    if (fallbackBilling.billing === 'subscription') return 'Not billed per token';
    return 'Cost unavailable: this session has no indexed analytics record yet.';
  }
  if (costed.billing === 'subscription') return 'Not billed per token';
  if (costed.billingEvidence.billing === 'unknown') return `Billing is unknown: ${costed.billingEvidence.reason}.`;
  return costed.cost.kind === 'known'
    ? formatUsdMicros(costed.cost.usdMicros)
    : `Cost unknown: ${costed.cost.reason.replaceAll('_', ' ')}.`;
}

function BucketLine({ buckets, returned, total }: { buckets: CostBuckets; returned: number; total: number }) {
  return <p className="m-0 text-meta leading-base text-muted">{bucketCoverage(buckets, returned, total)}</p>;
}

function RawResult({ response }: { response: AnalyticsResponse }) {
  const base = (
    <p className="m-0 text-meta text-muted">
      {response.scope.matched} matched · {response.scope.indexed} indexed
    </p>
  );
  if (response.kind === 'aggregate') {
    return (
      <div className="grid gap-xs">
        {base}
        {response.results.map((result, index) => (
          <div key={index} className="rounded-control border border-border-soft bg-surface px-3 py-2 text-cell text-fg">
            {Object.entries(result.labels)
              .map(([key, value]) => `${key}=${value ?? 'unknown'}`)
              .join(' · ') || 'All sessions'}
            : {result.sessions} sessions
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-xs">
      {base}
      {response.truncated && (
        <p role="status" className="m-0 text-meta text-warn">
          Showing the server-capped result; this query is truncated.
        </p>
      )}
      {response.results.map(row => (
        <div key={row.id} className="rounded-control border border-border-soft bg-surface px-3 py-2 text-cell">
          <span className="mono text-2xs text-accent">{row.id}</span>
          <span className="ml-2 text-muted">
            {row.status ?? 'unknown'} · {row.tokens ?? 'unknown'} tokens
          </span>
        </div>
      ))}
    </div>
  );
}

/** The scrolling content only. SidePane owns the titlebar and close chrome. */
export function AnalyticsSurface({ sessionId }: { sessionId: string }) {
  const view = useSession(sessionId);
  const { sessions } = useFleet();
  const usage = useUsage();
  const queryId = useId();
  const [state, setState] = useState<AnalyticsState>({ phase: 'loading', data: null, error: null });
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState<AnalyticsResponse | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);

  const treeIds = useMemo(() => (sessions && view ? childrenFor(view.config.id, sessions) : []), [sessions, view]);
  const queriedIds = useMemo(() => boundedTreeQueries(treeIds, sessionId), [sessionId, treeIds]);
  const treeKey = queriedIds.join('\u0000');
  const fleetContextReady = Boolean(view && sessions);

  useEffect(() => {
    if (!fleetContextReady) return;
    let current = true;
    setState({ phase: 'loading', data: null, error: null });
    void Promise.all([
      Promise.all(queriedIds.map(id => api.analytics(analyticsIdQuery(id)))),
      api.analytics('{status=completed}'),
    ])
      .then(([selected, comparison]) => {
        if (!current) return;
        const rowsById = new Map<string, CostRow>();
        for (const response of selected) for (const row of analyticsRows(response)) rowsById.set(row.id, row);
        setState({
          phase: 'ready',
          data: {
            rowsById,
            comparison: comparison.kind === 'raw' ? comparison : null,
            index: selected[0]?.index ?? comparison.index,
          },
          error: null,
        });
      })
      .catch(reason => {
        if (current) setState({ phase: 'error', data: null, error: analyticsErrorMessage(reason) });
      });
    return () => {
      current = false;
    };
    // treeKey is the complete request identity. Depending on the fleet/view
    // object identities here would refetch up to 33 analytics rows for every
    // unrelated live session-state update.
  }, [fleetContextReady, treeKey]);

  const viewById = useMemo(
    () => new Map((sessions ?? []).map(candidate => [candidate.config.id, candidate])),
    [sessions],
  );
  const costed = useMemo(() => {
    if (!state.data) return [];
    return [...state.data.rowsById].flatMap(([id, row]) => {
      const candidate = viewById.get(id);
      return candidate ? [asCosted(candidate, row, usage.feed)] : [];
    });
  }, [state.data, usage.feed, viewById]);
  const own = costed.find(item => item.view.config.id === sessionId);
  const fallbackBilling = billingFromUsageFeed(usage.feed, view?.config.binary);
  const rollupSessions = useMemo<LineageCostSession[]>(() => {
    const byId = new Map(costed.map(item => [item.view.config.id, item] as const));
    return queriedIds.flatMap(id => {
      const indexed = byId.get(id);
      if (indexed) return [{ view: indexed.view, billing: indexed.billing, cost: indexed.cost }];
      const candidate = viewById.get(id);
      if (!candidate) return [];
      const billing = billingFromUsageFeed(usage.feed, candidate.config.binary).billing;
      return [
        {
          view: candidate,
          billing,
          cost: estimateModelCost(billing, {
            migrated: undefined,
            pricingModel: null,
            createdAt: candidate.config.createdAt,
            inputTokens: null,
            cachedInputTokens: null,
            cacheWriteInputTokens: null,
            outputTokens: null,
          }),
        },
      ];
    });
  }, [costed, queriedIds, usage.feed, viewById]);
  const rollup = useMemo(() => rollupLineageCosts(rollupSessions), [rollupSessions]);
  const peer = useMemo(() => {
    if (!own || !state.data?.comparison) return undefined;
    const target: PeerCostRow = {
      id: own.row.id,
      completed: own.row.completed,
      billing: own.billing,
      cost: own.cost,
      wrapper: own.row.wrapper,
      harness: own.row.harness,
    };
    const candidates: PeerCostRow[] = analyticsRows(state.data.comparison)
      .filter(row => row.id !== sessionId)
      .map(row => {
        const candidate = viewById.get(row.id);
        const billingEvidence = billingFromUsageFeed(usage.feed, row.wrapper ?? candidate?.config.binary);
        const cost = estimateModelCost(billingEvidence.billing, {
          migrated: row.migrated,
          pricingModel: row.pricingModel,
          createdAt: row.createdAt ?? candidate?.config.createdAt,
          inputTokens: row.inputTokens,
          cachedInputTokens: row.cachedInputTokens,
          cacheWriteInputTokens: row.cacheWriteInputTokens,
          cacheWrite5mInputTokens: row.cacheWrite5mInputTokens,
          cacheWrite1hInputTokens: row.cacheWrite1hInputTokens,
          outputTokens: row.outputTokens,
        });
        return {
          id: row.id,
          completed: row.completed,
          billing: billingEvidence.billing,
          cost,
          wrapper: row.wrapper,
          harness: row.harness,
        };
      });
    return peerMedianCost(target, candidates);
  }, [own, sessionId, state.data?.comparison, usage.feed, viewById]);

  async function runQuery() {
    setQuerying(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      setQueryResult(await api.analytics(query.trim() || undefined));
    } catch (reason) {
      setQueryError(analyticsErrorMessage(reason));
    } finally {
      setQuerying(false);
    }
  }

  if (!sessions || !view)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-panel py-6" role="status">
        <p className="m-0 text-cell text-muted">Loading session analytics…</p>
      </div>
    );
  if (state.phase === 'error')
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-panel py-6" role="alert">
        <p className="m-0 max-w-[38ch] text-center text-cell text-err">
          Analytics could not load: {state.error} Cost remains unknown; no zero was assumed.
        </p>
      </div>
    );

  const account = usage.index.get(view.config.binary);
  const selectedRows = own ? [own.row] : [];
  const unqueried = Math.max(0, treeIds.length - queriedIds.length);
  const missingIndexedRows = Math.max(0, queriedIds.length - costed.length);
  const partialCoverage = [
    unqueried > 0 ? unqueried + ' beyond the ' + ANALYTICS_TREE_QUERY_LIMIT + '-session query bound' : null,
    missingIndexedRows > 0 ? missingIndexedRows + ' queried without an indexed row' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-4 pt-3 scroll-thin">
      <div className="grid gap-4">
        <section aria-labelledby="analytics-this" className="border-l-2 border-accent pl-3">
          <h3 id="analytics-this" className="kt-label m-0">
            This session
          </h3>
          <p className="mt-1 text-lg font-semibold text-fg" aria-live="polite">
            {state.phase === 'loading' ? 'Reading indexed ledger…' : ownCostCopy(own, fallbackBilling)}
          </p>
          {fallbackBilling.billing === 'subscription' && (
            <p className="m-0 text-meta leading-base text-muted">
              5-hour window: {account?.fiveHourPercent === undefined ? 'unknown' : `${account.fiveHourPercent}% used`}.
              Weekly window: {account?.weeklyPercent === undefined ? 'unknown' : `${account.weeklyPercent}% used`}.
              Subscription quota is a current account window, not historical per-session consumption.
            </p>
          )}
          {(own?.billing === 'api_metered' || (!own && fallbackBilling.billing === 'api_metered')) && (
            <p className="m-0 text-meta leading-base text-muted">
              Dollar amounts are estimates using the current wrapper’s billing classification. Sessions with migration
              evidence—or without schema-v6 attribution evidence—remain unknown.
            </p>
          )}
        </section>

        <section aria-labelledby="analytics-tree" className="grid gap-xs border-t border-border-soft pt-3">
          <h3 id="analytics-tree" className="kt-label m-0">
            Resolved parent tree
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-control border border-border-soft bg-surface px-3 py-2">
              <span className="block text-2xs text-faint">This session, estimated API</span>
              <strong className="text-cell text-fg">
                {own?.cost.kind === 'known' ? formatUsdMicros(own.cost.usdMicros) : 'Unknown'}
              </strong>
            </div>
            <div className="rounded-control border border-border-soft bg-surface px-3 py-2">
              <span className="block text-2xs text-faint">Whole tree, estimated API subtotal</span>
              <strong className="text-cell text-fg">
                {rollup.fleet.knownApiSessions > 0
                  ? formatUsdMicros(rollup.fleet.knownApiUsdMicros)
                  : 'No priced API rows'}
              </strong>
            </div>
          </div>
          <p className="m-0 text-cell text-muted">
            {countLabel(treeIds.length, 'session')} in the resolved tree. This is a known API subtotal, not a tree cost.
          </p>
          <BucketLine buckets={rollup.fleet} returned={queriedIds.length} total={treeIds.length} />
          {partialCoverage && (
            <p className="m-0 text-meta text-warn">
              Coverage is partial: {partialCoverage}. They are unknown, not zero.
            </p>
          )}
        </section>

        <section aria-labelledby="analytics-comparison" className="grid gap-xs border-t border-border-soft pt-3">
          <h3 id="analytics-comparison" className="kt-label m-0">
            Comparable completed sessions
          </h3>
          {state.phase === 'loading' ? (
            <p className="m-0 text-cell text-muted">Checking the recent sample…</p>
          ) : peer ? (
            <p className="m-0 text-cell text-fg">
              Typical compatible API estimate: <strong>{formatUsdMicros(peer.medianUsdMicros)}</strong> median across{' '}
              {peer.sampleSize} recent completed sessions.
            </p>
          ) : (
            <p className="m-0 text-cell text-muted">
              No comparison yet: at least 5 exact pricing-key, wrapper, model, and harness peers with known API
              estimates are required. The comparison uses a recent server-capped sample.
            </p>
          )}
          {state.data?.comparison?.truncated && (
            <p className="m-0 text-meta text-warn">Recent comparison sample was truncated by the server.</p>
          )}
        </section>

        <section aria-labelledby="analytics-tokens" className="grid gap-xs border-t border-border-soft pt-3">
          <h3 id="analytics-tokens" className="kt-label m-0">
            Token ledger
          </h3>
          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2 text-cell">
            <div>
              <dt className="text-2xs text-faint">Input</dt>
              <dd className="m-0 text-fg">{tokenText(selectedRows, 'inputTokens')}</dd>
            </div>
            <div>
              <dt className="text-2xs text-faint">Output</dt>
              <dd className="m-0 text-fg">{tokenText(selectedRows, 'outputTokens')}</dd>
            </div>
            <div>
              <dt className="text-2xs text-faint">Cache read</dt>
              <dd className="m-0 text-fg">{tokenText(selectedRows, 'cachedInputTokens')}</dd>
            </div>
            <div>
              <dt className="text-2xs text-faint">Cache write</dt>
              <dd className="m-0 text-fg">{tokenText(selectedRows, 'cacheWriteInputTokens')}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="analytics-explore" className="grid gap-2 border-t border-border-soft pt-3">
          <h3 id="analytics-explore" className="kt-label m-0">
            Explore fleet
          </h3>
          <label htmlFor={queryId} className="sr-only">
            Analytics query
          </label>
          <div className="flex gap-2">
            <span className="relative min-w-0 flex-1">
              <Search
                size={15}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              <input
                id={queryId}
                className="kt-input min-h-[44px] w-full pl-9 pr-3"
                value={query}
                onChange={event => setQuery(event.currentTarget.value)}
                placeholder="count by (status)"
              />
            </span>
            <button
              type="button"
              className="kt-btn min-h-[44px] shrink-0"
              onClick={() => void runQuery()}
              disabled={querying}
            >
              {querying ? (
                <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                'Run'
              )}
              {querying && <span className="sr-only">Running query</span>}
            </button>
          </div>
          {queryError && (
            <p role="alert" className="m-0 text-meta text-err">
              {queryError}
            </p>
          )}
          {queryResult && <RawResult response={queryResult} />}
          {state.data?.index && (
            <p className="m-0 text-2xs text-faint">
              Index: {state.data.index.tokenSessions} token-complete of {state.data.index.sessions};{' '}
              {state.data.index.pendingTranscriptSources} source
              {state.data.index.pendingTranscriptSources === 1 ? '' : 's'} pending
              {state.data.index.refreshing ? ' (backfill in progress)' : ''}.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
