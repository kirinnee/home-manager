export const ANALYTICS_AGGREGATIONS = ['sum', 'avg', 'min', 'max', 'count'] as const;
export type AnalyticsAggregation = (typeof ANALYTICS_AGGREGATIONS)[number];

/**
 * Fleet labels exposed by the PromQL-like query language. `binary` and `repo`
 * are compatibility/readability aliases for `wrapper` and `cwd` respectively;
 * the result keeps the spelling the caller used.
 */
export const ANALYTICS_LABELS = [
  'wrapper',
  'binary',
  'model',
  'harness',
  'mode',
  'status',
  'label',
  'cwd',
  'repo',
  'parent',
  'day',
  'week',
  'token_data',
] as const;
export type AnalyticsLabel = (typeof ANALYTICS_LABELS)[number];

export interface AnalyticsMatcher {
  label: AnalyticsLabel;
  op: '=' | '=~';
  value: string;
  /** `=~` and glob-bearing `=` match case-insensitively, like kloop metrics. */
  wildcard: boolean;
}

export interface ParsedAnalyticsQuery {
  source: string;
  canonical: string;
  aggregation?: AnalyticsAggregation;
  groupBy: AnalyticsLabel[];
  matchers: AnalyticsMatcher[];
}

/** A measure is reported only when every matched session has a value. Count
 *  aggregation does not request measures and returns null/0/0 for each one. */
export interface AnalyticsMeasure {
  value: number | null;
  known: number;
  total: number;
}

export interface AnalyticsRates {
  stall: number;
  failure: number;
  completion: number;
}

export interface AnalyticsAggregateResult {
  labels: Record<string, string | null>;
  sessions: number;
  rates: AnalyticsRates;
  tokens: AnalyticsMeasure;
  inputTokens: AnalyticsMeasure;
  outputTokens: AnalyticsMeasure;
  cachedInputTokens: AnalyticsMeasure;
  cacheWriteInputTokens: AnalyticsMeasure;
  turns: AnalyticsMeasure;
  durationMs: AnalyticsMeasure;
  timeToFirstOutputMs: AnalyticsMeasure;
  contextEndPercent: AnalyticsMeasure;
}

export interface AnalyticsRawSession {
  id: string;
  wrapper: string | null;
  model: string | null;
  harness: string | null;
  mode: string | null;
  status: string | null;
  label: string | null;
  cwd: string | null;
  parent: string | null;
  day: string | null;
  week: string | null;
  createdAt: string | null;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  turns: number | null;
  durationMs: number | null;
  timeToFirstOutputMs: number | null;
  contextEndPercent: number | null;
  stalled: boolean;
  failed: boolean;
  completed: boolean;
}

export interface AnalyticsIndexStatus {
  schemaVersion: number;
  sessions: number;
  tokenSessions: number;
  transcriptSources: number;
  indexedTranscriptSources: number;
  pendingTranscriptSources: number;
  sourceErrors: number;
  refreshing: boolean;
  lastTokenRefreshAt?: string;
}

interface AnalyticsResponseBase {
  query: string;
  parsed: {
    aggregation?: AnalyticsAggregation;
    groupBy: AnalyticsLabel[];
    matchers: AnalyticsMatcher[];
  };
  scope: {
    /** Explicit reminder that archived/terminal history is in scope. */
    allSessions: true;
    indexed: number;
    matched: number;
  };
  index: AnalyticsIndexStatus;
}

export interface AnalyticsAggregateResponse extends AnalyticsResponseBase {
  kind: 'aggregate';
  aggregation: AnalyticsAggregation;
  results: AnalyticsAggregateResult[];
}

export interface AnalyticsRawResponse extends AnalyticsResponseBase {
  kind: 'raw';
  limit: number;
  truncated: boolean;
  results: AnalyticsRawSession[];
}

export type AnalyticsResponse = AnalyticsAggregateResponse | AnalyticsRawResponse;

export interface AnalyticsQueryService {
  query(source?: string): AnalyticsResponse;
}

export interface AnalyticsRefreshResult {
  sources: number;
  bytes: number;
  pending: number;
  errors: number;
}
