// Fleet "Warden verdicts": which sessions the warden acted on, the verdict
// (killed / revived / nudged / cleared / needs-human) and why. Quiet by
// default — a collapsible section, newest-first, capped by the server (~20).
// Polls /v1/warden/verdicts every 30s (paused when the tab is hidden) and
// self-hides if the route is absent (older daemon). Clicking a row opens the
// full markdown report.

import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Gavel, Skull, HeartPulse, Bell, Check, UserRound, X } from 'lucide-react';
import { api } from '../lib/api';
import type { WardenVerdict, WardenVerdictKind } from '../types';
import { Markdown } from './Markdown';
import { cn, fmtRelative } from '../lib/utils';

const POLL_MS = 30_000;

const VERDICT: Record<WardenVerdictKind, { label: string; cls: string; Icon: typeof Skull }> = {
  killed: { label: 'killed', cls: 'text-err border-err-border bg-err-bg', Icon: Skull },
  revived: { label: 'revived', cls: 'text-accent border-accent-border bg-accent-soft', Icon: HeartPulse },
  nudged: { label: 'nudged', cls: 'text-accent border-accent-border bg-accent-soft', Icon: Bell },
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
                    {v.teammate ?? v.targetSession ?? '—'}
                  </span>
                  {v.reason && <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{v.reason}</span>}
                  <span className="mono ml-auto shrink-0 text-[11px] text-faint">{fmtRelative(v.at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {report && <ReportModal title={report.title} body={report.body} onClose={() => setReport(null)} />}
    </div>
  );
}

function ReportModal({ title, body, onClose }: { title: string; body: string | null; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[6vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[820px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-md"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
          <Gavel size={14} className="text-faint" />
          <span className="mono truncate text-[12.5px] text-fg-soft">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 scroll-thin">
          {body == null ? <div className="text-[13px] text-muted">loading report…</div> : <Markdown text={body} />}
        </div>
      </div>
    </div>
  );
}
