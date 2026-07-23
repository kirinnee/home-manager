// A run of consecutive tool calls, collapsed into ONE slim group line —
// tools are background noise, visible but small. Never a big card, never a
// modal.
//
//   collapsed:  ● 4 tools · Bash, Edit ×2, Read            ✓
//   running:    ● Bash · bun test — 34s               ◌ (subtle spinner)
//   expanded:   each call as its own slim line, individually openable to its
//               input body + result.

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
  CircleDot,
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
  return <span className="mono text-faint">— {label}</span>;
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

  const anyError = calls.some(c => c.result?.isError);
  // The trailing unfinished call of a live session is "running".
  const lastCall = calls[calls.length - 1];
  const running = live && isLast && lastCall && !lastCall.result && !lastCall.orphanResult;

  const single = calls.length === 1;

  // ---- running: a dedicated slim status line (spinner + elapsed) ----------
  if (running && single) {
    const sum = extractToolSummary(lastCall!.use.name, lastCall!.use.input);
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-[12px]">
        <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
        <span className="mono font-medium text-fg-soft">{sum.verb}</span>
        <span className="mono truncate text-muted">· {sum.headline}</span>
        <Elapsed since={lastCall!.ts} />
      </div>
    );
  }

  const StatusIcon = running ? Loader2 : anyError ? TriangleAlert : Check;
  const statusClass = running ? 'text-accent animate-spin' : anyError ? 'text-err' : 'text-ok';

  // ---- single (non-running) tool: render its line directly (one click to
  //      the body — no redundant group wrapper for the common case) --------
  if (single && !running) {
    return (
      <div className="text-[12px]">
        <ToolLine call={calls[0]!} />
      </div>
    );
  }

  // ---- summary line -------------------------------------------------------
  return (
    <div className="text-[12px]">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-2"
      >
        <CircleDot size={11} className={cn('shrink-0', running ? 'text-accent' : 'text-faint')} />
        <span className="text-muted">{calls.length === 1 ? '1 tool' : `${calls.length} tools`}</span>
        <span className="mono min-w-0 flex-1 truncate text-faint">· {summarize(calls)}</span>
        {running && <Elapsed since={lastCall!.ts} />}
        <StatusIcon size={12} className={cn('shrink-0', statusClass)} />
        <ChevronRight size={13} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <div className="mt-0.5 space-y-0.5 border-l border-border-soft pl-2">
          {calls.map(c => (
            <ToolLine key={c.key} call={c} />
          ))}
        </div>
      )}
    </div>
  );
});

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
    <div>
      <button
        type="button"
        onClick={() => hasBody && setOpen(v => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left',
          hasBody ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default',
        )}
      >
        <Icon size={12} className="shrink-0" style={{ color: toolColorVar(sum.kind) }} />
        <span className="mono font-medium text-fg-soft">{sum.verb}</span>
        <span className="mono min-w-0 flex-1 truncate text-muted" title={sum.headline}>
          {sum.headline}
        </span>
        {err ? (
          <TriangleAlert size={11} className="shrink-0 text-err" />
        ) : call.result ? (
          <Check size={11} className="shrink-0 text-ok" />
        ) : (
          <span className="shrink-0 text-[10px] text-faint">·</span>
        )}
        {hasBody && (
          <ChevronRight size={12} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        )}
      </button>
      {open && hasBody && (
        <div className="mb-1 ml-1.5 space-y-1">
          {sum.bodyLines.length > 0 && <CodeBlock code={sum.bodyLines.join('\n')} lang={bodyLang} />}
          {cleaned != null && (
            <div>
              <div className="px-1 pb-0.5 text-[10.5px] uppercase tracking-wider text-faint">
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
