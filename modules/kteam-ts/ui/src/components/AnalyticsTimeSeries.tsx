// SELF-CONTAINED ANALYTICS CHARTS — no CDN, canvas, font, or chart runtime.
//
// Three small multiples deliberately use independent scales. Sessions and
// tokens differ by orders of magnitude; a shared axis would flatten the former
// into decoration. On a 390px screen the charts stack and keep the page at one
// width. The full query result remains in AnalyticsResultTable; SVG draws only
// the newest bounded window so hundreds of daily points never turn into a
// sideways page.

import type { AnalyticsAggregateResponse } from '../../../src/analytics-types';
import { formatUsdMicros } from './AnalyticsResultTable';

export const MAX_ANALYTICS_CHART_POINTS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface AnalyticsTimePoint {
  bucket: string;
  sessions: number | null;
  tokens: number | null;
  equivalentApiCostUsdMicros: number | null;
}

export interface AnalyticsTimeSeriesData {
  dimension: 'day' | 'week';
  points: AnalyticsTimePoint[];
  omittedUntimed: number;
}

/** A chart is a faithful projection only for one temporal grouping and `sum`.
 * Summing model-grouped averages or silently dropping a second dimension would
 * draw a confident lie, so those queries keep their table and get a clear hint. */
export function analyticsTimeSeriesData(response: AnalyticsAggregateResponse): AnalyticsTimeSeriesData | null {
  const groups = response.parsed.groupBy;
  if (response.aggregation !== 'sum' || groups.length !== 1 || (groups[0] !== 'day' && groups[0] !== 'week'))
    return null;
  const dimension = groups[0];
  const points: AnalyticsTimePoint[] = [];
  let omittedUntimed = 0;
  for (const result of response.results) {
    const bucket = result.labels[dimension];
    if (typeof bucket !== 'string' || bucket.length === 0) {
      omittedUntimed += 1;
      continue;
    }
    const cost = result.equivalentApiCostUsdMicros;
    points.push({
      bucket,
      sessions: result.sessions,
      tokens: result.tokens.value,
      equivalentApiCostUsdMicros: cost?.value ?? null,
    });
  }
  points.sort((left, right) => left.bucket.localeCompare(right.bucket));
  return { dimension, points, omittedUntimed };
}

export function latestAnalyticsTimePoints(
  points: readonly AnalyticsTimePoint[],
  limit = MAX_ANALYTICS_CHART_POINTS,
  dimension?: AnalyticsTimeSeriesData['dimension'],
): AnalyticsTimePoint[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : MAX_ANALYTICS_CHART_POINTS;
  if (dimension !== 'day' || points.length === 0) return points.slice(Math.max(0, points.length - boundedLimit));

  const dated = points
    .map(point => ({ point, time: utcDay(point.bucket) }))
    .sort((left, right) => (left.time ?? 0) - (right.time ?? 0));
  if (dated.some(entry => entry.time === null)) return points.slice(Math.max(0, points.length - boundedLimit));

  const first = dated[0]!.time!;
  const last = dated.at(-1)!.time!;
  const start = Math.max(first, last - (boundedLimit - 1) * DAY_MS);
  const byBucket = new Map(points.map(point => [point.bucket, point]));
  const window: AnalyticsTimePoint[] = [];
  for (let time = start; time <= last; time += DAY_MS) {
    const bucket = new Date(time).toISOString().slice(0, 10);
    window.push(
      byBucket.get(bucket) ?? {
        bucket,
        sessions: null,
        tokens: null,
        equivalentApiCostUsdMicros: null,
      },
    );
  }
  return window;
}

/** Count the calendar domain without allocating every historical bucket. */
export function analyticsTimeDomainSize(
  points: readonly AnalyticsTimePoint[],
  dimension: AnalyticsTimeSeriesData['dimension'],
): number {
  if (dimension !== 'day' || points.length === 0) return points.length;
  const times = points.map(point => utcDay(point.bucket));
  if (times.some(time => time === null)) return points.length;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const time of times as number[]) {
    first = Math.min(first, time);
    last = Math.max(last, time);
  }
  return Math.floor((last - first) / DAY_MS) + 1;
}

function utcDay(bucket: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return null;
  const time = Date.parse(`${bucket}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === bucket ? time : null;
}

export interface ChartPoint {
  x: number;
  y: number;
}

/** Split at unknowns. Connecting the values on either side would visually
 * claim the missing bucket had a known value somewhere along that line. */
export function analyticsLineSegments(
  values: readonly (number | null)[],
  width: number,
  height: number,
): ChartPoint[][] {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const maximum = Math.max(1, ...known);
  const x = (index: number) => (values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width);
  const y = (value: number) => height - (Math.max(0, value) / maximum) * height;
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: x(index), y: y(value) });
  });
  if (current.length) segments.push(current);
  return segments;
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function compactNumber(value: number): string {
  return COMPACT.format(value);
}

function cost(value: number): string {
  return formatUsdMicros(BigInt(Math.round(value)));
}

interface MetricSpec {
  id: string;
  title: string;
  color: string;
  values: (point: AnalyticsTimePoint) => number | null;
  format: (value: number) => string;
}

const METRICS: readonly MetricSpec[] = [
  {
    id: 'sessions',
    title: 'Sessions',
    color: 'var(--accent)',
    values: point => point.sessions,
    format: value => new Intl.NumberFormat('en-US').format(value),
  },
  { id: 'tokens', title: 'Tokens', color: 'var(--ok)', values: point => point.tokens, format: compactNumber },
  {
    id: 'cost',
    title: 'Equivalent API cost',
    color: 'var(--warn)',
    values: point => point.equivalentApiCostUsdMicros,
    format: cost,
  },
];

function MetricChart({
  metric,
  points,
  unit,
}: {
  metric: MetricSpec;
  points: readonly AnalyticsTimePoint[];
  unit: string;
}) {
  const values = points.map(metric.values);
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const latest = [...values].reverse().find((value): value is number => value !== null && Number.isFinite(value));
  const maximum = known.length ? Math.max(...known) : null;
  const scaleMaximum = Math.max(1, ...(known.length ? known : [1]));
  const unknown = values.length - known.length;
  const plot = { left: 10, top: 12, width: 300, height: 84 };
  const segments = analyticsLineSegments(values, plot.width, plot.height);
  const first = points[0]?.bucket ?? '—';
  const middle = points[Math.floor((points.length - 1) / 2)]?.bucket ?? first;
  const last = points.at(-1)?.bucket ?? first;
  const titleId = `analytics-chart-${metric.id}`;

  return (
    <section className="min-w-0 overflow-hidden rounded-panel border-panel border-border-strong bg-surface shadow-panel">
      <header className="flex min-h-[52px] items-start gap-3 border-b border-border-soft bg-surface-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="kt-label m-0 truncate">
            {metric.title} / {unit}
          </h3>
          <p className="m-0 text-2xs text-faint">Latest known bucket</p>
        </div>
        <strong className="mono shrink-0 text-ui text-fg">
          {latest === undefined ? 'Unknown' : metric.format(latest)}
        </strong>
      </header>
      <svg
        viewBox="0 0 320 124"
        className="block h-auto w-full"
        role="img"
        aria-labelledby={titleId}
        preserveAspectRatio="xMidYMid meet"
      >
        <desc>
          {metric.title} per {unit} from {first} through {last}. {unknown} unknown{' '}
          {unknown === 1 ? 'bucket' : 'buckets'}
          render as gaps.
        </desc>
        {[0, 0.5, 1].map(position => (
          <line
            key={position}
            x1={plot.left}
            x2={plot.left + plot.width}
            y1={plot.top + plot.height * position}
            y2={plot.top + plot.height * position}
            stroke="var(--border-soft)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {segments.map((segment, index) => (
          <polyline
            key={index}
            points={segment.map(point => `${plot.left + point.x},${plot.top + point.y}`).join(' ')}
            fill="none"
            stroke={metric.color}
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {values.map((value, index) => {
          if (value === null || !Number.isFinite(value)) return null;
          const x = values.length <= 1 ? plot.width / 2 : (index / (values.length - 1)) * plot.width;
          const y = plot.height - (Math.max(0, value) / scaleMaximum) * plot.height;
          return <circle key={index} cx={plot.left + x} cy={plot.top + y} r="2" fill={metric.color} />;
        })}
        <text x={plot.left} y="117" fill="var(--fg-faint)" fontSize="8" textAnchor="start">
          {first}
        </text>
        <text x="160" y="117" fill="var(--fg-faint)" fontSize="8" textAnchor="middle">
          {middle}
        </text>
        <text x={plot.left + plot.width} y="117" fill="var(--fg-faint)" fontSize="8" textAnchor="end">
          {last}
        </text>
      </svg>
      <footer className="flex items-center gap-2 border-t border-border-soft px-3 py-1.5 text-2xs text-muted">
        <span>Peak {maximum === null ? 'unknown' : metric.format(maximum)}</span>
        <span aria-hidden="true">·</span>
        <span className={unknown ? 'text-warn' : undefined}>
          {unknown} unknown {unknown === 1 ? 'bucket' : 'buckets'}
        </span>
      </footer>
    </section>
  );
}

export function AnalyticsTimeSeries({ response }: { response: AnalyticsAggregateResponse }) {
  const series = analyticsTimeSeriesData(response);
  if (!series)
    return (
      <p className="m-0 rounded-control border border-border-soft bg-surface px-3 py-2 text-cell text-muted">
        Charts follow <span className="mono text-fg">sum by (day)</span> or{' '}
        <span className="mono text-fg">sum by (week)</span>. This query remains fully available in the table.
      </p>
    );
  if (series.points.length === 0)
    return (
      <p className="m-0 rounded-control border border-border-soft bg-surface px-3 py-2 text-cell text-muted">
        No dated groups matched this query. Undated groups remain in the table.
      </p>
    );
  // Build the real daily calendar domain before bounding the graph. A missing
  // date is an explicit gap, never a line that visually shortens time.
  const points = latestAnalyticsTimePoints(series.points, MAX_ANALYTICS_CHART_POINTS, series.dimension);
  const totalBuckets = analyticsTimeDomainSize(series.points, series.dimension);
  const noun = series.dimension === 'day' ? 'daily' : 'weekly';
  return (
    <section aria-labelledby="analytics-time-series" className="grid min-w-0 gap-2">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="analytics-time-series" className="kt-label m-0 text-fg-soft">
          Time series
        </h2>
        <p className="m-0 text-meta text-muted">
          Latest {points.length} of {totalBuckets} {noun} buckets · independent scales
        </p>
      </header>
      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-3">
        {METRICS.map(metric => (
          <MetricChart key={metric.id} metric={metric} points={points} unit={series.dimension} />
        ))}
      </div>
      {series.omittedUntimed > 0 && (
        <p className="m-0 text-meta text-warn">
          {series.omittedUntimed} undated {series.omittedUntimed === 1 ? 'group is' : 'groups are'} table-only; no time
          position was invented.
        </p>
      )}
    </section>
  );
}
