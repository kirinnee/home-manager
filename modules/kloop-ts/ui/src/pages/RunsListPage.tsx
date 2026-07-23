import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { openReloadStream } from '../lib/sse';
import { fmtAgo, fmtDur } from '../lib/format';
import { Link } from '../lib/router';
import { RunStatusBadge } from '../components/Bits';
import type { RunListItem } from '../types';

export function RunsListPage() {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listRuns()
      .then(r => {
        setRuns(r);
        setErr(null);
      })
      .catch(e => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
    return openReloadStream(load);
  }, [load]);

  if (err) return <p className="text-sm text-err">{err}</p>;
  if (!runs) return <Skeleton />;
  if (runs.length === 0) return <p className="text-sm text-muted">No kloop runs yet.</p>;

  const running = runs.filter(r => r.status === 'running');
  const rest = runs.filter(r => r.status !== 'running');
  const ordered = [...running, ...rest];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-base font-semibold tracking-tight">Runs</h1>
        <span className="text-xs text-muted">
          {running.length} running · {runs.length} total
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-border-soft rounded-md border border-border bg-surface">
        {ordered.map(r => (
          <li key={r.id}>
            <Link
              to={`/run/${encodeURIComponent(r.id)}`}
              className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2"
            >
              <RunStatusBadge status={r.status} />
              <span className="font-mono text-[13px] text-fg">{r.id}</span>
              <span className="truncate text-xs text-muted" title={r.workspace}>
                {basename(r.workspace)}
              </span>
              <span className="ml-auto flex items-center gap-3 text-xs text-muted">
                <span>
                  loop {r.loop}
                  {r.maxIterations ? `/${r.maxIterations}` : ''}
                </span>
                {r.phase && <span className="text-fg-soft">{r.phase}</span>}
                <span>{fmtDur(r.elapsedMs)}</span>
                <span className="w-16 text-right">{fmtAgo(r.startedAt)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}
