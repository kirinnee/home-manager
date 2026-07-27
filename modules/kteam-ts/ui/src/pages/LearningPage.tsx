// The Learning destination — verified, recurring corrections surfaced as
// GLOBAL rule proposals for the human to accept, reject, or edit. Mirrors the
// WardenPage shape (first-class, full-width, one vertical scroller).
//
// Evidence is the primary artifact. Every card's occurrence count is COMPUTED by
// the daemon from verified verbatim quotes; the evidence panel (a native
// <details>, collapsed by default per the requirement) shows each occurrence as
// quote + who + repo + when, deep-linking into the session. Rejection is
// permanent (a tombstone the daemon enforces). Apply is manual: "Copy rule" and
// "Save patch file" — the daemon never writes kfleet itself in phase 1.

import { useCallback, useEffect, useState } from 'react';
import { GraduationCap, Check, X, Pencil, Copy, FileDown, RefreshCw } from 'lucide-react';
import { Button } from '../components/Primitives';
import { learningApi, HAS_TOKEN, type LearningActionPayload } from '../lib/learning-api';
import type { LearningStatusView, ProposalView } from '../lib/learning-types';
import { strengthOf } from '../lib/learning-types';
import { displayCallsign } from '../lib/callsign';
import { fmtRelative, fmtAbsolute, cn } from '../lib/utils';
import { useInputModality } from '../hooks/useInputModality';

export function LearningPage() {
  const [status, setStatus] = useState<LearningStatusView | null>(null);
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([learningApi.status(), learningApi.proposals()]);
      setStatus(s);
      setProposals(p);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, payload: LearningActionPayload) => {
      if (!HAS_TOKEN) return;
      setBusy(true);
      try {
        await learningApi.act(id, payload);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const runNow = useCallback(async () => {
    if (!HAS_TOKEN) return;
    setBusy(true);
    try {
      await learningApi.run(true);
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  const pending = proposals.filter(p => p.state === 'pending');
  const accepted = proposals.filter(p => p.state === 'accepted');
  const rejected = proposals.filter(p => p.state === 'rejected');

  const strong = pending.filter(p => strengthOf(p.occurrences) === 'strong');
  const normal = pending.filter(p => strengthOf(p.occurrences) === 'normal');
  const weak = pending.filter(p => strengthOf(p.occurrences) === 'weak');

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-4">
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-3 py-2">
        <div className="min-w-0">
          <h1 className="m-0 flex items-center gap-sm font-display text-display font-bold tracking-display">
            <GraduationCap size={20} className="text-accent" aria-hidden="true" />
            Learning
          </h1>
          <p className="mt-0.5 text-ui text-muted">
            Recurring corrections mined from finished sessions, surfaced as global rule proposals. Every quote is
            machine-verified against the transcript.
          </p>
        </div>

        <LearningHeader status={status} failed={failed} busy={busy} onRunNow={runNow} />

        {!HAS_TOKEN && (
          <p className="kt-badge w-fit" data-tone="warn">
            read-only: no local token — accept/reject/run are disabled
          </p>
        )}

        {pending.length === 0 && accepted.length === 0 && (
          <p className="rounded-lg border border-border-soft bg-surface-2 px-3 py-4 text-ui text-muted">
            No proposals yet. When the miner finds recurring corrections they appear here for review.
          </p>
        )}

        {strong.length > 0 && (
          <Group label="Strong signals — seen across 5+ sessions" items={strong} act={act} busy={busy} />
        )}
        {normal.length > 0 && <Group label="Proposals" items={normal} act={act} busy={busy} />}

        {weak.length > 0 && (
          <details className="rounded-lg border border-border-soft bg-surface-2">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center px-3 text-ui font-medium text-fg-soft">
              Weak signals (single occurrence) · {weak.length}
            </summary>
            <div className="flex flex-col gap-3 p-3 pt-0">
              {weak.map(p => (
                <ProposalCard key={p.id} proposal={p} act={act} busy={busy} muted />
              ))}
            </div>
          </details>
        )}

        {accepted.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="kt-label mt-2">Accepted — apply by hand</h2>
            {accepted.map(p => (
              <ProposalCard key={p.id} proposal={p} act={act} busy={busy} accepted />
            ))}
          </section>
        )}

        {rejected.length > 0 && (
          <details className="mt-2 rounded-lg border border-border-soft bg-surface-2">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center px-3 text-ui font-medium text-muted">
              Rejected (permanent) · {rejected.length}
            </summary>
            <div className="flex flex-col gap-2 p-3 pt-0">
              {rejected.map(p => (
                <div key={p.id} className="text-ui text-muted line-through">
                  {p.title}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function Group({
  label,
  items,
  act,
  busy,
}: {
  label: string;
  items: ProposalView[];
  act: (id: string, payload: LearningActionPayload) => void;
  busy: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="kt-label mt-2">{label}</h2>
      {items.map(p => (
        <ProposalCard key={p.id} proposal={p} act={act} busy={busy} />
      ))}
    </section>
  );
}

/** The strip mirrors WardenStrip: enabled state, last run, watermark, run-now. */
export function LearningHeader({
  status,
  failed,
  busy,
  onRunNow,
}: {
  status: LearningStatusView | null;
  failed: boolean;
  busy: boolean;
  onRunNow: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-soft bg-surface-2 px-3 py-2 text-[12px]">
      <span className="inline-flex items-center gap-1.5 font-medium text-fg-soft">Learning</span>
      <span className="text-border">·</span>
      <span className={cn('mono', status?.enabled ? 'text-ok' : 'text-muted')}>
        {status?.enabled ? 'enabled' : 'disabled'}
      </span>
      <span className="text-border">·</span>
      <span className="mono text-muted">last run {status?.lastRunAt ? fmtRelative(status.lastRunAt) : '—'}</span>
      <span className="text-border">·</span>
      <span className="mono text-muted">{status?.pending.total ?? 0} pending</span>
      {status && status.pending.strong > 0 && (
        <>
          <span className="text-border">·</span>
          <span className="mono text-accent">{status.pending.strong} strong</span>
        </>
      )}
      {failed && (
        <>
          <span className="text-border">·</span>
          <span className="mono text-warn">unavailable on this daemon</span>
        </>
      )}
      <Button
        size="sm"
        variant="outline"
        className="ml-auto min-h-[44px] items-center gap-xs"
        onClick={onRunNow}
        disabled={busy || !HAS_TOKEN}
        aria-label="Run a learning scan now"
      >
        <RefreshCw
          size={13}
          aria-hidden="true"
          className={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
        Run now
      </Button>
    </div>
  );
}

/** One proposal, with its computed occurrence badge, cross-repo count, editable
 *  rule text, collapsed evidence, and the phase-1 actions. */
export function ProposalCard({
  proposal,
  act,
  busy,
  muted = false,
  accepted = false,
}: {
  proposal: ProposalView;
  act: (id: string, payload: LearningActionPayload) => void;
  busy: boolean;
  muted?: boolean;
  accepted?: boolean;
}) {
  const { touchAffected } = useInputModality();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.ruleText);
  const [copied, setCopied] = useState<'rule' | 'patch' | null>(null);

  const strength = strengthOf(proposal.occurrences);

  const copyRule = async () => {
    try {
      await navigator.clipboard?.writeText(proposal.ruleText);
      setCopied('rule');
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard denied — the text is on screen regardless */
    }
  };

  const savePatch = async () => {
    try {
      const { contents } = await learningApi.patch(proposal.id);
      const blob = new Blob([contents], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${proposal.identity}.md`;
      a.click();
      URL.revokeObjectURL(url);
      setCopied('patch');
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* surfaced by disabling on !HAS_TOKEN */
    }
  };

  return (
    <div className={cn('kt-panel flex flex-col gap-2 p-3', muted && 'opacity-80')}>
      <div className="flex flex-wrap items-start gap-2">
        <OccurrenceBadge occurrences={proposal.occurrences} strength={strength} />
        <span className="mono text-meta text-faint" title="distinct repos this was seen in">
          {proposal.crossRepoCount} repo{proposal.crossRepoCount === 1 ? '' : 's'}
        </span>
        <h3 className="m-0 min-w-0 flex-1 text-ui font-semibold text-fg">{proposal.title}</h3>
      </div>

      <div className="text-meta text-faint mono">
        → {proposal.target.path}
        {proposal.target.anchor ? ` (${proposal.target.anchor})` : ''}
      </div>

      {editing ? (
        <textarea
          className="kt-input resize-y"
          rows={3}
          value={draft}
          // No keyboard-summoning autofocus on touch.
          autoFocus={!touchAffected}
          aria-label={`Edit rule text for ${proposal.title}`}
          onChange={e => setDraft(e.target.value)}
        />
      ) : (
        <p className="m-0 whitespace-pre-wrap text-ui text-fg-soft">{proposal.ruleText}</p>
      )}

      <details className="rounded border border-border-soft bg-surface-1">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center px-2 text-meta font-medium text-muted">
          Evidence · {proposal.evidence.length} verified quote{proposal.evidence.length === 1 ? '' : 's'}
        </summary>
        <ul className="m-0 flex list-none flex-col gap-1 p-2 pt-0">
          {proposal.evidence.map(e => (
            <li key={e.observationId}>
              <a
                href={`/session/${encodeURIComponent(e.sessionId)}`}
                className="flex min-h-[44px] flex-col justify-center gap-0.5 rounded px-2 py-1 hover:bg-surface-2"
              >
                <span className="text-ui text-fg-soft">“{e.quote}”</span>
                <span className="mono text-meta text-faint">
                  {e.source === 'teammate' ? 'teammate steer' : 'human'}
                  {e.teammate ? ` · ${displayCallsign(e.teammate)}` : ''} · {e.repo} · {fmtAbsolute(e.at)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </details>

      <div className="flex flex-wrap items-center gap-sm">
        {!accepted && !editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              className="min-h-[44px] items-center gap-xs"
              disabled={busy || !HAS_TOKEN}
              aria-label={`Accept ${proposal.title}`}
              onClick={() => act(proposal.id, { action: 'accept' })}
            >
              <Check size={14} aria-hidden="true" /> Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px] items-center gap-xs"
              aria-label={`Edit ${proposal.title}`}
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} aria-hidden="true" /> Edit
            </Button>
            <Button
              size="sm"
              variant="danger"
              className="min-h-[44px] items-center gap-xs"
              disabled={busy || !HAS_TOKEN}
              aria-label={`Reject ${proposal.title} permanently`}
              onClick={() => act(proposal.id, { action: 'reject' })}
            >
              <X size={14} aria-hidden="true" /> Reject
            </Button>
          </>
        )}
        {editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              className="min-h-[44px] items-center gap-xs"
              disabled={busy || !HAS_TOKEN}
              aria-label={`Save edited rule text for ${proposal.title}`}
              onClick={() => {
                act(proposal.id, { action: 'edit', ruleText: draft });
                setEditing(false);
              }}
            >
              <Check size={14} aria-hidden="true" /> Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px] items-center gap-xs"
              aria-label={`Cancel editing ${proposal.title}`}
              onClick={() => {
                setDraft(proposal.ruleText);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="min-h-[44px] items-center gap-xs"
          aria-label={`Copy rule text for ${proposal.title}`}
          onClick={copyRule}
        >
          <Copy size={14} aria-hidden="true" /> {copied === 'rule' ? 'Copied' : 'Copy rule'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="min-h-[44px] items-center gap-xs"
          disabled={!HAS_TOKEN}
          aria-label={`Save a patch file for ${proposal.title}`}
          onClick={savePatch}
        >
          <FileDown size={14} aria-hidden="true" /> {copied === 'patch' ? 'Saved' : 'Save patch'}
        </Button>
      </div>
    </div>
  );
}

function OccurrenceBadge({ occurrences, strength }: { occurrences: number; strength: 'weak' | 'normal' | 'strong' }) {
  return (
    <span
      className={cn('kt-badge shrink-0', strength === 'strong' && 'font-semibold')}
      data-tone={strength === 'strong' ? 'accent' : strength === 'weak' ? 'pend' : 'ok'}
      title={`${occurrences} distinct session${occurrences === 1 ? '' : 's'}`}
    >
      {occurrences}×
    </span>
  );
}
