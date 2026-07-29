// SESSION ANALYTICS — one editable query and the result it owns.
//
// There is intentionally no independent cost summary above this surface. The
// default query IS the normal view; changing it replaces every value below.
// This surface forces the exact session id through the shared query parser
// before transport, so deleting or replacing the visible matcher can never
// turn this side pane into a fleet query. The API can independently enforce
// the same rule for callers that supply its `session` parameter.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AnalyticsRawSession, AnalyticsResponse } from '../../../src/analytics-types';
import { scopeAnalyticsQuery } from '../../../src/analytics-query';
import { api, ApiError } from '../lib/api';
import { AnalyticsQueryAutocomplete } from './AnalyticsQueryAutocomplete';
import { AnalyticsResultTable, formatUsdMicros } from './AnalyticsResultTable';

export interface AnalyticsStarter {
  id: string;
  label: string;
  query: string;
  hint: string;
}

export function analyticsErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503)
    return 'Analytics index is unavailable while the daemon catches up (503).';
  if (error instanceof Error) return error.message;
  return String(error);
}

/** JSON quoting is the analytics grammar's quoted-string escape mechanism. */
export function analyticsIdQuery(id: string): string {
  // `==` keeps literal glob characters exact; ordinary IDs retain the compact
  // long-standing `=` spelling.
  const operator = /[*?]/.test(id) ? '==' : '=';
  return `{id${operator}${JSON.stringify(id)}}`;
}

/** The visible default demonstrates all three language pieces in one line:
 * aggregation, grouping, and an exact matcher. `sum` returns the full token
 * ledger and equivalent API cost rather than the measure-free count view. */
export function sessionAnalyticsDefaultQuery(sessionId: string): string {
  return `sum by (model) ${analyticsIdQuery(sessionId)}`;
}

/** Every long-standing aggregation is visible without documentation hunting.
 * A starter always writes the real editable query into the same box; it never
 * opens a second result surface. */
export function sessionAnalyticsStarterQueries(sessionId: string): AnalyticsStarter[] {
  const scope = analyticsIdQuery(sessionId);
  return [
    {
      id: 'sum',
      label: 'sum',
      query: `sum by (model) ${scope}`,
      hint: 'Total tokens and equivalent API cost, grouped by attributed model.',
    },
    {
      id: 'avg',
      label: 'avg',
      query: `avg by (model) ${scope}`,
      hint: 'Average measures for this session (useful when adding another grouping dimension globally).',
    },
    { id: 'min', label: 'min', query: `min by (model) ${scope}`, hint: 'Minimum known measures.' },
    { id: 'max', label: 'max', query: `max by (model) ${scope}`, hint: 'Maximum known measures.' },
    {
      id: 'count',
      label: 'count',
      query: `count by (status) ${scope}`,
      hint: 'Session count only; count deliberately has no token or cost measures.',
    },
  ];
}

/** Defense in depth: canonicalize the visible query here, then send the exact
 * session separately so the API server replaces the matcher again at its own
 * boundary. The global page omits that parameter and remains fleet-wide. */
export function querySessionAnalytics(sessionId: string, query?: string): Promise<AnalyticsResponse> {
  return api.sessionAnalytics(sessionId, scopeAnalyticsQuery(query, sessionId));
}

function rawEquivalentCost(row: AnalyticsRawSession): string {
  const value = row.equivalentApiCostUsdMicros;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? formatUsdMicros(BigInt(value))
    : 'Cost unknown';
}

/** Shared response renderer for the session query and the separate global
 * page. It renders exactly one response and never derives a competing total. */
export function AnalyticsResponseView({ response }: { response: AnalyticsResponse }) {
  const scope = (
    <p className="m-0 text-meta text-muted">
      {response.scope.matched} matched · {response.scope.indexed} indexed
    </p>
  );
  if (response.kind === 'aggregate') {
    return (
      <div className="grid min-w-0 gap-xs">
        {scope}
        <AnalyticsResultTable response={response} caption={`Result for ${response.query}`} />
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-xs">
      {scope}
      {response.truncated && (
        <p role="status" className="m-0 text-meta text-warn">
          Showing the server-capped result; this query is truncated.
        </p>
      )}
      {response.results.length === 0 ? (
        <p className="m-0 rounded-control border border-border-soft bg-surface px-3 py-3 text-cell text-muted">
          No indexed session matched this query.
        </p>
      ) : (
        response.results.map(row => (
          <div
            key={row.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-control border border-border-soft bg-surface px-3 py-2 text-cell"
          >
            <span className="mono truncate text-2xs text-accent">{row.id}</span>
            <span className="text-right font-medium text-fg">{rawEquivalentCost(row)}</span>
            <span className="text-muted">
              {row.status ?? 'status unknown'} · {row.tokens ?? 'tokens unknown'} tokens
            </span>
            <span className="text-right text-2xs text-faint">Equivalent API cost</span>
          </div>
        ))
      )}
    </div>
  );
}

/** The scrolling content only. SidePane owns the titlebar and close chrome. */
export function AnalyticsSurface({ sessionId }: { sessionId: string }) {
  const queryId = useId();
  const defaultQuery = sessionAnalyticsDefaultQuery(sessionId);
  const starters = useMemo(() => sessionAnalyticsStarterQueries(sessionId), [sessionId]);
  const treeSuggestions = useMemo(() => [{ id: sessionId, detail: 'this session' }], [sessionId]);
  const [query, setQuery] = useState(defaultQuery);
  const [result, setResult] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(true);
  const requestSerial = useRef(0);

  const runQuery = useCallback(
    async (source: string) => {
      const serial = ++requestSerial.current;
      setQuerying(true);
      setError(null);
      setResult(null);
      try {
        const response = await querySessionAnalytics(sessionId, source.trim() || undefined);
        if (serial !== requestSerial.current) return;
        // The server returns the enforced, canonical matcher. Showing it makes
        // the executed scope inspectable even if the reader removed it.
        setQuery(response.query);
        setResult(response);
      } catch (reason) {
        if (serial === requestSerial.current) setError(analyticsErrorMessage(reason));
      } finally {
        if (serial === requestSerial.current) setQuerying(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setQuery(defaultQuery);
    void runQuery(defaultQuery);
    return () => {
      requestSerial.current += 1;
    };
  }, [defaultQuery, runQuery]);

  const loadSessionValues = useCallback(
    async (label: string): Promise<readonly string[]> => {
      const response = await querySessionAnalytics(sessionId, `count by (${label})`);
      if (response.kind !== 'aggregate') return [];
      return [
        ...new Set(
          response.results
            .map(row => row.labels[label])
            .filter((value): value is string => typeof value === 'string' && value.length > 0),
        ),
      ].sort();
    },
    [sessionId],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-4 pt-3 scroll-thin">
      <section aria-labelledby="session-analytics-query" className="grid min-w-0 gap-3">
        <header className="grid gap-1 border-l-2 border-accent pl-3">
          <h3 id="session-analytics-query" className="kt-label m-0">
            Query this session
          </h3>
          <p className="m-0 text-meta leading-base text-muted">
            Always constrained to <span className="mono text-fg-soft">{sessionId}</span>. The default{' '}
            <span className="mono">sum by (model)</span> returns tokens and equivalent API cost; the chips expose every
            aggregate supported by the language.
          </p>
        </header>

        <div className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin" aria-label="Aggregations">
          {starters.map(starter => (
            <button
              key={starter.id}
              type="button"
              className="kt-btn min-h-[44px] shrink-0 font-mono text-xs"
              title={starter.hint}
              onClick={() => {
                setQuery(starter.query);
                void runQuery(starter.query);
              }}
              disabled={querying}
            >
              {starter.label}
            </button>
          ))}
        </div>

        <form
          className="flex min-w-0 gap-2"
          onSubmit={event => {
            event.preventDefault();
            void runQuery(query);
          }}
        >
          <label htmlFor={queryId} className="sr-only">
            Session analytics query
          </label>
          <AnalyticsQueryAutocomplete
            inputId={queryId}
            value={query}
            onValueChange={setQuery}
            onRun={() => void runQuery(query)}
            disabled={querying}
            sources={{ treeIds: treeSuggestions }}
            loadValues={loadSessionValues}
            placeholder="sum by (model)"
          />
          <button type="submit" className="kt-btn min-h-[44px] shrink-0" disabled={querying}>
            {querying ? (
              <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              'Run'
            )}
            {querying && <span className="sr-only">Running query</span>}
          </button>
        </form>

        <div aria-live="polite" aria-busy={querying} className="grid min-w-0 gap-xs">
          {querying && (
            <p role="status" className="m-0 py-3 text-cell text-muted">
              Reading this session’s indexed ledger…
            </p>
          )}
          {error && (
            <p role="alert" className="m-0 text-meta text-err">
              {error} Cost remains unknown; no zero was assumed.
            </p>
          )}
          {result && <AnalyticsResponseView response={result} />}
        </div>

        {result && (
          <p className="m-0 text-2xs text-faint">
            Index: {result.index.tokenSessions} token-complete of {result.index.sessions};{' '}
            {result.index.pendingTranscriptSources} source
            {result.index.pendingTranscriptSources === 1 ? '' : 's'} pending
            {result.index.refreshing ? ' (backfill in progress)' : ''}.
          </p>
        )}
      </section>
    </div>
  );
}
