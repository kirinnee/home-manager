// Fleet "Warden verdicts": which sessions the warden acted on, the verdict
// (killed / revived / nudged / cleared / needs-human) and why. Quiet by
// default — a collapsible section, newest-first, capped by the server (~20).
// Polls /v1/warden/verdicts every 30s (paused when the tab is hidden) and
// self-hides if the route is absent (older daemon). Clicking a row opens the
// full markdown report.

import { Suspense, lazy, useCallback, useId, useRef, useState, useEffect } from 'react';
import { ChevronRight, Gavel, Skull, HeartPulse, Bell, Check, UserRound, X } from 'lucide-react';
import { api } from '../lib/api';
import { useDialogFocus } from '../hooks/useDialogFocus';
import type { WardenVerdict, WardenVerdictKind } from '../types';
import { displayCallsign } from '../lib/callsign';
// LAZY. Rendering the dashboard must not download the markdown + syntax
// highlighting stack: this section is collapsed by default and most readers
// never open a report at all. The chunk arrives when one is opened.
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

export function WardenVerdicts() {
  const [verdicts, setVerdicts] = useState<WardenVerdict[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<{ path: string; title: string; body: string | null } | null>(null);
  const timer = useRef<number | null>(null);
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
        }
      } catch {
        if (!cancelled && !verdicts) setFailed(true);
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
    setReport({ path: v.reportPath, title, body: null });
    try {
      setReport({ path: v.reportPath, title, body: await api.wardenReport(v.reportPath) });
    } catch {
      setReport({ path: v.reportPath, title, body: '_Could not load this report._' });
    }
  }

  if (failed || !verdicts || verdicts.length === 0) return null; // quiet when absent/empty

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border-soft bg-surface">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-surface-2"
      >
        <Gavel size={14} className="shrink-0 text-faint" />
        <span className="font-medium text-fg-soft">Warden verdicts</span>
        <span className="mono text-[11.5px] text-faint">{verdicts.length} recent</span>
        <ChevronRight
          size={14}
          className={cn('ml-auto shrink-0 text-faint transition-transform', open && 'rotate-90')}
        />
      </button>

      {open && (
        <ul className="divide-y divide-border-soft border-t border-border-soft">
          {verdicts.map((v, i) => {
            const meta = VERDICT[v.verdict];
            return (
              <li key={`${v.reportPath}-${v.targetSession ?? i}`}>
                <button
                  type="button"
                  onClick={() => void openReport(v)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
                      meta.cls,
                    )}
                  >
                    <meta.Icon size={11} />
                    {meta.label}
                  </span>
                  <span className="shrink-0 text-[12.5px] font-medium text-fg">
                    {v.teammate ? displayCallsign(v.teammate) : (v.targetSession ?? '—')}
                  </span>
                  {v.reason && <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{v.reason}</span>}
                  <span className="mono ml-auto shrink-0 text-[11px] text-faint">{fmtRelative(v.at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Rendered unconditionally with an `open` flag, the way SessionDetails is:
          the focus-restore half of the modal contract runs on the open->closed
          TRANSITION, so a modal that unmounts instead of closing never hands the
          reader back to the row they opened it from. */}
      <ReportModal
        open={report !== null}
        title={report?.title ?? ''}
        body={report?.body ?? null}
        onClose={closeReport}
      />
    </div>
  );
}

// The full warden report. A real dialog now: Escape, initial focus, a Tab trap
// and focus restoration all come from the shared contract in
// hooks/useDialogFocus.ts — the same one SessionDetails and the fleet drawer
// use, so there is one implementation of this and not a third thinner copy.
function ReportModal({
  open,
  title,
  body,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string | null;
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
        <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
          <Gavel size={14} className="text-faint" aria-hidden="true" />
          <span id={titleId} className="mono truncate text-[12.5px] text-fg-soft">
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close report ${title}`}
            title="Close (Esc)"
            className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 scroll-thin">
          {body == null ? (
            <div className="text-[13px] text-muted">loading report…</div>
          ) : (
            <Suspense fallback={<div className="text-[13px] text-muted">rendering report…</div>}>
              <Markdown text={body} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
