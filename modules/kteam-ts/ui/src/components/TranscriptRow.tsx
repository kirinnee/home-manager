// One transcript block, rendered top-to-bottom (no bubbles). Memoized so a
// live append or a header tick never re-renders existing rows.
//
//   user       — compact block, accent left-rail + faint fill, whitespace kept
//   assistant  — clean rendered markdown, no container chrome
//   thinking    — collapsed one-liner ("thought for 2m 14s"), expandable
//   tools      — delegated to <ToolGroup/>
//   turn       — slim labeled separator
//   notice     — muted system row

import { memo, useState } from 'react';
import { ChevronRight, Brain } from 'lucide-react';
import type { TranscriptBlock } from '../lib/transcript';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolGroup';
import { MarkerSeparator } from './Marker';
import { cn, fmtClock } from '../lib/utils';

const PROTOCOL_HEADER = /#\s*(AGENTS\.md instructions|SYSTEM\s*PROMPT|INSTRUCTIONS)/i;
const LONG_USER_LINES = 16;

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

interface Props {
  block: TranscriptBlock;
  live: boolean;
  isLast: boolean;
}

export const TranscriptRow = memo(function TranscriptRow({ block, live, isLast }: Props) {
  switch (block.kind) {
    case 'user':
      return <UserMessage text={block.text} ts={block.ts} />;
    case 'assistant':
      return <AssistantMessage text={block.text} ts={block.ts} source={block.source} />;
    case 'thinking':
      return <ThinkingLine text={block.text} durationMs={block.durationMs} />;
    case 'tools':
      return <ToolGroup calls={block.calls} live={live} isLast={isLast} />;
    case 'turn':
      return (
        <MarkerSeparator tone="faint">
          {block.variant}
          {block.ts ? ` · ${fmtClock(block.ts)}` : ''}
        </MarkerSeparator>
      );
    case 'notice':
      return (
        <div className="px-2 py-0.5 text-[11px] text-faint mono truncate" title={block.label}>
          {block.label}
        </div>
      );
  }
});

function RoleMeta({ label, ts }: { label: string; ts?: string }) {
  return (
    <div className="mb-1 flex items-center gap-2 text-[10.5px] uppercase tracking-[0.12em] text-faint">
      <span className="font-semibold">{label}</span>
      {ts && <span className="mono tracking-normal normal-case">{fmtClock(ts)}</span>}
    </div>
  );
}

function AssistantMessage({ text, ts, source }: { text: string; ts?: string; source: string }) {
  if (!text.trim()) return null;
  return (
    <div className="py-1">
      <RoleMeta label={source === 'codex' ? 'codex' : 'assistant'} ts={ts} />
      <Markdown text={text} />
    </div>
  );
}

function UserMessage({ text, ts }: { text: string; ts?: string }) {
  const lines = text.split('\n');
  const isProtocol = PROTOCOL_HEADER.test(text) && text.length > 2000;
  const isLong = lines.length > LONG_USER_LINES || text.length > 1400;
  const [open, setOpen] = useState(false);
  const collapsible = isProtocol || isLong;

  // A useful one-line preview for collapsed long/protocol messages.
  let preview =
    lines.find(l => l.trim() && !/^[<#-]/.test(l.trim()))?.trim() ?? lines.find(l => l.trim())?.trim() ?? '(empty)';
  if (preview.length > 160) preview = preview.slice(0, 160) + '…';

  return (
    <div className="py-1">
      <div className="overflow-hidden rounded-md border border-l-[2.5px] border-border border-l-user-border bg-user-bg">
        <div className="flex items-center gap-2 px-3 pt-1.5">
          <span className="text-[10.5px] uppercase tracking-[0.12em] font-semibold text-accent">
            {isProtocol ? 'turn prompt' : 'message'}
          </span>
          {ts && <span className="mono text-[10.5px] text-faint">{fmtClock(ts)}</span>}
          {collapsible && (
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg"
            >
              <span>{open ? 'collapse' : `${lines.length} lines`}</span>
              <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
            </button>
          )}
        </div>
        {collapsible && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="block w-full px-3 pb-2 pt-0.5 text-left mono text-[12.5px] text-fg-soft truncate"
            title={preview}
          >
            {preview}
          </button>
        ) : (
          <div className="px-3 pb-2 pt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-fg">
            {text}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingLine({ text, durationMs }: { text: string; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const label = durationMs != null ? `thought for ${fmtDuration(durationMs)}` : 'thought';
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted hover:bg-surface-2"
      >
        <Brain size={12} className="shrink-0 text-faint" />
        <span className="italic">{label}</span>
        <ChevronRight size={12} className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <pre className="m-0 ml-2 mt-0.5 max-h-80 overflow-auto rounded-md border border-border-soft bg-surface-2 px-2.5 py-2 text-[11.75px] leading-[1.55] mono whitespace-pre-wrap break-words text-fg-soft scroll-thin">
          {text}
        </pre>
      )}
    </div>
  );
}
