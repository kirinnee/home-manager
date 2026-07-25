// One transcript block, rendered top-to-bottom (no bubbles). Memoized so a
// live append or a header tick never re-renders existing rows.
//
//   human user — unboxed prose led once by the accent `>>>` prompt marker
//   peer user  — sender chip + the existing quiet peer card treatment
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
import { ChevronRight, Brain, Info } from 'lucide-react';
import type { TranscriptBlock, ToolCall, PeerFrom, SystemBlockInfo } from '../lib/transcript';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolGroup';
import { cn, fmtClock } from '../lib/utils';

const PROTOCOL_HEADER = /#\s*(AGENTS\.md instructions|SYSTEM\s*PROMPT|INSTRUCTIONS)/i;
const LONG_USER_LINES = 16;

// System-row status chip: tone colours the WORD (never colour alone — the status
// text is always present for readers who don't perceive the hue). Reuses the
// existing tone utilities, so no new theme tokens.
const TONE_CLASS: Record<'ok' | 'warn' | 'err', string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

// A transcript timestamp is only ever a wall clock (`HH:MM:SS`, 8 chars). But
// `fmtClock` (utils.ts) echoes its raw input verbatim when the value is not a
// parseable date, and that raw string is UNBOUNDED — a malformed `ts` would then
// render at full length inside a `shrink-0 whitespace-nowrap` stamp and widen the
// row past the viewport, breaking the transcript's scrollWidth ≤ clientWidth
// gate. So bound every stamp here: pass a well-formed clock through, otherwise
// show a fixed short placeholder. Kept local to the transcript because other
// `fmtClock` callers may legitimately want the raw fallback.
function clockLabel(ts?: string): string {
  const s = fmtClock(ts);
  return /^\d{2}:\d{2}:\d{2}$/.test(s) ? s : '—';
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
  if (a.kind === 'system') {
    // raw is the superset of every derived field, so comparing it (plus ts)
    // is sufficient — a stable history record's raw never changes in place.
    const t = b as typeof a;
    return a.info.raw === t.info.raw && a.ts === t.ts;
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
      case 'system':
        return <SystemRow info={block.info} ts={block.ts} />;
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
      className="kt-block min-w-0"
      // The scroll controller's prepend anchor looks a block up by id to restore
      // its exact position when an older page loads (see Transcript.tsx).
      data-block-id={block.id}
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

// Assistant text: no per-message role label (role reads from layout — human
// turns are prompt-led, peers carry a sender chip, assistant is plain prose).
// Metadata sits aside, revealed on hover: a slim left gutter rule + a timestamp
// that fades in.
//
// THE TIMESTAMP NEEDS ITS OWN COLUMN. Absolutely positioning it at `right-0`
// over prose that occupies the full width means it lands ON the first line
// whenever that line reaches the right edge — the glyphs interleave and both the
// message and the time become unreadable (reported from a live session:
// "can i restart this?" with 22:56:19 drawn through it; measured 4 colliding
// stamps at 1440px and 11 at 390px on one loaded transcript).
//
// So the gutter is RESERVED, not borrowed: `pr-[68px]` on phones shrinks the
// content box, the stamp is positioned inside that padding, and inline content
// therefore wraps before it can reach the stamp. Guaranteed at every width, not
// tuned per breakpoint. Reserving it unconditionally (rather than only on hover)
// is deliberate: a padding that appears on hover would reflow the paragraph under
// the cursor, and a reflow mid-stream is exactly what knocks the transcript out
// of follow.
// A full monospace HH:MM:SS clock measures 62px at `text-2xs`; on a phone,
// leave 2px of breathing room inside its 64px column and 4px before the prose.
// The wider desktop padding already contains the former 50px column, so retain
// that established desktop measure.
const TS_GUTTER = 'pr-[68px] sm:pr-[54px]';

function AssistantMessage({ text, ts }: { text: string; ts?: string; source: string }) {
  if (!text.trim()) return null;
  return (
    <div className={cn('group relative min-w-0 pl-3', ts && TS_GUTTER)}>
      <span className="absolute left-0 top-1 bottom-1 w-px bg-border-soft opacity-0 transition-opacity group-hover:opacity-100" />
      {ts && (
        <span className="pointer-events-none absolute right-0 top-0.5 w-[64px] sm:w-[50px] text-right mono text-2xs tabular-nums text-faint opacity-0 transition-opacity group-hover:opacity-100">
          {clockLabel(ts)}
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
      className="kt-badge min-w-0 max-w-full truncate"
      data-tone="accent"
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

  if (from) {
    // Peer messages keep the existing card + sender chip: WHO spoke is the
    // essential distinction when one session is talking to another.
    return (
      <div className="min-w-0 overflow-hidden rounded-panel border border-l-[2.5px] border-border border-l-user-border bg-user-bg">
        <div className="flex min-w-0 items-center gap-2 px-panel pt-1">
          <PeerChip from={from} />
          {ts && (
            <span className="mono shrink-0 whitespace-nowrap text-2xs tabular-nums text-faint">{clockLabel(ts)}</span>
          )}
          {collapsible && (
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta text-muted hover:text-fg"
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
            className="block min-w-0 max-w-full truncate px-panel pb-1.5 pt-0.5 text-left mono text-ui text-fg-soft"
            title={preview}
          >
            {preview}
          </button>
        ) : (
          <div className="kt-user-copy min-w-0 max-w-full px-panel pb-1.5 pt-0.5 text-row leading-base whitespace-pre-wrap break-words text-fg">
            {text}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-start gap-2 pt-0.5">
      {/* Once per transcript block is deliberate. Repeating this for source
          lines would bloat long pastes, and wrapped visual lines would still be
          inconsistent as the viewport changed. One stable leader supplies the
          requested shell-prompt attribution while the min-width:0 text column
          gives every wrapped line a clean hanging indent. */}
      <span className="sr-only">You said:</span>
      <span
        className="mono shrink-0 select-none whitespace-nowrap text-row font-semibold leading-base text-accent"
        aria-hidden="true"
      >
        &gt;&gt;&gt;
      </span>
      <div className="min-w-0 flex-1">
        {(ts || collapsible) && (
          <div className="flex min-w-0 items-center gap-2">
            {/* In FLOW, never absolute: the timestamp cannot collide with prose
                at either desktop or phone widths. */}
            {ts && (
              <span className="mono shrink-0 whitespace-nowrap text-2xs tabular-nums text-faint">{clockLabel(ts)}</span>
            )}
            {collapsible && (
              <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta text-muted hover:text-fg"
              >
                <span>{open ? 'collapse' : `${lines.length} lines`}</span>
                <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} />
              </button>
            )}
          </div>
        )}
        {collapsible && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="block min-w-0 max-w-full truncate pb-1.5 pt-0.5 text-left mono text-ui text-fg-soft"
            title={preview}
          >
            {preview}
          </button>
        ) : (
          // Line-height stays comfortable INSIDE prose: readability of the
          // words outranks density; this pass reclaims chrome, not leading.
          <div className="kt-user-copy min-w-0 max-w-full pb-1.5 pt-0.5 text-row leading-base whitespace-pre-wrap break-words text-fg">
            {text}
          </div>
        )}
      </div>
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
        className="flex w-full min-w-0 items-center gap-1.5 rounded-control px-2 py-px text-left hover:bg-surface-2"
      >
        <Brain size={10} className="shrink-0" />
        <span className="italic">{label}</span>
        <ChevronRight size={10} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <pre className="m-0 ml-2 mt-0.5 max-h-80 max-w-full min-w-0 overflow-auto rounded-md border border-border-soft bg-surface-2 px-2.5 py-2 text-code leading-base mono whitespace-pre-wrap break-words text-fg-soft scroll-thin">
          {text}
        </pre>
      )}
    </div>
  );
}

// A harness-INJECTED system text (task notification, turn prompt,
// environment_context, interrupt notice, …) rendered as ONE slim chrome line —
// the same "machine noise recedes" treatment as ThinkingLine, so it needs no CSS
// of its own and is structurally SHORTER than the user card it replaces (mobile
// density budgets are unaffected). Collapsed by default, always: 1,584 turn
// prompts is the argument. Clicking reveals the full raw text, so nothing the
// classifier derived a summary from is ever dropped.
//
// The summary truncates and the expanded body wraps/scrolls locally, so the row
// never widens its ancestor — the transcript's scrollWidth ≤ clientWidth gate
// holds at every width even with a ~180-char output-file path expanded.
//
// data-kind stays 'chrome' (set on the outer .kt-block) for the rhythm contract;
// `data-system-row` here is a stable, non-styling semantic hook carrying the
// classification label for tests/assertions.
function SystemRow({ info, ts }: { info: SystemBlockInfo; ts?: string }) {
  const [open, setOpen] = useState(false);
  const toneClass = info.tone ? TONE_CLASS[info.tone] : undefined;
  return (
    <div className="kt-chrome" data-system-row={info.label}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-control px-2 py-px text-left hover:bg-surface-2"
      >
        <Info size={10} className="shrink-0" aria-hidden="true" />
        {/* Label and status are CAPPED and truncate: an unknown wrapper's tag
            name (or a long status) can be arbitrarily long, and un-capped
            shrink-0 spans would widen the row past a 390px viewport. Known
            labels ("task notification", "environment_context") fit within 22ch,
            so only genuinely long unknown tags ellipsize. The summary stays the
            flexible line, and the raw body is fully readable on expand. */}
        <span className="min-w-0 max-w-[22ch] shrink truncate font-medium">{info.label}</span>
        {info.summary ? (
          <>
            <span className="shrink-0 opacity-50" aria-hidden="true">
              ·
            </span>
            <span className="min-w-0 flex-1 truncate opacity-80">{info.summary}</span>
          </>
        ) : (
          <span className="flex-1" aria-hidden="true" />
        )}
        {info.status && (
          <span className={cn('min-w-0 max-w-[14ch] shrink truncate font-medium', toneClass)}>{info.status}</span>
        )}
        {ts && <span className="mono shrink-0 whitespace-nowrap tabular-nums text-faint">{clockLabel(ts)}</span>}
        <ChevronRight size={10} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <pre className="m-0 ml-2 mt-0.5 max-h-80 max-w-full min-w-0 overflow-auto rounded-md border border-border-soft bg-surface-2 px-2.5 py-2 text-code leading-base mono whitespace-pre-wrap break-words text-fg-soft scroll-thin">
          {info.raw}
        </pre>
      )}
    </div>
  );
}
