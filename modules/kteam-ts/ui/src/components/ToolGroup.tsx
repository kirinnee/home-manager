// A run of consecutive tool calls, collapsed into ONE slim group line.
//
// ASYMMETRIC DENSITY (see index.css): tools are background texture, not
// content. Everything at rest lives in the `.kt-chrome` tier — 11px / 1.35,
// --faint at 78% opacity — which is a clear step below the 13–13.75px full-tone
// message text around it. The collapsed state is a SINGLE line with no card, no
// border, no background, and no decorative icon of its own:
//
//   collapsed:  4 tools · Bash, Edit ×2, Read                        ✓
//   running:    Bash · bun test — 34s                                ◌
//   expanded:   one slim line per call, each openable to input + result
//
// Two things deliberately keep their weight:
//   - a RUNNING tool (the accent spinner) — it is live status, not history;
//   - an ERROR (the red triangle, via .kt-chrome-alert) — a failure that faded
//     into the background would be a bug, not a density win.
//
// Expansion is opt-in on click and brings back full-size code surfaces: you
// opened it on purpose, so the body should be comfortable to read.

import { memo, useEffect, useState } from 'react';
import {
  ChevronRight,
  Loader2,
  Terminal,
  FileText,
  FilePlus,
  FilePenLine,
  Search,
  ListTodo,
  Hourglass,
  Wrench,
  Check,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  extractToolSummary,
  parseExecOutput,
  resultText,
  toolColorVar,
  langFromPath,
  type ToolKind,
} from '../lib/tool-extract';
import { CodeBlock } from './CodeBlock';
import type { ToolCall } from '../lib/transcript';

function iconFor(kind: ToolKind) {
  switch (kind) {
    case 'bash':
      return Terminal;
    case 'read':
      return FileText;
    case 'write':
      return FilePlus;
    case 'edit':
    case 'patch':
      return FilePenLine;
    case 'search':
      return Search;
    case 'plan':
      return ListTodo;
    case 'wait':
      return Hourglass;
    default:
      return Wrench;
  }
}

// "Bash, Edit ×2, Read" from the run's verbs, order-preserving.
function summarize(calls: ToolCall[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const c of calls) {
    const verb = c.orphanResult ? 'result' : extractToolSummary(c.use.name, c.use.input).verb;
    if (!counts.has(verb)) order.push(verb);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return order.map(v => (counts.get(v)! > 1 ? `${v} ×${counts.get(v)}` : v)).join(', ');
}

function Elapsed({ since }: { since?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const start = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(start)) return null;
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  return <span className="mono shrink-0">— {label}</span>;
}

interface Props {
  calls: ToolCall[];
  /** the session is actively working (isBusy) */
  live: boolean;
  /** this is the final block in the transcript */
  isLast: boolean;
}

export const ToolGroup = memo(function ToolGroup({ calls, live, isLast }: Props) {
  const [open, setOpen] = useState(false);

  // The trailing unfinished call of a live session is "running".
  const lastCall = calls[calls.length - 1];
  const running = live && isLast && lastCall && !lastCall.result && !lastCall.orphanResult;

  // A running tool is live status, so it never hides inside the collapsed count:
  // it gets its own named line (verb · headline · elapsed) below the history.
  // The finished calls collapse into the group above it — even in a large merged
  // run, you can still see exactly which tool is live.
  const history = running ? calls.slice(0, -1) : calls;
  const anyError = history.some(c => c.result?.isError);

  const runningLine = running ? <RunningLine call={lastCall!} /> : null;

  // ---- history is empty: a single running tool, nothing done yet ----------
  if (history.length === 0) return runningLine;

  // ---- single finished tool: render its line directly (one click to the
  //      body — no redundant group wrapper for the common case) ------------
  if (history.length === 1) {
    return (
      <>
        <ToolLine call={history[0]!} />
        {runningLine}
      </>
    );
  }

  const StatusIcon = anyError ? TriangleAlert : Check;

  // ---- summary line -------------------------------------------------------
  return (
    <>
      <div className="kt-chrome">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="flex w-full items-center gap-1.5 rounded-control px-2 py-px text-left hover:bg-surface-2"
        >
          <span className="mono shrink-0">{history.length} tools</span>
          <span className="mono min-w-0 flex-1 truncate">· {summarize(history)}</span>
          <StatusIcon size={10} className={cn('shrink-0', anyError ? 'kt-chrome-alert text-err' : '')} />
          <ChevronRight size={10} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        </button>

        {open && (
          <div className="border-l border-border-soft pl-1.5">
            {history.map(c => (
              <ToolLine key={c.key} call={c} />
            ))}
          </div>
        )}
      </div>
      {runningLine}
    </>
  );
});

// A dedicated slim status line for the live tool (spinner + elapsed). Still
// chrome-sized, but the spinner keeps the accent: this is the one tool state
// that is live information rather than a record of the past.
function RunningLine({ call }: { call: ToolCall }) {
  const sum = extractToolSummary(call.use.name, call.use.input);
  return (
    <div className="kt-chrome flex items-center gap-1.5 px-2 py-px">
      <Loader2 size={10} className="kt-chrome-alert shrink-0 animate-spin text-accent" />
      <span className="mono shrink-0">{sum.verb}</span>
      <span className="mono min-w-0 flex-1 truncate">· {sum.headline}</span>
      <Elapsed since={call.ts} />
    </div>
  );
}

function ToolLine({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const sum = call.orphanResult
    ? {
        verb: 'result',
        headline: 'tool result',
        detail: undefined,
        bodyLines: [] as string[],
        kind: 'generic' as ToolKind,
        isExec: false,
      }
    : extractToolSummary(call.use.name, call.use.input);
  const Icon = iconFor(sum.kind);
  const hasBody = sum.bodyLines.length > 0 || call.result != null;

  const err = call.result?.isError;
  const rtext = call.result ? resultText(call.result) : null;
  const cleaned = rtext != null && sum.isExec ? parseExecOutput(rtext).cleanText : rtext;

  const bodyLang =
    sum.kind === 'bash'
      ? 'bash'
      : sum.kind === 'edit' || sum.kind === 'patch'
        ? 'diff'
        : sum.kind === 'write'
          ? langFromPath(sum.filePath)
          : undefined;
  const resultLang = langFromPath(sum.filePath);

  return (
    <div className="kt-chrome">
      <button
        type="button"
        onClick={() => hasBody && setOpen(v => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-control px-1.5 py-px text-left',
          hasBody ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default',
        )}
      >
        {/* The per-tool hue is kept but shrunk to 10px and left un-boosted, so
            it reads as a bullet you can scan by colour rather than as an icon
            claiming a row of its own. */}
        <Icon size={10} className="shrink-0" style={{ color: toolColorVar(sum.kind) }} />
        <span className="mono shrink-0">{sum.verb}</span>
        <span className="mono min-w-0 flex-1 truncate" title={sum.headline}>
          {sum.headline}
        </span>
        {err ? (
          <TriangleAlert size={10} className="kt-chrome-alert shrink-0 text-err" />
        ) : call.result ? (
          <Check size={10} className="shrink-0" />
        ) : null}
        {hasBody && <ChevronRight size={10} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && hasBody && (
        <div className="mb-1 ml-1.5 mt-0.5 space-y-1">
          {sum.bodyLines.length > 0 && <CodeBlock code={sum.bodyLines.join('\n')} lang={bodyLang} />}
          {cleaned != null && (
            <div>
              <div className="kt-label px-1 pb-0.5">
                {err ? 'error' : 'result'} · {cleaned.split('\n').length} lines
              </div>
              <CodeBlock code={cleaned} lang={err ? undefined : resultLang} tone={err ? 'err' : 'default'} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
