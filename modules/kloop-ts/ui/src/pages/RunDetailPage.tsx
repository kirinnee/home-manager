import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { openReloadStream } from '../lib/sse';
import { fmtDur } from '../lib/format';
import { AgentStatusBadge, HarnessChip, RunStatusBadge, Stat, VerdictBadge } from '../components/Bits';
import { Badge, Card } from '../components/Primitives';
import type { AgentState, LoopState, RunDetail, RunSession } from '../types';

// Match a kloop agent to its kteam session by the teammate-name convention the
// AgentRunner uses: `kloop-<runId>-<iter>-<role>[-<idx>]`. Best-effort substring match.
function findSession(sessions: RunSession[], loop: number, marker: string): RunSession | undefined {
  const needle = `-${loop}-${marker}`;
  return sessions.find(s => s.name.includes(needle));
}

export function RunDetailPage({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [sessions, setSessions] = useState<RunSession[]>([]);
  const [kteamBase, setKteamBase] = useState('http://127.0.0.1:7337');
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    api
      .runDetail(runId)
      .then(d => {
        setDetail(d);
        setErr(null);
      })
      .catch(e => setErr(String(e)));
    api
      .runSessions(runId)
      .then(r => {
        setSessions(r.sessions);
        setKteamBase(r.kteamBase);
      })
      .catch(() => {});
  }, [runId]);

  useEffect(() => {
    load();
    const off = openReloadStream(load);
    return () => off();
  }, [load]);

  // While running, poll so elapsed + live statuses tick even without a store change.
  useEffect(() => {
    if (detail?.status === 'running' && !timer.current) {
      timer.current = setInterval(load, 4000);
    }
    if (detail?.status !== 'running' && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [detail?.status, load]);

  if (err) return <p className="text-sm text-err">{err}</p>;
  if (!detail) return <div className="h-40 animate-pulse rounded-md bg-surface-2" />;

  const mode =
    [detail.synthesis ? 'synthesis' : null, detail.verify ? 'verify' : null].filter(Boolean).join(' + ') || 'plain';

  return (
    <div className="flex flex-col gap-4">
      {/* hero */}
      <div className="flex flex-wrap items-center gap-3">
        <RunStatusBadge status={detail.status} />
        <span className="font-mono text-sm text-fg">{detail.id}</span>
        <span className="text-xs text-muted" title={detail.workspace}>
          {detail.workspace}
        </span>
      </div>

      {/* overview stats */}
      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label="Loop" value={`${detail.loop}${detail.maxIterations ? ` / ${detail.maxIterations}` : ''}`} />
        <Stat label="Elapsed" value={fmtDur(detail.elapsedMs)} />
        <Stat label="Mode" value={mode} />
        <Stat
          label="Failures"
          value={`${detail.failures ?? 0}${detail.failureThreshold ? ` / ${detail.failureThreshold}` : ''}`}
        />
      </Card>

      {detail.exitReason && (
        <div className="rounded-md border border-border-soft bg-surface-2 px-3 py-2 text-xs text-fg-soft">
          <span className="text-muted">exit: </span>
          {detail.exitReason}
        </div>
      )}

      {sessions.length === 0 && (
        <p className="text-xs text-muted">
          No live kteam sessions for this run (daemon down or run finished). Agent chats deep-link when sessions exist.
        </p>
      )}

      {/* loops */}
      <div className="flex flex-col gap-3">
        {[...detail.loops].reverse().map(lp => (
          <LoopCard key={lp.loop} lp={lp} sessions={sessions} kteamBase={kteamBase} />
        ))}
      </div>
    </div>
  );
}

function LoopCard({ lp, sessions, kteamBase }: { lp: LoopState; sessions: RunSession[]; kteamBase: string }) {
  const reviewers = lp.reviewPhases.flatMap(p => p.reviewers);
  const verifiers = (lp.verifyPhases ?? []).flatMap(p => p.reviewers);
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-border-soft px-3 py-2">
        <span className="text-sm font-medium text-fg">Loop {lp.loop}</span>
        <span className="text-xs text-muted">{lp.completedAt ? fmtDur(lp.durationMs) : 'in progress'}</span>
      </div>
      <div className="divide-y divide-border-soft">
        {lp.implementer && (
          <AgentRow
            role="implementer"
            agent={lp.implementer}
            session={findSession(sessions, lp.loop, 'impl')}
            kteamBase={kteamBase}
          />
        )}
        {reviewers.map((r, i) => (
          <AgentRow
            key={`rev-${i}`}
            role={`reviewer-${i}${r.lens ? ` · ${r.lens}` : ''}`}
            agent={r}
            session={findSession(sessions, lp.loop, `rev-${i}`)}
            kteamBase={kteamBase}
          />
        ))}
        {lp.synthesis && (
          <AgentRow
            role="synthesis"
            agent={lp.synthesis}
            session={findSession(sessions, lp.loop, 'synth')}
            kteamBase={kteamBase}
          />
        )}
        {verifiers.map((r, i) => (
          <AgentRow
            key={`ver-${i}`}
            role={`verifier-${i}`}
            agent={r}
            session={findSession(sessions, lp.loop, `verify-${i}`)}
            kteamBase={kteamBase}
          />
        ))}
        {lp.checkpoint && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs">
            <span className="w-28 shrink-0 text-muted">checkpoint</span>
            <Badge tone={lp.checkpoint.outcome === 'conflict_found' ? 'err' : 'pend'}>
              {lp.checkpoint.outcome ?? lp.checkpoint.status}
            </Badge>
            {lp.checkpoint.summary && <span className="truncate text-fg-soft">{lp.checkpoint.summary}</span>}
          </div>
        )}
      </div>
    </Card>
  );
}

function AgentRow({
  role,
  agent,
  session,
  kteamBase,
}: {
  role: string;
  agent: AgentState;
  session?: RunSession;
  kteamBase: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-xs">
      <span className="w-28 shrink-0 text-muted">{role}</span>
      <AgentStatusBadge status={agent.status} />
      <span className="font-mono text-[12px] text-fg">{agent.binary}</span>
      <HarnessChip harness={agent.harness} />
      {agent.model && <span className="text-muted">{agent.model}</span>}
      <VerdictBadge verdict={agent.verdict} />
      {agent.completionEstimate !== undefined && <span className="text-muted">{agent.completionEstimate}%</span>}
      {agent.propagated && <span className="text-faint">prop</span>}
      {(agent.retryAttempt ?? 0) > 0 && (
        <span className="text-warn">
          ↻ {agent.retryAttempt}
          {agent.retryMax ? `/${agent.retryMax}` : ''}
        </span>
      )}
      {agent.error && <span className="text-err">{agent.error}</span>}
      <span className="ml-auto flex items-center gap-2.5 text-muted">
        {(agent.inputTokens || agent.outputTokens) && (
          <span>
            {agent.inputTokens ?? 0}→{agent.outputTokens ?? 0} tok
          </span>
        )}
        <span>{fmtDur(agent.durationMs)}</span>
        {session && (
          <a
            href={`${kteamBase}/session/${encodeURIComponent(session.id)}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-sm border border-border-soft bg-surface-2 px-1.5 py-0.5 text-accent hover:border-accent-border"
            title={`Open ${session.name} in kteam${session.status ? ` (${session.status})` : ''}`}
          >
            kteam
            {session.status && <span className="text-[10px] text-muted">· {session.status}</span>}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </span>
    </div>
  );
}
