import type { AnalyticsMeasure, AnalyticsResponse } from './analytics-types';
import { EQUIVALENT_API_COST_CAVEAT, PRICING_REGISTRY_VERIFIED_AT } from './model-cost';

const DASH = '—';
const UNKNOWN = 'unknown';

function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (absolute < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  if (absolute < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  return `${(value / 1_000_000_000).toFixed(1)}b`;
}

function duration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function percent(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function usdMicros(value: number): string {
  const dollars = value / 1_000_000;
  const decimals = Math.abs(dollars) >= 10 ? 2 : Math.abs(dollars) >= 0.1 ? 3 : 4;
  return `$${dollars.toFixed(decimals)}`;
}

function measure(value: AnalyticsMeasure, format: (number: number) => string): string {
  if (value.value !== null) return format(value.value);
  if (value.known === 0) return DASH;
  return `${DASH}[${value.known}/${value.total}]`;
}

/** Cost unknowns stay explicit: zero priced rows is materially different from
 * a zero-dollar result, and raw rows have no known/total measure to annotate. */
function equivalentCost(value: AnalyticsMeasure | undefined): string {
  if (!value) return UNKNOWN;
  return value.value === null ? `${DASH}[${value.known}/${value.total}]` : usdMicros(value.value);
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ');
  return [line(header), line(widths.map(width => '─'.repeat(width))), ...rows.map(line)].join('\n');
}

function groupLabel(labels: Record<string, string | null>): string {
  const entries = Object.entries(labels);
  return entries.length ? entries.map(([label, value]) => `${label}=${value ?? DASH}`).join(', ') : 'all';
}

/** Render the stable, no-colour terminal form; JSON callers receive the API object verbatim. */
export function renderAnalytics(response: AnalyticsResponse): string {
  const lines = [
    `All sessions: ${response.scope.indexed} indexed, ${response.scope.matched} matched`,
    `Query: ${response.query}`,
    '',
  ];
  if (response.kind === 'aggregate') {
    const countOnly = response.aggregation === 'count';
    const header = countOnly
      ? ['GROUP', 'SESSIONS', 'STALL', 'FAIL', 'DONE']
      : [
          'GROUP',
          'SESSIONS',
          'INPUT',
          'OUTPUT',
          'CACHE READ',
          'CACHE WRITE',
          'TOTAL',
          'EQUIV API COST',
          'TURNS',
          'DURATION',
          'TTFO',
          'CTX END',
          'STALL',
          'FAIL',
          'DONE',
        ];
    const results = countOnly
      ? response.results
      : [...response.results].sort((left, right) => {
          const leftCost = left.equivalentApiCostUsdMicros?.value ?? null;
          const rightCost = right.equivalentApiCostUsdMicros?.value ?? null;
          if (leftCost === null) return rightCost === null ? 0 : 1;
          if (rightCost === null) return -1;
          return rightCost - leftCost;
        });
    const rows = results.map(result => {
      const rates = [percent(result.rates.stall), percent(result.rates.failure), percent(result.rates.completion)];
      if (countOnly) return [groupLabel(result.labels), String(result.sessions), ...rates];
      return [
        groupLabel(result.labels),
        String(result.sessions),
        measure(result.inputTokens, compactNumber),
        measure(result.outputTokens, compactNumber),
        measure(result.cachedInputTokens, compactNumber),
        measure(result.cacheWriteInputTokens, compactNumber),
        measure(result.tokens, compactNumber),
        equivalentCost(result.equivalentApiCostUsdMicros),
        measure(result.turns, compactNumber),
        measure(result.durationMs, duration),
        measure(result.timeToFirstOutputMs, duration),
        measure(result.contextEndPercent, percent),
        ...rates,
      ];
    });
    lines.push(rows.length ? renderTable(header, rows) : 'No sessions match the query.');
  } else {
    const header = ['ID', 'STATUS', 'MODEL', 'WRAPPER', 'LABEL', 'TOKENS', 'EQUIV API COST', 'TURNS', 'DURATION'];
    const rows = response.results.map(result => [
      result.id,
      result.status ?? DASH,
      result.model ?? DASH,
      result.wrapper ?? DASH,
      result.label ?? DASH,
      result.tokens === null ? DASH : compactNumber(result.tokens),
      result.equivalentApiCostUsdMicros === null || result.equivalentApiCostUsdMicros === undefined
        ? UNKNOWN
        : usdMicros(result.equivalentApiCostUsdMicros),
      result.turns === null ? DASH : compactNumber(result.turns),
      result.durationMs === null ? DASH : duration(result.durationMs),
    ]);
    lines.push(rows.length ? renderTable(header, rows) : 'No sessions match the query.');
    if (response.truncated)
      lines.push('', `Showing ${response.limit} of ${response.scope.matched} rows; add a filter.`);
  }

  const pending = response.index.pendingTranscriptSources;
  lines.push(
    '',
    `Token index: ${response.index.tokenSessions}/${response.index.sessions} sessions known; ` +
      `${response.index.indexedTranscriptSources}/${response.index.transcriptSources} transcript sources indexed` +
      `${pending ? ` (${pending} pending)` : ''}${response.index.sourceErrors ? `, ${response.index.sourceErrors} errors` : ''}.`,
  );
  if (response.index.refreshing) lines.push('Token backfill is running in the daemon.');
  lines.push(`${DASH}[known/total] means the group is incomplete; kteam does not substitute zero or a partial value.`);
  lines.push(EQUIVALENT_API_COST_CAVEAT);
  lines.push(`Rates verified ${PRICING_REGISTRY_VERIFIED_AT}.`);
  return `${lines.join('\n')}\n`;
}
