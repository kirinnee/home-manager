// The transcript scroll region, built on @shadcn/react's headless
// MessageScroller. Round-2 scroll rules (turn-005):
//   - NO auto-scroll on new content. autoScroll is OFF; the viewport only
//     follows the tail when the reader is already at the very bottom by their
//     own action.
//   - when new messages arrive while the reader is scrolled up, they are
//     counted and surfaced as an "N new — jump to latest" pill instead of
//     yanking the scroll.
//   - defaultScrollPosition="end" + a pinSignal settle still land the initial
//     page at the true bottom (this was the round-1 "stops short" fix).
//   - preserveScrollOnPrepend keeps the viewport steady when older pages load.
//
// Not virtualized; tail-first pagination underneath keeps only the loaded
// window in the DOM (see SessionChatPage.loadOlder).

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageScroller, useMessageScroller } from '@shadcn/react/message-scroller';
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
  const { scrollToEnd } = useMessageScroller();
  const atBottomRef = useRef(true);
  const [detached, setDetached] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const prevLastId = useRef<string | null>(null);
  const last = blocks.length - 1;
  const lastId = blocks.length ? blocks[last]!.id : null;

  // Initial settle: after the first page's dynamic (markdown/code) heights lay
  // out, pin to the true tail. Bumped by the page via pinSignal.
  useEffect(() => {
    if (pinSignal <= 0) return;
    const raf = requestAnimationFrame(() => scrollToEnd({ behavior: 'auto' }));
    const t = setTimeout(() => scrollToEnd({ behavior: 'auto' }), 160);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [pinSignal, scrollToEnd]);

  // New tail content: follow only if the reader is at the bottom; otherwise
  // count it for the pill. Older-page prepends don't change the last id, so
  // they never trigger either path.
  useEffect(() => {
    const prev = prevLastId.current;
    if (lastId && prev !== null && lastId !== prev) {
      if (atBottomRef.current) {
        requestAnimationFrame(() => scrollToEnd({ behavior: 'smooth' }));
      } else {
        const idx = blocks.findIndex(b => b.id === prev);
        const added = idx >= 0 ? blocks.length - 1 - idx : 1;
        setNewCount(c => c + Math.max(1, added));
      }
    }
    prevLastId.current = lastId;
    // Intentionally keyed on lastId only; refs carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = gap < AT_BOTTOM_PX;
    atBottomRef.current = atBottom;
    setDetached(!atBottom);
    if (atBottom && newCount) setNewCount(0);
    if (el.scrollTop < 280 && hasOlder && !loadingOlder) onLoadOlder();
  }

  function jump() {
    scrollToEnd({ behavior: 'smooth' });
    setNewCount(0);
    setDetached(false);
    atBottomRef.current = true;
  }

  return (
    <MessageScroller.Root className="relative flex h-full min-h-0 flex-col">
      <MessageScroller.Viewport
        className="min-h-0 flex-1 overflow-y-auto scroll-thin"
        preserveScrollOnPrepend
        onScroll={onScroll}
      >
        <MessageScroller.Content className="mx-auto flex w-full max-w-[880px] flex-col gap-1 px-3 py-4 sm:px-5">
          {header}
          {blocks.map((b, idx) => (
            <MessageScroller.Item key={b.id} messageId={b.id} scrollAnchor>
              <TranscriptRow block={b} live={live} isLast={idx === last} />
            </MessageScroller.Item>
          ))}
          {footer}
        </MessageScroller.Content>
      </MessageScroller.Viewport>

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
    </MessageScroller.Root>
  );
}

export const Transcript = memo(function Transcript(props: Props) {
  return (
    <MessageScroller.Provider autoScroll={false} defaultScrollPosition="end" scrollEdgeThreshold={AT_BOTTOM_PX}>
      <Inner {...props} />
    </MessageScroller.Provider>
  );
});
