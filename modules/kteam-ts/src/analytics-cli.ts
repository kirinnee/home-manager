import type { AnalyticsMeasure, AnalyticsResponse } from './analytics-types';

const DASH = '—';

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

function measure(value: AnalyticsMeasure, format: (number: number) => string): string {
  if (value.value !== null) return format(value.value);
  if (value.known === 0) return DASH;
  return `${DASH}[${value.known}/${value.total}]`;
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
      : ['GROUP', 'SESSIONS', 'TOKENS', 'TURNS', 'DURATION', 'TTFO', 'CTX END', 'STALL', 'FAIL', 'DONE'];
    const rows = response.results.map(result => {
      const rates = [percent(result.rates.stall), percent(result.rates.failure), percent(result.rates.completion)];
      if (countOnly) return [groupLabel(result.labels), String(result.sessions), ...rates];
      return [
        groupLabel(result.labels),
        String(result.sessions),
        measure(result.tokens, compactNumber),
        measure(result.turns, compactNumber),
        measure(result.durationMs, duration),
        measure(result.timeToFirstOutputMs, duration),
        measure(result.contextEndPercent, percent),
        ...rates,
      ];
    });
    lines.push(rows.length ? renderTable(header, rows) : 'No sessions match the query.');
  } else {
    const header = ['ID', 'STATUS', 'MODEL', 'WRAPPER', 'LABEL', 'TOKENS', 'TURNS', 'DURATION'];
    const rows = response.results.map(result => [
      result.id,
      result.status ?? DASH,
      result.model ?? DASH,
      result.wrapper ?? DASH,
      result.label ?? DASH,
      result.tokens === null ? DASH : compactNumber(result.tokens),
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
  return `${lines.join('\n')}\n`;
}
