// Fleet "Warden verdicts": which sessions the warden acted on, the verdict
// (killed / revived / nudged / cleared / needs-human) and why. Newest-first,
// capped by the server (~20). Polls /v1/warden/verdicts every 30s (paused when
// the tab is hidden) and self-hides if the route is absent (older daemon).
// Clicking a row opens the full markdown report.
//
// EXPANDED BY DEFAULT. This began as a collapsed strip competing for room on
// the dashboard, where staying quiet was the point. It now renders on a
// dedicated Warden route (`page`), and a page whose only content is a closed
// accordion makes the reader open the thing they navigated to — a pointless
// tap. The toggle stays so a long list can be folded away, but the resting
// state is open.

import { Suspense, lazy, useCallback, useId, useRef, useState, useEffect } from 'react';
import { ChevronRight, Gavel, Skull, HeartPulse, Bell, Check, UserRound, X } from 'lucide-react';
import { api } from '../lib/api';
import { useDialogFocus } from '../hooks/useDialogFocus';
import type { WardenSpawnInfo, WardenVerdict, WardenVerdictKind } from '../types';
import { displayCallsign } from '../lib/callsign';
import type { CodeReference } from '../lib/references';
import type { AttentionId } from '../lib/attention';
import { sessionReferenceHost } from '../lib/reference-host';
// LAZY. Expanding the list only renders rows, so the markdown + syntax
// highlighting stack is still not needed to see it. The chunk arrives when a
// REPORT is opened, which most readers never do — so defaulting the list to
// open costs nothing here.
const Markdown = lazy(() => import('./Markdown').then(m => ({ default: m.Markdown })));
import { cn, fmtRelative } from '../lib/utils';

const POLL_MS = 30_000;

const VERDICT: Record<WardenVerdictKind, { label: string; cls: string; Icon: typeof Skull }> = {
  killed: { label: 'killed', cls: 'text-err border-err-border bg-err-bg', Icon: Skull },
  // `border-accent`, NOT `border-accent-border`: these two badges are the only
  // ones in this table whose edge is drawn in the accent family, and the verdict
  // IS the state — 1.4.11 territory. `--accent-border` is a decorative tint that
  // measures 1.2-2.9:1 against `--accent-soft` in 6 of 10 themes; `--accent`
  // already has to clear 4.5:1 as link text on that same fill, so 3:1 as a border
  // costs nothing and the hue is unchanged.
  revived: { label: 'revived', cls: 'text-accent border-accent bg-accent-soft', Icon: HeartPulse },
  nudged: { label: 'nudged', cls: 'text-accent border-accent bg-accent-soft', Icon: Bell },
  cleared: { label: 'cleared', cls: 'text-muted border-border bg-surface-2', Icon: Check },
  needs_human: { label: 'needs human', cls: 'text-warn border-warn-border bg-warn-bg', Icon: UserRound },
  unknown: { label: 'reviewed', cls: 'text-faint border-border bg-surface-2', Icon: Gavel },
};

/** WHO ran the check, in one compact line: `wrapper · model · harness`.
 *
 * A verdict is only worth as much as the thing that produced it — "no action
 * needed" from a warden sitting on a rate-limited provider does not mean the
 * same as the same words from a healthy one. Reports written before the daemon
 * recorded provenance say so out loud instead of dropping the line, because a
 * missing line reads as "nothing to report". */
export function verdictProvenanceLine(spawn?: WardenSpawnInfo): string {
  if (!spawn?.wrapper) return 'Ran by: unknown (older report)';
  return `${spawn.wrapper} · ${verdictModelCopy(spawn)} · ${spawn.harness ?? 'harness unknown'}`;
}

/** The model, labelled by how confidently it is known. `modelSource: 'unknown'`
 *  means the daemon resolved nothing — printing its placeholder as if it were a
 *  model name is precisely the false certainty this feature exists to remove. */
function verdictModelCopy(spawn: WardenSpawnInfo): string {
  if (spawn.modelSource === 'unknown') return 'model unknown';
  if (spawn.model) return spawn.modelSource === 'wrapper' ? `${spawn.model} (wrapper default)` : spawn.model;
  return spawn.modelHint ? `${spawn.modelHint} (wrapper default)` : 'model unknown';
}

/** Short badge when failover moved the warden off its configured first choice. */
export function switchedAccountCopy(spawn?: WardenSpawnInfo): string | null {
  if (!spawn?.failedOver) return null;
  return 'switched account';
}

/** WHY the warden moved accounts — the daemon records one reason per skipped
 *  wrapper, so the configured first choice's reason is the answer to "why not
 *  the account I asked for?". Falls back to any other skip reason it kept. */
export function failoverReasonCopy(spawn?: WardenSpawnInfo): string {
  if (!spawn) return 'failover moved this check off the configured first choice';
  const skipped = spawn.skipped ?? {};
  const first = spawn.configuredFirst ? skipped[spawn.configuredFirst] : undefined;
  const any = Object.values(skipped).find(reason => typeof reason === 'string' && reason);
  const reason = first ?? spawn.failoverReason ?? any;
  const off = spawn.configuredFirst ? `moved off ${spawn.configuredFirst}` : 'moved off the configured first choice';
  return reason ? `${off}: ${reason}` : off;
}

/** See WardenStrip: the legacy dashboard call remains source-compatible but is
 * inert; WardenPage is the sole surface that opts into data and rendering. */
export function WardenVerdicts({ page = false }: { page?: boolean } = {}) {
  return page ? <WardenVerdictsPanel /> : null;
}

function WardenVerdictsPanel() {
  const [verdicts, setVerdicts] = useState<WardenVerdict[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(true);
  const [report, setReport] = useState<{
    path: string;
    title: string;
    body: string | null;
    sessionId?: string;
  } | null>(null);
  const timer = useRef<number | null>(null);
  const hasLoaded = useRef(false);
  // Stable, so the modal's Escape listener is not torn down and re-added on
  // every poll tick of this component.
  const closeReport = useCallback(() => setReport(null), []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const v = await api.wardenVerdicts();
        if (!cancelled) {
          setVerdicts(v);
          setFailed(false);
          hasLoaded.current = true;
        }
      } catch {
        // Keep a previously good verdict list visible through a transient poll
        // failure. The empty initial state is still honestly unavailable.
        if (!cancelled && !hasLoaded.current) setFailed(true);
      }
    };
    void poll();
    timer.current = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) window.clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openReport(v: WardenVerdict) {
    const title = v.reportPath.split('/').pop() ?? 'report';
    const report = { path: v.reportPath, title, sessionId: v.targetSession };
    setReport({ ...report, body: null });
    try {
      setReport({ ...report, body: await api.wardenReport(v.reportPath) });
    } catch {
      setReport({ ...report, body: '_Could not load this report._' });
    }
  }

  if (failed || !verdicts || verdicts.length === 0) return null; // quiet when absent/empty

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border-soft bg-surface">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-surface-2"
      >
        <Gavel size={14} className="shrink-0 text-faint" />
        <span className="font-medium text-fg-soft">Warden verdicts</span>
        <span className="mono text-[11.5px] text-faint">{verdicts.length} recent</span>
        <ChevronRight
          size={14}
          className={cn('ml-auto shrink-0 text-faint transition-transform', open && 'rotate-90')}
        />
      </button>

      {open && <VerdictRows verdicts={verdicts} onOpen={v => void openReport(v)} />}

      {/* Rendered unconditionally with an `open` flag, the way SessionDetails is:
          the focus-restore half of the modal contract runs on the open->closed
          TRANSITION, so a modal that unmounts instead of closing never hands the
          reader back to the row they opened it from. */}
      <ReportModal
        open={report !== null}
        title={report?.title ?? ''}
        body={report?.body ?? null}
        sessionId={report?.sessionId}
        {...sessionReferenceHost(report?.sessionId)}
        onClose={closeReport}
      />
    </div>
  );
}

/** Pure row list — no fetching, so it renders identically on a server, in a
 * test, and in the panel above. */
export function VerdictRows({ verdicts, onOpen }: { verdicts: WardenVerdict[]; onOpen: (v: WardenVerdict) => void }) {
  return (
    <ul className="m-0 list-none divide-y divide-border-soft border-t border-border-soft p-0">
      {verdicts.map((v, i) => {
        const meta = VERDICT[v.verdict] ?? VERDICT.unknown;
        const switched = switchedAccountCopy(v.spawn);
        return (
          <li key={`${v.reportPath}-${v.targetSession ?? 'unknown'}-${i}`}>
            <button
              type="button"
              onClick={() => onOpen(v)}
              className="flex min-h-[44px] w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface-2"
            >
              <span className="flex w-full min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
                    meta.cls,
                  )}
                >
                  <meta.Icon size={11} aria-hidden="true" />
                  {meta.label}
                </span>
                <span className="shrink-0 text-[12.5px] font-medium text-fg">
                  {displayCallsign(v.teammate) || (v.targetSession ?? '—')}
                </span>
                {v.reason && <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{v.reason}</span>}
                <span className="mono ml-auto shrink-0 text-[11px] text-faint">{fmtRelative(v.at)}</span>
              </span>
              {/* Provenance. Always rendered — an absent line would read as
                  "nothing to say" about the account that produced the verdict. */}
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className="mono min-w-0 truncate text-[11px] text-faint">{verdictProvenanceLine(v.spawn)}</span>
                {switched && (
                  <span
                    title={failoverReasonCopy(v.spawn)}
                    className="shrink-0 rounded border border-warn-border bg-warn-bg px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warn"
                  >
                    {switched}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// The full warden report. A real dialog now: Escape, initial focus, a Tab trap
// and focus restoration all come from the shared contract in
// hooks/useDialogFocus.ts — the same one SessionDetails and the fleet drawer
// use, so there is one implementation of this and not a third thinner copy.
export function ReportModal({
  open,
  title,
  body,
  sessionId,
  cwd,
  onTaskOpen,
  onCodeReferenceOpen,
  onAttentionOpen,
  attentionReferenceResolver,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string | null;
  sessionId?: string;
  cwd?: string;
  onTaskOpen?: (id: string, opener?: HTMLElement | null) => void;
  onCodeReferenceOpen?: (reference: CodeReference, opener?: HTMLElement | null) => void;
  onAttentionOpen?: (id: AttentionId, opener?: HTMLElement | null) => void;
  attentionReferenceResolver?: (id: AttentionId) => boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(open, panelRef, onClose);

  if (!open) return null;

  return (
    // The scrim stays a plain div with a click handler, deliberately. Promoting
    // it to a <button> (as the session drawer does, where it is the only close
    // affordance) would put a SECOND focusable "close this report" in the tab
    // order under the same name as the header X — the exact duplicate the audit
    // flagged on the fleet drawer. A mouse dismiss needs no tab stop; keyboard
    // readers already have Escape and the labelled X.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim p-4 pt-[6vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[86vh] w-full max-w-[820px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-md"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-2 border-b border-border-soft px-3 py-2.5 sm:px-4">
          <Gavel size={14} className="text-faint" aria-hidden="true" />
          <span id={titleId} className="mono truncate text-[12.5px] text-fg-soft">
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close report ${title}`}
            title="Close (Esc)"
            className="ml-auto inline-flex h-[44px] w-[44px] items-center justify-center rounded-control p-0 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto overflow-x-hidden px-3 py-4 scroll-thin sm:px-5">
          {body == null ? (
            <div className="text-[13px] text-muted">loading report…</div>
          ) : (
            <Suspense fallback={<div className="text-[13px] text-muted">rendering report…</div>}>
              <Markdown
                text={body}
                sessionId={sessionId}
                cwd={cwd}
                onTaskOpen={onTaskOpen}
                onCodeReferenceOpen={onCodeReferenceOpen}
                onAttentionOpen={onAttentionOpen}
                attentionReferenceResolver={attentionReferenceResolver}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
