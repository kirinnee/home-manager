// One transcript block, rendered top-to-bottom (no bubbles). Memoized so a
// live append or a header tick never re-renders existing rows.
//
//   user       — compact block, accent left-rail + faint fill, whitespace kept
//   assistant  — clean rendered markdown, no container chrome
//   thinking   — collapsed one-liner ("thought for 2m 14s"), expandable
//   tools      — delegated to <ToolGroup/>
//   turn       — ONE hairline per collapsed run of turn events, never per event
//   notice     — muted system row
//
// ASYMMETRIC DENSITY (see index.css). Two tiers, deliberately far apart:
//
//   prose  — 13–13.75px, full --fg, comfortable leading, generous margins.
//   chrome — `.kt-chrome`: 11px / 1.35, --faint at 78% opacity, one slim line,
//            no card, no border, no background at rest. Thinking lines, turn
//            boundaries and notices all use it, so "the machine noise recedes"
//            is one rule rather than five components drifting apart.
//
// Each row also declares its own vertical rhythm through `.kt-block` +
// data attributes, because the gap between a message and the next message is
// meant to be much larger than the gap between two tool groups. `previous` is
// passed in for exactly that: a message following the OTHER party gets the
// widest gap in the transcript, which is what makes turns readable without
// drawing a divider between them.

import { memo, useState } from 'react';
import { ChevronRight, Brain } from 'lucide-react';
import type { TranscriptBlock, ToolCall, PeerFrom } from '../lib/transcript';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolGroup';
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
  /** The block above this one — drives the speaker-change gap. */
  previous?: TranscriptBlock;
}

// buildTranscript() creates fresh block OBJECTS every rebuild, so default
// referential memo would re-render every row on each WS append (the streaming
// "jump"/churn source). Compare by stable id + the fields that actually affect
// output, so only the block whose content changed re-renders.
function callsEqual(a: ToolCall[], b: ToolCall[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.key !== y.key || !!x.result !== !!y.result || x.result?.isError !== y.result?.isError) return false;
  }
  return true;
}

function sameProps(prev: Props, next: Props): boolean {
  if (prev.live !== next.live || prev.isLast !== next.isLast) return false;
  // Only the PREVIOUS block's kind affects this row (via the rhythm attrs), so
  // comparing kind avoids re-rendering the whole transcript when a neighbour's
  // content changes.
  if (prev.previous?.kind !== next.previous?.kind) return false;
  const a = prev.block;
  const b = next.block;
  if (a.id !== b.id || a.kind !== b.kind) return false;
  if (a.kind === 'user') {
    const t = b as typeof a;
    return a.text === t.text && a.ts === t.ts && a.from?.name === t.from?.name;
  }
  if (a.kind === 'assistant') {
    return a.text === (b as typeof a).text && a.ts === (b as typeof a).ts;
  }
  if (a.kind === 'thinking') {
    return a.text === (b as typeof a).text && a.durationMs === (b as typeof a).durationMs;
  }
  if (a.kind === 'tools') return callsEqual(a.calls, (b as typeof a).calls);
  if (a.kind === 'turn') {
    const t = b as typeof a;
    return a.ts === t.ts && a.durationMs === t.durationMs && a.skipped === t.skipped && a.aborted === t.aborted;
  }
  if (a.kind === 'notice') return a.label === (b as typeof a).label;
  return false;
}

/** Which density tier a block belongs to — prose or machine chrome. */
function tierOf(kind: TranscriptBlock['kind']): 'message' | 'chrome' {
  return kind === 'user' || kind === 'assistant' ? 'message' : 'chrome';
}

export const TranscriptRow = memo(function TranscriptRow({ block, live, isLast, previous }: Props) {
  const kind = tierOf(block.kind);
  // A speaker change (user→assistant or back) is the widest gap in the
  // transcript. Intervening chrome does not break it: a reply that ran tools
  // first is still the other party starting to speak.
  const turnChange =
    kind === 'message' && previous !== undefined && tierOf(previous.kind) === 'message' && previous.kind !== block.kind;

  const body = (() => {
    switch (block.kind) {
      case 'user':
        return <UserMessage text={block.text} ts={block.ts} from={block.from} />;
      case 'assistant':
        return <AssistantMessage text={block.text} ts={block.ts} source={block.source} />;
      case 'thinking':
        return <ThinkingLine text={block.text} durationMs={block.durationMs} />;
      case 'tools':
        return <ToolGroup calls={block.calls} live={live} isLast={isLast} />;
      case 'turn':
        return <TurnBoundary block={block} />;
      case 'notice':
        return (
          <div className="kt-chrome mono truncate px-2" title={block.label}>
            {block.label}
          </div>
        );
    }
  })();

  return (
    <div
      className="kt-block"
      data-kind={kind}
      data-turn={turnChange ? 'true' : undefined}
      data-after={previous ? tierOf(previous.kind) : undefined}
    >
      {body}
    </div>
  );
}, sameProps);

// A turn boundary — ONE hairline for a whole run of turn events (see
// lib/transcript.ts). It earns its line by carrying the closed turn's duration
// and, when the run swallowed empty resume/nudge turns, how many. `aborted` is
// the only variant that gets colour, because it is the only one that means
// something went wrong.
//
// Density: the two flanking rules are gone. With messages now separated by real
// whitespace, a full-width double rule per turn was the single loudest piece of
// chrome on the page — for information (a turn ended) that the gap already
// implies. What is left is one faint centred label.
function TurnBoundary({ block }: { block: Extract<TranscriptBlock, { kind: 'turn' }> }) {
  const bits: string[] = [];
  if (block.aborted) bits.push('turn aborted');
  else if (block.durationMs != null) bits.push(`turn · ${fmtDuration(block.durationMs)}`);
  else bits.push('turn');
  if (block.skipped) bits.push(`${block.skipped} empty`);
  return (
    <div
      className={cn('kt-chrome mono select-none text-center', block.aborted && 'text-warn')}
      title={block.ts ? fmtClock(block.ts) : undefined}
    >
      {bits.join(' · ')}
    </div>
  );
}

// Assistant text: no per-message role label (role reads from layout — user
// blocks are railed + filled, assistant is plain prose). Metadata sits aside,
// revealed on hover: a slim left gutter rule + a timestamp that fades in.
function AssistantMessage({ text, ts }: { text: string; ts?: string; source: string }) {
  if (!text.trim()) return null;
  return (
    <div className="group relative pl-3">
      <span className="absolute left-0 top-1 bottom-1 w-px bg-border-soft opacity-0 transition-opacity group-hover:opacity-100" />
      {ts && (
        <span className="pointer-events-none absolute right-0 top-0.5 mono text-[10.5px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
          {fmtClock(ts)}
        </span>
      )}
      <Markdown text={text} />
    </div>
  );
}

/** Who sent a message, when it was another SESSION rather than the human.
 *
 *  Peer conversations were previously unreadable: a teammate's message rendered
 *  exactly like the lead's, so a thread between two agents looked like one
 *  agent talking to itself. The chip is small and quiet (it is metadata) but it
 *  is coloured, because WHO said something changes how the rest is read. */
function PeerChip({ from }: { from: PeerFrom }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-soft px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent"
      title={
        from.replyExpected
          ? `sent by teammate ${from.name}, which is parked waiting for a reply`
          : `sent by teammate ${from.name} (no reply expected)`
      }
    >
      {from.name}
      {from.replyExpected && <span className="font-normal normal-case tracking-normal opacity-80">· awaiting</span>}
    </span>
  );
}

function UserMessage({ text, ts, from }: { text: string; ts?: string; from?: PeerFrom }) {
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
    <div className="overflow-hidden rounded-md border border-l-[2.5px] border-border border-l-user-border bg-user-bg">
      <div className="flex items-center gap-2 px-2.5 pt-1">
        {/* A peer message says WHO instead of the generic "message": the sender
            is the most important thing about it. */}
        {from ? (
          <PeerChip from={from} />
        ) : (
          <span className="text-[10.5px] uppercase tracking-[0.12em] font-semibold text-accent">
            {isProtocol ? 'turn prompt' : 'message'}
          </span>
        )}
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
          className="block w-full px-2.5 pb-1.5 pt-0.5 text-left mono text-[12.5px] text-fg-soft truncate"
          title={preview}
        >
          {preview}
        </button>
      ) : (
        // Line-height stays comfortable INSIDE prose: readability of the words
        // outranks density, and the space this pass reclaimed came from chrome.
        <div className="px-2.5 pb-1.5 pt-0.5 text-[13px] leading-[1.55] whitespace-pre-wrap break-words text-fg">
          {text}
        </div>
      )}
    </div>
  );
}

// Thinking: one faint line at chrome size. Expanded, the body is still a real
// code surface — you opened it on purpose, so it should be readable.
function ThinkingLine({ text, durationMs }: { text: string; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const label = durationMs != null ? `thought for ${fmtDuration(durationMs)}` : 'thought';
  return (
    <div className="kt-chrome">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-px text-left hover:bg-surface-2"
      >
        <Brain size={10} className="shrink-0" />
        <span className="italic">{label}</span>
        <ChevronRight size={10} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <pre className="m-0 ml-2 mt-0.5 max-h-80 overflow-auto rounded-md border border-border-soft bg-surface-2 px-2.5 py-2 text-[11.75px] leading-[1.55] mono whitespace-pre-wrap break-words text-fg-soft scroll-thin">
          {text}
        </pre>
      )}
    </div>
  );
}
