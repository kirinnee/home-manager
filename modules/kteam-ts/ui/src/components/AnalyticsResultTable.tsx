// THE ONE aggregate table. Tree, CLI, model and hand-written queries all render
// through this component — a third variant of "tokens and cost in a grid" would
// be worse than none.
//
// It is a ledger, not a dashboard: theme tokens, hairline rules, tabular
// numerals, no cards and no chrome. The one place it asks for attention is the
// COST RAIL — the trailing column is sorted descending by default, because the
// question behind every one of these queries is "what is expensive".
//
// HONESTY RULES, in code rather than in prose:
//   - A group whose model has no published rate keeps every token value and says
//     the cost is unknown. It is never dropped and never priced from a neighbour.
//   - A measure the server could only resolve for part of the group renders as
//     unknown with its known/total coverage, exactly like the CLI's `—[k/t]`.
//   - The roll-up row is STRICT: one unknown row makes the total unknown. It is
//     also offered only for `sum`, because a column of averages does not add up.
//
// 390px FIRST. The horizontal scroller is this component's own container, so a
// nine-column ledger can never make the side pane or the page scroll sideways.

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp } from 'lucide-react';
import type {
  AnalyticsAggregateResponse,
  AnalyticsAggregateResult,
  AnalyticsMeasure,
} from '../../../src/analytics-types';
import { EQUIVALENT_API_COST_CAVEAT, PRICING_REGISTRY, PRICING_REGISTRY_VERIFIED_AT } from '../lib/model-cost';
import { cn } from '../lib/utils';

/** The backend adds this measure in the same change that teaches SQL the rate
 * table. Declaring it locally as OPTIONAL keeps this file compiling both before
 * and after that lands, and never invents a number when it is absent. */
type AggregateResultWithCost = AnalyticsAggregateResult & {
  equivalentApiCostUsdMicros?: AnalyticsMeasure;
};

export type AnalyticsSortKey =
  | 'group'
  | 'sessions'
  | 'input'
  | 'output'
  | 'cacheRead'
  | 'cacheWrite'
  | 'total'
  | 'cost';
export type AnalyticsSortDirection = 'asc' | 'desc';

export interface AnalyticsTableRow {
  key: string;
  group: string;
  sessions: number;
  input: AnalyticsMeasure;
  output: AnalyticsMeasure;
  cacheRead: AnalyticsMeasure;
  cacheWrite: AnalyticsMeasure;
  total: AnalyticsMeasure;
  cost: AnalyticsMeasure;
}

interface Column {
  key: AnalyticsSortKey;
  header: string;
  /** Column meaning that does not fit in a header cell. */
  hint?: string;
  numeric: boolean;
}

export const ANALYTICS_TABLE_COLUMNS: readonly Column[] = [
  { key: 'group', header: 'Group', numeric: false },
  { key: 'sessions', header: 'Sessions', numeric: true },
  { key: 'input', header: 'Input', hint: 'gross input, including cache reads and writes', numeric: true },
  { key: 'output', header: 'Output', numeric: true },
  { key: 'cacheRead', header: 'Cache read', numeric: true },
  { key: 'cacheWrite', header: 'Cache write', numeric: true },
  { key: 'total', header: 'Total', numeric: true },
  { key: 'cost', header: 'Equivalent API cost', numeric: true },
];

/** Never spend, never bill. The figure answers a comparison question. */
export const EQUIVALENT_COST_HEADER = 'Equivalent API cost';

const UNKNOWN_MEASURE: AnalyticsMeasure = { value: null, known: 0, total: 0 };

/** The freshest verification date the SHARED registry reports, so a stale rate
 * is visible rather than assumed current.
 *
 * The shared constant is the source of truth and is used whenever it holds a
 * real date. The fallback derives the date from the entries themselves, which
 * keeps the footnote honest if the constant ever degrades to its `'unknown'`
 * sentinel again — a rendered "rates verified unknown" would undermine exactly
 * the freshness claim this line exists to make. */
export function pricingVerifiedAt(): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(PRICING_REGISTRY_VERIFIED_AT)) return PRICING_REGISTRY_VERIFIED_AT;
  const dates = PRICING_REGISTRY.map(entry => entry.verifiedAt).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date));
  return dates.length ? dates.reduce((latest, date) => (date > latest ? date : latest)) : 'an unrecorded date';
}

export function equivalentCostFootnote(verifiedAt = pricingVerifiedAt()): string {
  // The caveat sentence is the SHARED one, so the CLI and this table cannot
  // describe the same number differently. What follows it are the two things a
  // reader of these columns still needs: that it says nothing about how any
  // session was actually billed, and that Input is gross.
  return (
    `${EQUIVALENT_API_COST_CAVEAT} It is not a claim about how any session was billed. Input is gross: it ` +
    `includes cache reads and cache writes. A model with no published rate keeps its tokens and reports the cost ` +
    `as unknown; no price is ever guessed. Rates verified ${verifiedAt}.`
  );
}

function groupName(result: AnalyticsAggregateResult): string {
  const parts = Object.entries(result.labels).map(([key, value]) => `${key}=${value ?? 'unknown'}`);
  return parts.join(' · ') || 'All sessions';
}

/** Flatten one aggregate response into table rows. A missing cost measure means
 * the server did not price this response — reported as unknown for every
 * session in the group, never as zero. */
export function analyticsTableRows(response: AnalyticsAggregateResponse): AnalyticsTableRow[] {
  return response.results.map((raw, index) => {
    const result = raw as AggregateResultWithCost;
    return {
      key: `${index}:${groupName(result)}`,
      group: groupName(result),
      sessions: result.sessions,
      input: result.inputTokens,
      output: result.outputTokens,
      cacheRead: result.cachedInputTokens,
      cacheWrite: result.cacheWriteInputTokens,
      total: result.tokens,
      cost: result.equivalentApiCostUsdMicros ?? { value: null, known: 0, total: result.sessions },
    };
  });
}

function measureFor(row: AnalyticsTableRow, key: AnalyticsSortKey): AnalyticsMeasure | undefined {
  if (key === 'group' || key === 'sessions') return undefined;
  return row[key];
}

/** Sort with unknowns pinned last in BOTH directions. An unknown is not a small
 * number, so letting it sort as one would answer "what is cheapest" with rows
 * whose price nobody knows. */
export function sortAnalyticsRows(
  rows: readonly AnalyticsTableRow[],
  key: AnalyticsSortKey,
  direction: AnalyticsSortDirection,
): AnalyticsTableRow[] {
  const sign = direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (key === 'group') return sign * a.row.group.localeCompare(b.row.group) || a.index - b.index;
      const left = key === 'sessions' ? a.row.sessions : (measureFor(a.row, key)?.value ?? null);
      const right = key === 'sessions' ? b.row.sessions : (measureFor(b.row, key)?.value ?? null);
      if (left === null && right === null) return a.index - b.index;
      if (left === null) return 1;
      if (right === null) return -1;
      return sign * (left - right) || a.index - b.index;
    })
    .map(item => item.row);
}

function sumMeasures(measures: readonly AnalyticsMeasure[]): AnalyticsMeasure {
  let value: number | null = 0;
  let known = 0;
  let total = 0;
  for (const measure of measures) {
    known += measure.known;
    total += measure.total;
    if (value === null) continue;
    // Strict: a partially covered measure is not a number we may add.
    if (measure.value === null || measure.known !== measure.total) value = null;
    else value += measure.value;
  }
  return { value, known, total };
}

/** The strict roll-up. Every column is unknown the moment one group is. */
export function analyticsTotalRow(rows: readonly AnalyticsTableRow[]): AnalyticsTableRow {
  return {
    key: 'total',
    group: 'Total',
    sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
    input: sumMeasures(rows.map(row => row.input)),
    output: sumMeasures(rows.map(row => row.output)),
    cacheRead: sumMeasures(rows.map(row => row.cacheRead)),
    cacheWrite: sumMeasures(rows.map(row => row.cacheWrite)),
    total: sumMeasures(rows.map(row => row.total)),
    cost: sumMeasures(rows.map(row => row.cost)),
  };
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function formatTokenMeasure(measure: AnalyticsMeasure | undefined): string {
  const resolved = measure ?? UNKNOWN_MEASURE;
  if (resolved.value === null) return '—';
  return NUMBER_FORMAT.format(resolved.value);
}

/** Whole dollars with exact micro precision, never a float. */
export function formatUsdMicros(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const micros = (absolute % 1_000_000n).toString().padStart(6, '0');
  const fraction = micros.replace(/0+$/, '').padEnd(2, '0');
  return `${sign}$${whole.toLocaleString('en-US')}.${fraction}`;
}

/** The exact words for an unpriced group. "Cost unknown" is a fact; `$0.00`
 * would be a lie and an empty cell would be a shrug. */
export function formatEquivalentCost(measure: AnalyticsMeasure | undefined): string {
  const resolved = measure ?? UNKNOWN_MEASURE;
  if (resolved.value === null) return 'Cost unknown';
  return formatUsdMicros(BigInt(Math.round(resolved.value)));
}

export function coverageNote(measure: AnalyticsMeasure | undefined): string | undefined {
  const resolved = measure ?? UNKNOWN_MEASURE;
  if (resolved.value !== null || resolved.total === 0) return undefined;
  return `${resolved.known}/${resolved.total}`;
}

/** `count` asks for no measures at all — the server returns null/0/0 for every
 * one — so a count result shows the two columns it actually answers rather than
 * six columns of em dashes and a cost nobody asked it to compute. */
export function analyticsColumnsFor(aggregation: string): readonly Column[] {
  if (aggregation !== 'count') return ANALYTICS_TABLE_COLUMNS;
  return ANALYTICS_TABLE_COLUMNS.filter(column => column.key === 'group' || column.key === 'sessions');
}

export interface AnalyticsSort {
  key: AnalyticsSortKey;
  direction: AnalyticsSortDirection;
}

/** Cost-descending is the default because the question is "what is expensive".
 * A count result has no cost column, so it leads with the number it does have. */
export function defaultAnalyticsSort(aggregation: string): AnalyticsSort {
  return aggregation === 'count' ? { key: 'sessions', direction: 'desc' } : { key: 'cost', direction: 'desc' };
}

/** Reconcile a reader's chosen sort with the response now on screen.
 *
 * The same mounted table serves whatever the reader runs next, and the column
 * set changes with the aggregation. A `sum` result sorted by cost, followed by a
 * `count` result, would otherwise keep sorting by a column that is not rendered:
 * no header could show `aria-sort`, and the caption would announce a sort by
 * `undefined`. A chosen sort survives only while its column is visible;
 * otherwise the current aggregation's default takes over. */
export function resolveAnalyticsSort(
  chosen: AnalyticsSort | null,
  columns: readonly Column[],
  aggregation: string,
): AnalyticsSort {
  if (chosen && columns.some(column => column.key === chosen.key)) return chosen;
  return defaultAnalyticsSort(aggregation);
}

function nextDirection(column: AnalyticsSortKey, key: AnalyticsSortKey, direction: AnalyticsSortDirection) {
  if (column !== key) return column === 'group' ? 'asc' : 'desc';
  return direction === 'desc' ? 'asc' : 'desc';
}

function MeasureCell({ measure }: { measure: AnalyticsMeasure | undefined }) {
  const coverage = coverageNote(measure);
  return (
    <td className="mono whitespace-nowrap px-cell-x py-row-y text-right tabular-nums text-fg">
      {formatTokenMeasure(measure)}
      {coverage && (
        <span className="ml-1 text-2xs text-faint" title={`known for ${coverage} sessions`}>
          [{coverage}]
        </span>
      )}
    </td>
  );
}

function CostCell({ measure }: { measure: AnalyticsMeasure }) {
  const coverage = coverageNote(measure);
  return (
    <td className="mono whitespace-nowrap px-cell-x py-row-y text-right tabular-nums">
      <span className={measure.value === null ? 'text-muted' : 'font-semibold text-fg'}>
        {formatEquivalentCost(measure)}
      </span>
      {coverage && (
        <span className="ml-1 text-2xs text-faint" title={`priced for ${coverage} sessions`}>
          [{coverage}]
        </span>
      )}
    </td>
  );
}

function Row({ row, columns, emphasis }: { row: AnalyticsTableRow; columns: readonly Column[]; emphasis?: boolean }) {
  return (
    <tr className={cn('kt-row', emphasis && 'border-t border-border font-semibold')}>
      {columns.map(column => {
        if (column.key === 'group')
          return (
            <th
              key={column.key}
              scope="row"
              className="sticky left-0 z-10 max-w-[16rem] truncate bg-surface px-cell-x py-row-y text-left font-normal text-fg"
              title={row.group}
            >
              {row.group}
            </th>
          );
        if (column.key === 'sessions')
          return (
            <td
              key={column.key}
              className="mono whitespace-nowrap px-cell-x py-row-y text-right tabular-nums text-muted"
            >
              {NUMBER_FORMAT.format(row.sessions)}
            </td>
          );
        if (column.key === 'cost') return <CostCell key={column.key} measure={row.cost} />;
        return <MeasureCell key={column.key} measure={row[column.key]} />;
      })}
    </tr>
  );
}

/** One aggregate response as a sortable ledger.
 *
 * `sum` responses also get the strict roll-up row; `avg`, `min`, `max` and
 * `count` do not, because adding those columns up would produce a number that
 * means nothing. */
export function AnalyticsResultTable({
  response,
  caption = 'Analytics aggregate result',
}: {
  response: AnalyticsAggregateResponse;
  caption?: string;
}) {
  const [sort, setSort] = useState<AnalyticsSort | null>(null);
  const columns = analyticsColumnsFor(response.aggregation);
  // The response changes under a MOUNTED table (a starter chip, a new query), so
  // the chosen sort is reconciled with the columns actually on screen rather
  // than trusted from the previous response.
  const activeSort = resolveAnalyticsSort(sort, columns, response.aggregation);
  const rows = useMemo(() => analyticsTableRows(response), [response]);
  const sorted = useMemo(
    () => sortAnalyticsRows(rows, activeSort.key, activeSort.direction),
    [activeSort.direction, activeSort.key, rows],
  );
  const total = response.aggregation === 'sum' && rows.length > 1 ? analyticsTotalRow(rows) : null;

  if (!rows.length) {
    return (
      <p className="m-0 text-cell text-muted" role="status">
        No groups matched. Nothing was assumed to be zero.
      </p>
    );
  }

  return (
    // min-w-0 on the ROOT as well as the scroller: this element is itself a grid
    // item in the cost panel, and a grid/flex item's default min-width:auto
    // would let the table's min-content width propagate straight past the
    // scroller and widen the pane.
    <div className="grid min-w-0 gap-2">
      {/* The scroller is HERE, around the table only. The pane behind it must
          never gain a horizontal scrollbar, whatever the query returns. */}
      <div className="kt-panel min-w-0 max-w-full overflow-x-auto overscroll-x-contain scroll-thin">
        <table className="w-full min-w-[44rem] border-collapse text-cell">
          <caption className="sr-only">
            {caption}. Sorted by {columns.find(column => column.key === activeSort.key)?.header}{' '}
            {activeSort.direction === 'desc' ? 'descending' : 'ascending'}.
          </caption>
          <thead>
            <tr>
              {columns.map(column => {
                const active = column.key === activeSort.key;
                const direction = nextDirection(column.key, activeSort.key, activeSort.direction);
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (activeSort.direction === 'desc' ? 'descending' : 'ascending') : 'none'}
                    className={cn(
                      'kt-label border-b border-border bg-surface-2 p-0',
                      column.key === 'group' && 'sticky left-0 z-20',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSort({ key: column.key, direction })}
                      title={column.hint}
                      aria-label={`${column.header}: sort ${direction === 'desc' ? 'descending' : 'ascending'}`}
                      className={cn(
                        // 44px is a thumb floor, not padding arithmetic.
                        'flex min-h-[44px] w-full items-center gap-1 whitespace-nowrap px-cell-x py-row-y',
                        column.numeric ? 'justify-end text-right' : 'justify-start text-left',
                        active ? 'text-accent' : 'text-muted hover:text-fg',
                      )}
                    >
                      {column.header}
                      {active ? (
                        activeSort.direction === 'desc' ? (
                          <ArrowDown size={12} aria-hidden="true" />
                        ) : (
                          <ArrowUp size={12} aria-hidden="true" />
                        )
                      ) : (
                        <ArrowDownUp size={12} className="opacity-50" aria-hidden="true" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <Row key={row.key} row={row} columns={columns} />
            ))}
          </tbody>
          {total && (
            <tfoot>
              <Row row={total} columns={columns} emphasis />
            </tfoot>
          )}
        </table>
      </div>
      {/* The footnote explains a column. A count result has no cost column, so
          printing it there would explain something the reader cannot see. */}
      {columns.some(column => column.key === 'cost') && (
        <p className="m-0 text-2xs leading-base text-faint">{equivalentCostFootnote()}</p>
      )}
    </div>
  );
}
