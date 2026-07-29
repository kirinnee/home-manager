// GLOBAL ANALYTICS — the fleet-wide query destination.
//
// This is deliberately a separate route from the session side pane. One query
// owns the charts and table together: changing it clears both, runs once, and
// renders both from the same response. No mode switch can make the session pane
// drift back into fleet scope.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChartNoAxesCombined, Loader2 } from 'lucide-react';
import type { AnalyticsResponse } from '../../../src/analytics-types';
import { AnalyticsQueryAutocomplete } from '../components/AnalyticsQueryAutocomplete';
import { AnalyticsResponseView, analyticsErrorMessage, type AnalyticsStarter } from '../components/AnalyticsSurface';
import { AnalyticsTimeSeries } from '../components/AnalyticsTimeSeries';
import { api } from '../lib/api';

export const GLOBAL_ANALYTICS_DEFAULT_QUERY = 'sum by (day)';

export const GLOBAL_ANALYTICS_STARTERS: readonly AnalyticsStarter[] = [
  {
    id: 'daily',
    label: 'Daily',
    query: GLOBAL_ANALYTICS_DEFAULT_QUERY,
    hint: 'Sessions, tokens, and equivalent API cost per UTC day.',
  },
  {
    id: 'weekly',
    label: 'Weekly',
    query: 'sum by (week)',
    hint: 'The same ledger rolled up by ISO week.',
  },
  {
    id: 'models',
    label: 'By model',
    query: 'sum by (model)',
    hint: 'Fleet token and equivalent API cost totals by attributed model.',
  },
  {
    id: 'average',
    label: 'Average',
    query: 'avg by (model)',
    hint: 'Average measures per session, grouped by model.',
  },
  {
    id: 'maximum',
    label: 'Maximum',
    query: 'max by (model)',
    hint: 'Largest per-session measures in each model group.',
  },
  {
    id: 'status',
    label: 'Status count',
    query: 'count by (status)',
    hint: 'Session counts only; no token or cost measures.',
  },
];

export function GlobalAnalyticsPage() {
  const queryId = useId();
  const [query, setQuery] = useState(GLOBAL_ANALYTICS_DEFAULT_QUERY);
  const [result, setResult] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(true);
  const requestSerial = useRef(0);

  const runQuery = useCallback(async (source: string) => {
    const serial = ++requestSerial.current;
    setQuerying(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.analytics(source.trim() || undefined);
      if (serial !== requestSerial.current) return;
      setQuery(response.query);
      setResult(response);
    } catch (reason) {
      if (serial === requestSerial.current) setError(analyticsErrorMessage(reason));
    } finally {
      if (serial === requestSerial.current) setQuerying(false);
    }
  }, []);

  useEffect(() => {
    void runQuery(GLOBAL_ANALYTICS_DEFAULT_QUERY);
    return () => {
      requestSerial.current += 1;
    };
  }, [runQuery]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin">
      <div className="mx-auto grid w-full max-w-[1500px] min-w-0 gap-4 px-2 pb-8 pt-3 sm:px-5 sm:pt-5">
        <header className="relative overflow-hidden rounded-panel border-panel border-border-strong bg-surface-2 px-4 py-4 shadow-panel sm:px-5">
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-1 bg-accent shadow-[8px_0_0_var(--border-soft)]"
          />
          <div className="relative grid gap-2 pl-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="min-w-0">
              <p className="mono m-0 text-2xs uppercase tracking-[0.18em] text-accent">Fleet ledger / all sessions</p>
              <h1 className="m-0 mt-1 font-display text-2xl font-semibold leading-tight text-fg">Global analytics</h1>
              <p className="m-0 mt-1 max-w-[68ch] text-cell leading-base text-muted">
                Query every indexed session. The daily default drives the three graphs and the ledger below from one
                response; cached reads and writes retain their harness-specific public API rates.
              </p>
            </div>
            <div className="flex items-center gap-2 border-t border-border-soft pt-2 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <ChartNoAxesCombined size={18} className="text-accent" aria-hidden="true" />
              <div>
                <span className="kt-label block">Default query</span>
                <span className="mono text-cell text-fg">{GLOBAL_ANALYTICS_DEFAULT_QUERY}</span>
              </div>
            </div>
          </div>
        </header>

        <section aria-labelledby="global-analytics-query" className="grid min-w-0 gap-3">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="global-analytics-query" className="kt-label m-0 text-fg-soft">
              Query the fleet
            </h2>
            <p className="m-0 text-meta text-muted">UTC calendar buckets · archived and active sessions</p>
          </header>

          <div
            className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin"
            aria-label="Query starters"
          >
            {GLOBAL_ANALYTICS_STARTERS.map(starter => (
              <button
                key={starter.id}
                type="button"
                className="kt-btn min-h-[44px] shrink-0 text-xs"
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
              Global analytics query
            </label>
            <AnalyticsQueryAutocomplete
              inputId={queryId}
              value={query}
              onValueChange={setQuery}
              onRun={() => void runQuery(query)}
              disabled={querying}
              placeholder={GLOBAL_ANALYTICS_DEFAULT_QUERY}
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

          <div aria-live="polite" aria-busy={querying} className="grid min-w-0 gap-4">
            {querying && (
              <p role="status" className="m-0 py-6 text-center text-cell text-muted">
                Reading the fleet ledger…
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="m-0 rounded-control border border-err/40 bg-err/10 px-3 py-2 text-cell text-err"
              >
                Analytics could not load: {error} Unknown data was not treated as zero.
              </p>
            )}
            {result?.kind === 'aggregate' && <AnalyticsTimeSeries response={result} />}
            {result && <AnalyticsResponseView response={result} />}
          </div>

          {result && (
            <p className="m-0 text-2xs text-faint">
              Index: {result.index.tokenSessions} token-complete of {result.index.sessions};{' '}
              {result.index.pendingTranscriptSources} source
              {result.index.pendingTranscriptSources === 1 ? '' : 's'} pending
              {result.index.refreshing ? ' (backfill in progress)' : ''}. Equivalent API cost compares public API rates;
              it is never subscription spend.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
