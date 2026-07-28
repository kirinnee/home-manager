// One transcript block, rendered top-to-bottom. Memoized so a
// live append or a header tick never re-renders existing rows.
//
//   human user — right-aligned, family-themed bubble with spoken attribution
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

import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronRight, Brain, Info, Pin, PinOff } from 'lucide-react';
import {
  isInformativeTurnBoundary,
  peerFrom,
  type TranscriptBlock,
  type ToolCall,
  type PeerFrom,
  type SystemBlockInfo,
} from '../lib/transcript';
import { Markdown } from './Markdown';
import { ToolGroup } from './ToolGroup';
import { TranscriptImageGallery } from './AttachmentImage';
import { LedgerMessage } from './LedgerMessage';
import type { StoredTranscriptImage, TranscriptImage } from '../lib/attachments';
import { displayCallsign } from '../lib/callsign';
import { cn, fmtClock } from '../lib/utils';
import { isMessagePinned, pinsStore, type PinBlockKind } from '../lib/pins';
import { getForegroundSession } from '../lib/pin-bridge';
import { TOUCH_SELECTION_DWELL_MS } from '../hooks/useLiveTick';
import { useSidePane } from './SidePane';

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

// Context boundaries stay in the established industrial/chrome language, but
// earn a full-width rule and a compact raised disclosure so they cannot be
// mistaken for ordinary harness noise. Exported only to pin the phone-width and
// divider geometry in the DOM-free unit suite.
export const SYSTEM_DIVIDER_LAYOUT = Object.freeze({
  track: 'flex min-w-0 items-center gap-2 py-1',
  rule: 'h-px min-w-3 flex-1 bg-border-soft',
  button:
    'max-w-[88%] rounded-control border border-border-soft bg-surface-2 px-2.5 py-0.5 text-fg-soft shadow-sm hover:border-accent-border',
});

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
  sessionId?: string;
  onResendLedger?: (record: Extract<TranscriptBlock, { kind: 'ledger' }>['record']) => Promise<boolean>;
  /** Input modality, resolved ONCE by Transcript and threaded down rather than
   *  subscribed per row (thousands of rows must not each hold a media listener).
   *  Selects the pin affordance: a tap-revealed bar on touch, a hover/focus
   *  button on a mouse. */
  touch?: boolean;
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
    if (!transcriptImagesEqual(x.images, y.images)) return false;
  }
  return true;
}

export function transcriptImagesEqual(a?: TranscriptImage[], b?: TranscriptImage[]): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  return (a ?? []).every((image, index) => {
    const other = b![index]!;
    if (image.kind !== other.kind) return false;
    if (image.kind === 'inline') {
      return other.kind === 'inline' && image.alt === other.alt && image.src === other.src;
    }
    return (
      other.kind === 'attachment' &&
      image.sessionId === other.sessionId &&
      image.attachmentId === other.attachmentId &&
      image.filename === other.filename &&
      image.mime === other.mime &&
      image.size === other.size &&
      image.alt === other.alt
    );
  });
}

function sameProps(prev: Props, next: Props): boolean {
  if (
    prev.live !== next.live ||
    prev.isLast !== next.isLast ||
    prev.touch !== next.touch ||
    prev.sessionId !== next.sessionId
  )
    return false;
  // Only the PREVIOUS block's kind affects this row (via the rhythm attrs), so
  // comparing kind avoids re-rendering the whole transcript when a neighbour's
  // content changes.
  if (prev.previous?.kind !== next.previous?.kind) return false;
  const a = prev.block;
  const b = next.block;
  if (a.id !== b.id || a.kind !== b.kind) return false;
  if (a.kind === 'user') {
    const t = b as typeof a;
    return (
      a.text === t.text &&
      a.ts === t.ts &&
      a.from?.name === t.from?.name &&
      a.from?.replyExpected === t.from?.replyExpected &&
      transcriptImagesEqual(a.attachments, t.attachments)
    );
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
  if (a.kind === 'ledger') {
    const t = b as typeof a;
    return (
      a.record === t.record &&
      a.placement === t.placement &&
      a.asOf === t.asOf &&
      prev.sessionId === next.sessionId &&
      prev.onResendLedger === next.onResendLedger
    );
  }
  return false;
}

/** Which density tier a block belongs to — prose or machine chrome. */
function tierOf(kind: TranscriptBlock['kind']): 'message' | 'chrome' {
  return kind === 'user' || kind === 'assistant' || kind === 'ledger' ? 'message' : 'chrome';
}

function speakerOf(block: TranscriptBlock): 'user' | 'assistant' | undefined {
  if (block.kind === 'user' || block.kind === 'ledger') return 'user';
  return block.kind === 'assistant' ? 'assistant' : undefined;
}

/** The text a message pin stores as its preview, so the pin stays legible even
 *  when its target block is not loaded (see lib/pins.ts). Kept close to the row
 *  because it must mirror what the row actually shows. */
export function pinPreviewOf(block: TranscriptBlock): string {
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
      return block.text;
    case 'ledger':
      return peerFrom(block.record.message).body;
    case 'tools':
      return (
        block.calls
          .map(call => call.use?.name ?? call.key)
          .filter(Boolean)
          .join(', ') || 'tool calls'
      );
    case 'system':
      return block.info.summary || block.info.label || block.info.raw || 'system';
    case 'notice':
      return block.label;
    default:
      return '';
  }
}

/** Turn boundaries and live-view ledger rows are un-pinnable. A ledger row can
 * age out at hardDeadline while remaining only in the audit log, so promising a
 * permanent transcript jump target for it would create a knowingly broken pin. */
export function isPinnable(block: TranscriptBlock): boolean {
  return block.kind !== 'turn' && block.kind !== 'ledger';
}

// The pin affordance. TWO paths, ZERO resting cost, and NO hover-only surface —
// the three constraints the transcript's own history spells out (TranscriptRow
// header, the 80px lesson; pinning-design.md §5):
//
//   DESKTOP  — a small pin button revealed on `group-hover/pin` AND on
//              `focus-visible`. It is always in the tab order (a keyboard user's
//              first-class path), but `pointer-events-none` + `opacity-0` at
//              rest so it reserves no space and cannot be tapped by accident on
//              touch, where hover never fires.
//   TOUCH    — a plain tap on the block toggles a slim action bar beneath it
//              (Pin/Unpin), dismissed by scroll, an outside tap, or the action.
//              Duration + movement are part of the tap decision: the selection
//              range can still be collapsed at the pointerup of an iOS/Android
//              long-press, so sampling window.getSelection() alone would mount
//              this bar INSIDE the selected row and destroy the native range.
//
// The session id comes from the foreground bridge, never a prop — only the
// foreground pane is interactable, and it is the one that declared itself.
function PinControls({
  block,
  touch,
  barOpen,
  setBarOpen,
}: {
  block: TranscriptBlock;
  touch: boolean;
  barOpen: boolean;
  setBarOpen: (open: boolean) => void;
}) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const sessionId = getForegroundSession();
  const pinned = sessionId ? isMessagePinned(pinsStore.getSnapshot(), sessionId, block.id) : false;

  const toggle = () => {
    const sid = getForegroundSession();
    if (!sid) return;
    const ts = (block as { ts?: string }).ts;
    pinsStore.toggleMessage(sid, {
      blockId: block.id,
      blockKind: block.kind as PinBlockKind,
      preview: pinPreviewOf(block),
      ...(ts ? { ts } : {}),
    });
    bump();
    setBarOpen(false);
  };

  const label = pinned ? 'Unpin this message' : 'Pin this message';
  const Icon = pinned ? PinOff : Pin;

  return (
    <>
      {/* DESKTOP: hover/focus-visible reveal, in tab order, inert at rest. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        aria-pressed={pinned}
        className={cn(
          'absolute right-0 top-0 z-10 hidden h-7 w-7 items-center justify-center rounded-control border border-border bg-surface text-muted opacity-0 transition-opacity',
          'pointer-events-none sm:inline-flex',
          'group-hover/pin:pointer-events-auto group-hover/pin:opacity-100',
          'focus-visible:pointer-events-auto focus-visible:opacity-100 hover:text-accent',
          pinned && 'text-accent',
        )}
      >
        <Icon size={13} aria-hidden="true" />
      </button>

      {/* TOUCH: the tap-revealed action bar. */}
      {touch && barOpen && (
        <div className="mt-1 flex items-center justify-end gap-sm" data-pin-bar>
          <button
            type="button"
            onClick={toggle}
            aria-label={label}
            className="inline-flex min-h-[44px] items-center gap-xs rounded-control border border-border px-cell-x text-cell font-medium text-fg-soft hover:border-accent-border hover:text-accent"
          >
            <Icon size={14} aria-hidden="true" />
            {pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            type="button"
            onClick={() => setBarOpen(false)}
            aria-label="Close pin menu"
            className="inline-flex min-h-[44px] items-center rounded-control px-cell-x text-cell text-muted hover:text-fg"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

/** A deliberate tap stays within a movement budget. Native text selection
 *  requires a dwell, while transcript scrolling/handle dragging moves; either
 *  signal vetoes a row mutation even when the native range is still collapsed
 *  at pointerup. The shared 350ms dwell cutoff intentionally precedes the usual
 *  ~500ms native long-press: the safety gap avoids mounting Pin UI while the
 *  browser is deciding whether to begin selection. */
const BLOCK_TAP_SLOP_PX = 12;

export interface BlockTapGesture {
  durationMs: number;
  distancePx: number;
  primary: boolean;
  pointerType: string;
}

/** Is a gesture a plain tap that should reveal the pin bar — i.e. not a native
 *  selection dwell/handle drag and not a press on another interactive control?
 *  Exported and DOM-shaped-but-injectable so the decision is unit-testable. */
export function isPlainBlockTap(target: Element | null, hasSelection: boolean, gesture: BlockTapGesture): boolean {
  if (
    hasSelection ||
    !gesture.primary ||
    (gesture.pointerType !== 'mouse' && gesture.durationMs >= TOUCH_SELECTION_DWELL_MS) ||
    gesture.distancePx > BLOCK_TAP_SLOP_PX
  )
    return false;
  if (!target) return true;
  return !target.closest('a, button, input, textarea, summary, [role="button"], [data-pin-bar]');
}

export interface BlockTapPointerEventLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  timeStamp: number;
  isPrimary: boolean;
  button: number;
  target: EventTarget | null;
}

export interface BlockTapPointerHandlers {
  onPointerDown(event: BlockTapPointerEventLike): void;
  onPointerMove(event: BlockTapPointerEventLike): void;
  onPointerUp(event: BlockTapPointerEventLike): void;
  onPointerCancel(): void;
}

/** The exact row event handlers used in production, exported so the DOM-free
 *  suite can drive pointerdown→pointerup rather than testing only the final tap
 *  predicate. State lives in this closure, so a parent render during a gesture
 *  cannot erase or manufacture a Pin-bar tap. */
export function createBlockTapPointerHandlers(options: {
  hasSelection(): boolean;
  onPlainTap(): void;
}): BlockTapPointerHandlers {
  let start: {
    pointerId: number;
    pointerType: string;
    x: number;
    y: number;
    at: number;
    maxDistance: number;
  } | null = null;

  return {
    onPointerDown: event => {
      if (!event.isPrimary || event.button !== 0) {
        start = null;
        return;
      }
      start = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        maxDistance: 0,
      };
    },
    onPointerMove: event => {
      if (!start || event.pointerId !== start.pointerId) return;
      start.maxDistance = Math.max(start.maxDistance, Math.hypot(event.clientX - start.x, event.clientY - start.y));
    },
    onPointerUp: event => {
      const gestureStart = start;
      start = null;
      if (!gestureStart || event.pointerId !== gestureStart.pointerId) return;
      const distancePx = Math.max(
        gestureStart.maxDistance,
        Math.hypot(event.clientX - gestureStart.x, event.clientY - gestureStart.y),
      );
      if (
        isPlainBlockTap(event.target as Element | null, options.hasSelection(), {
          durationMs: Math.max(0, event.timeStamp - gestureStart.at),
          distancePx,
          primary: event.isPrimary,
          pointerType: gestureStart.pointerType || event.pointerType,
        })
      )
        options.onPlainTap();
    },
    onPointerCancel: () => {
      start = null;
    },
  };
}

export const TranscriptRow = memo(function TranscriptRow({
  block,
  live,
  isLast,
  previous,
  sessionId = '',
  onResendLedger,
  touch = false,
}: Props) {
  // Hooks run unconditionally, before the turn-noise early-return below — a given
  // row is always noise or never, so the hook order per instance is stable.
  const [barOpen, setBarOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const pinnable = isPinnable(block);
  const blockTapHandlers = useMemo(
    () =>
      createBlockTapPointerHandlers({
        hasSelection: () => {
          const selection = typeof window !== 'undefined' ? window.getSelection() : null;
          return !!selection && !selection.isCollapsed && selection.rangeCount > 0;
        },
        onPlainTap: () => setBarOpen(open => !open),
      }),
    [],
  );
  const rowPointerHandlers = touch && pinnable ? blockTapHandlers : {};

  // TOUCH dismissal: once the bar is open, any scroll of the transcript or a tap
  // outside this row closes it — the bar is a transient, not a mode.
  useEffect(() => {
    if (!barOpen) return undefined;
    const close = () => setBarOpen(false);
    const onDocDown = (event: Event) => {
      if (rowRef.current && !rowRef.current.contains(event.target as Node)) setBarOpen(false);
    };
    const scroller = rowRef.current?.closest('[data-density-region="transcript-scroller"]');
    // Mounting the bar increases this row's height. While following the tail,
    // Transcript's ResizeObserver answers that layout change with a programmatic
    // re-pin; attaching immediately made that self-authored scroll close the bar
    // in the same frame it opened. Arm only after layout/observer work settles;
    // later reader scrolling still dismisses it normally.
    const scrollArmTimer = setTimeout(() => scroller?.addEventListener('scroll', close, { passive: true }), 100);
    document.addEventListener('pointerdown', onDocDown, { capture: true });
    return () => {
      clearTimeout(scrollArmTimer);
      scroller?.removeEventListener('scroll', close);
      document.removeEventListener('pointerdown', onDocDown, { capture: true } as EventListenerOptions);
    };
  }, [barOpen]);

  // Suppress before creating `.kt-block`: transcript rows are flex items, so
  // an empty wrapper would still retain its speaker-rhythm margin as a gap.
  if (block.kind === 'turn' && !isInformativeTurnBoundary(block)) return null;

  const kind = tierOf(block.kind);
  // TOUCH only: a plain tap on the block reveals the pin bar. The controller
  // tracks the complete gesture without renders because selection can still
  // look collapsed at long-press release. A dwell or movement is native
  // selection/scrolling, never permission to insert a bar inside this row.
  // A speaker change (user→assistant or back) is the widest gap in the
  // transcript. Intervening chrome does not break it: a reply that ran tools
  // first is still the other party starting to speak.
  const turnChange =
    kind === 'message' &&
    previous !== undefined &&
    tierOf(previous.kind) === 'message' &&
    speakerOf(previous) !== speakerOf(block);

  const body = (() => {
    switch (block.kind) {
      case 'user':
        return <UserMessage text={block.text} ts={block.ts} from={block.from} attachments={block.attachments} />;
      case 'assistant':
        return <AssistantMessage text={block.text} ts={block.ts} source={block.source} sessionId={sessionId} />;
      case 'thinking':
        return <ThinkingLine text={block.text} durationMs={block.durationMs} />;
      case 'tools':
        return (
          <>
            <ToolGroup calls={block.calls} live={live} isLast={isLast} />
            <TranscriptImageGallery
              images={block.calls.flatMap(call => call.images ?? [])}
              initialLimit={4}
              className="px-2 pt-1"
            />
          </>
        );
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
      case 'ledger':
        return (
          <LedgerMessage
            record={block.record}
            sessionId={sessionId}
            placement={block.placement}
            asOf={block.asOf}
            onResend={onResendLedger}
          />
        );
    }
  })();

  return (
    <div
      ref={rowRef}
      // `group/pin` + `relative` scope the desktop pin button's hover/focus
      // reveal and its absolute placement to THIS row without disturbing the
      // assistant body's own `group` (ASSISTANT_LAYOUT.wrap).
      className="kt-block group/pin relative min-w-0"
      // The scroll controller's prepend anchor looks a block up by id to restore
      // its exact position when an older page loads (see Transcript.tsx). The pin
      // jump resolves the same attribute.
      data-block-id={block.id}
      data-kind={kind}
      data-turn={turnChange ? 'true' : undefined}
      data-after={previous ? tierOf(previous.kind) : undefined}
      {...rowPointerHandlers}
    >
      {body}
      {pinnable && <PinControls block={block} touch={touch} barOpen={barOpen} setBarOpen={setBarOpen} />}
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
// turns move right, peers carry a sender chip, assistant is plain prose).
//
// ASSISTANT PROSE IS FLUSH. Every layout class here is measured against one
// rule: space may only be reserved for an affordance that can actually appear
// at that width. Two reserves failed that rule and are gone:
//
//  - The hover rail (a `w-px` rule in a `pl-3` indent) cost 12px of every
//    line at every width to reveal 1px of decoration on hover. On touch, where
//    hover never fires, it was 12px of permanent loss for something that could
//    never be seen; on a desktop it bought an ornament with body width. No
//    replacement ornament is planned — speaker asymmetry is already carried by
//    right-aligned human bubbles and the peer card's accent edge.
//  - The phone timestamp column. THE TIMESTAMP STILL NEEDS ITS OWN COLUMN
//    WHERE IT IS SHOWN: positioning it at `right-0` over full-width prose means
//    it lands ON the first line whenever that line reaches the right edge and
//    the glyphs interleave (reported live: "can i restart this?" with 22:56:19
//    drawn through it; measured 4 collisions at 1440px, 11 at 390px). So at
//    `sm+` the gutter stays RESERVED, not borrowed — inline content wraps
//    before it can reach the stamp, and it is reserved unconditionally because
//    a padding that appeared on hover would reflow the paragraph under the
//    cursor and knock the transcript out of follow.
//    Below `sm` there is nothing to reserve FOR: hover cannot fire, so the
//    stamp is `hidden` and its 68px column would be dead space on the width
//    that can least afford it (measured: 268px of prose on a 390px screen).
//    Clock context on phones lives in turn boundaries and system rows.
//
// Exported as data so the reserve contract is assertable without a DOM (this
// package has no DOM implementation); see `TranscriptRow.test.ts`.
export const ASSISTANT_LAYOUT = {
  /** No horizontal padding/margin of any kind: prose starts at the content edge. */
  wrap: 'group relative min-w-0',
  /** Desktop-only right column: 50px clock + 4px gap + the 28px pin button that
   *  shares this corner, plus its 4px gap. Both reveal on the SAME hover, so the
   *  clock is offset left of the pin rather than under it. */
  gutter: 'sm:pr-[86px]',
  /** Hover-revealed clock, mounted for layout only at `sm+`. Offset by the pin's
   *  28px + 4px so the two never overlap — they appear together on hover. */
  stamp:
    'pointer-events-none absolute right-[32px] top-0.5 hidden w-[50px] text-right mono text-2xs tabular-nums text-faint opacity-0 transition-opacity sm:block group-hover:opacity-100',
} as const;

function AssistantMessage({ text, ts, sessionId }: { text: string; ts?: string; source: string; sessionId?: string }) {
  const sidePane = useSidePane();
  if (!text.trim()) return null;
  return (
    <div className={cn(ASSISTANT_LAYOUT.wrap, ts && ASSISTANT_LAYOUT.gutter)}>
      {ts && <span className={ASSISTANT_LAYOUT.stamp}>{clockLabel(ts)}</span>}
      <Markdown
        text={text}
        sessionId={sessionId}
        cwd={sidePane?.cwd}
        onTaskOpen={sidePane?.openTask}
        onCodeReferenceOpen={sidePane?.openCodeReference}
      />
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
  const name = displayCallsign(from.name);
  return (
    <span
      className="kt-badge min-w-0 max-w-full truncate"
      data-tone="accent"
      title={
        from.replyExpected
          ? `sent by teammate ${name}, which is parked waiting for a reply`
          : `sent by teammate ${name} (no reply expected)`
      }
    >
      {name}
      {from.replyExpected && <span className="font-normal normal-case tracking-normal opacity-80">· awaiting</span>}
    </span>
  );
}

function UserMessage({
  text,
  ts,
  from,
  attachments = [],
}: {
  text: string;
  ts?: string;
  from?: PeerFrom;
  attachments?: StoredTranscriptImage[];
}) {
  const sidePane = useSidePane();
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
        {text && collapsible && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="block min-w-0 max-w-full truncate px-panel pb-1.5 pt-0.5 text-left mono text-ui text-fg-soft"
            title={preview}
          >
            {preview}
          </button>
        ) : text ? (
          <Markdown
            text={text}
            // A peer may come from another repository and PeerFrom does not
            // carry authoritative filesystem provenance. Fleet task ids are
            // safe to route; code-shaped text deliberately stays inert.
            onTaskOpen={sidePane?.openTask}
            className="kt-user-copy min-w-0 max-w-full px-panel pb-1.5 pt-0.5 text-row leading-base break-words text-fg"
          />
        ) : null}
        <TranscriptImageGallery images={attachments} className="px-panel pb-2 pt-1" />
      </div>
    );
  }

  return (
    <div className="kt-bubble-row">
      <span className="sr-only">You said:</span>
      <div className="kt-bubble">
        {(ts || collapsible) && (
          <div className="flex min-w-0 items-center gap-2 px-panel pt-1">
            {/* In FLOW, never absolute: the timestamp cannot collide with prose
                at either desktop or phone widths. */}
            {ts && (
              <span className="mono shrink-0 whitespace-nowrap text-2xs tabular-nums text-muted">{clockLabel(ts)}</span>
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
        {text && collapsible && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="block min-w-0 max-w-full truncate px-panel pb-1.5 pt-0.5 text-left mono text-ui text-[color:var(--bubble-fg)]"
            title={preview}
          >
            {preview}
          </button>
        ) : text ? (
          // Line-height stays comfortable INSIDE prose: readability of the
          // words outranks density; this pass reclaims chrome, not leading.
          <div className="kt-user-copy min-w-0 max-w-full px-panel pb-1.5 pt-0.5 text-row leading-base whitespace-pre-wrap break-words text-[color:var(--bubble-fg)]">
            {text}
          </div>
        ) : null}
        <TranscriptImageGallery images={attachments} className="px-panel pb-2 pt-1" />
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
  const divider = info.divider !== undefined;
  return (
    <div
      className={cn('kt-chrome', divider && 'text-fg-soft')}
      data-system-row={info.label}
      data-divider={info.divider}
    >
      <div className={cn(divider && SYSTEM_DIVIDER_LAYOUT.track)}>
        {divider && (
          <span
            role="separator"
            aria-label={`${info.label} boundary`}
            aria-orientation="horizontal"
            className={SYSTEM_DIVIDER_LAYOUT.rule}
          />
        )}
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-left hover:bg-surface-2',
            divider ? SYSTEM_DIVIDER_LAYOUT.button : 'w-full rounded-control px-2 py-px',
          )}
        >
          <Info size={10} className={cn('shrink-0', divider && 'text-accent')} aria-hidden="true" />
          {/* Label and status are CAPPED and truncate: an unknown wrapper's tag
              name (or a long status) can be arbitrarily long, and un-capped
              shrink-0 spans would widen the row past a 390px viewport. Known
              labels ("task notification", "environment_context") fit within 22ch,
              so only genuinely long unknown tags ellipsize. The summary stays the
              flexible line, and the raw body is fully readable on expand. */}
          <span
            className={cn(
              'min-w-0 max-w-[22ch] shrink truncate font-medium',
              divider && 'mono uppercase tracking-label',
            )}
          >
            {info.label}
          </span>
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
        {divider && <span aria-hidden="true" className={SYSTEM_DIVIDER_LAYOUT.rule} />}
      </div>
      {open && (
        <pre className="m-0 ml-2 mt-0.5 max-h-80 max-w-full min-w-0 overflow-auto rounded-md border border-border-soft bg-surface-2 px-2.5 py-2 text-code leading-base mono whitespace-pre-wrap break-words text-fg-soft scroll-thin">
          {info.raw}
        </pre>
      )}
    </div>
  );
}
