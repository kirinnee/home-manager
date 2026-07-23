// The transcript scroll region, built on @shadcn/react's headless
// MessageScroller (used for structure + preserveScrollOnPrepend). Scroll
// behaviour (round 3, live-session calm) is hand-rolled for correctness:
//
//   - STICK-TO-BOTTOM via a ResizeObserver on the content: whenever content
//     height changes AND the reader is following (at the very bottom), we pin
//     to the bottom. The observer fires AFTER layout, so streaming blocks that
//     grow in place (a merged assistant message gaining tokens) or lay out
//     late (markdown/code/images) can't leave the tail "stuck short" — the
//     round-1/round-3 bug. autoScroll is OFF because it only reacts to new
//     items, not in-place growth.
//   - NO jump while detached: if the reader scrolled up, height changes never
//     move the viewport; new tail blocks are counted for an "N new — jump to
//     latest" pill instead.
//   - preserveScrollOnPrepend keeps the viewport steady when older pages load.
//
// Not virtualized; tail-first pagination underneath keeps only the loaded
// window in the DOM (see SessionChatPage.loadOlder).

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { ArrowDown } from 'lucide-react';
import type { TranscriptBlock } from '../lib/transcript';
import { TranscriptRow } from './TranscriptRow';

interface Props {
  blocks: TranscriptBlock[];
  live: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  pinSignal: number;
  header?: ReactNode;
  footer?: ReactNode;
}

const AT_BOTTOM_PX = 96;

function Inner({ blocks, live, hasOlder, loadingOlder, onLoadOlder, pinSignal, header, footer }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true); // are we stuck to the bottom?
  const [detached, setDetached] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const prevLastId = useRef<string | null>(null);
  const last = blocks.length - 1;
  const lastId = blocks.length ? blocks[last]!.id : null;

  const viewport = () => rootRef.current?.querySelector<HTMLElement>('.kt-viewport') ?? null;
  const pin = () => {
    const v = viewport();
    if (v) v.scrollTop = v.scrollHeight;
  };

  // Stick-to-bottom: re-pin on ANY content resize while following. Fires after
  // layout, so late/growing heights never leave the tail short.
  useEffect(() => {
    const v = viewport();
    const content = rootRef.current?.querySelector<HTMLElement>('.kt-content');
    if (!v || !content) return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) v.scrollTop = v.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Initial settle to the true tail (and whenever the page bumps pinSignal).
  useEffect(() => {
    if (pinSignal <= 0) return;
    followRef.current = true;
    setDetached(false);
    setNewCount(0);
    const raf = requestAnimationFrame(pin);
    const t = setTimeout(pin, 160);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinSignal]);

  // New tail content while scrolled up → count it for the pill. (The follow
  // case is handled entirely by the ResizeObserver.)
  useEffect(() => {
    const prev = prevLastId.current;
    if (lastId && prev !== null && lastId !== prev && !followRef.current) {
      const idx = blocks.findIndex(b => b.id === prev);
      const added = idx >= 0 ? blocks.length - 1 - idx : 1;
      setNewCount(c => c + Math.max(1, added));
    }
    prevLastId.current = lastId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = gap < AT_BOTTOM_PX;
    followRef.current = atBottom;
    setDetached(!atBottom);
    if (atBottom && newCount) setNewCount(0);
    if (el.scrollTop < 280 && hasOlder && !loadingOlder) onLoadOlder();
  }

  function jump() {
    followRef.current = true;
    setDetached(false);
    setNewCount(0);
    pin();
  }

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col">
      <MessageScroller.Root className="flex min-h-0 flex-1 flex-col">
        <MessageScroller.Viewport
          className="kt-viewport min-h-0 flex-1 overflow-y-auto scroll-thin"
          preserveScrollOnPrepend
          onScroll={onScroll}
        >
          <MessageScroller.Content className="kt-content mx-auto flex w-full max-w-[880px] flex-col gap-1 px-3 py-4 sm:px-5">
            {header}
            {blocks.map((b, idx) => (
              <MessageScroller.Item key={b.id} messageId={b.id} scrollAnchor>
                <TranscriptRow block={b} live={live} isLast={idx === last} />
              </MessageScroller.Item>
            ))}
            {footer}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
      </MessageScroller.Root>

      {detached && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            onClick={jump}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg shadow-md transition hover:bg-accent-strong"
          >
            <ArrowDown size={13} />
            {newCount > 0 ? `${newCount} new — jump to latest` : 'Jump to latest'}
          </button>
        </div>
      )}
    </div>
  );
}

export const Transcript = memo(function Transcript(props: Props) {
  return (
    <MessageScroller.Provider autoScroll={false} defaultScrollPosition="end" scrollEdgeThreshold={AT_BOTTOM_PX}>
      <Inner {...props} />
    </MessageScroller.Provider>
  );
});
