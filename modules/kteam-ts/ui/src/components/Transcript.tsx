// The transcript scroll region, built on @shadcn/react's headless
// MessageScroller. This is the fix for the "scrolls almost to the bottom and
// stops short" bug (see summary.md): the old code fired virtuoso's
// scrollToIndex({index:'LAST'}) once, BEFORE markdown/code/image blocks had
// measured their true heights, so it landed short and never corrected.
//
// MessageScroller instead owns anchored scrolling:
//   - defaultScrollPosition="end"  → mounts pinned to the true tail
//   - autoScroll + scrollEdgeThreshold → new content pins to the bottom only
//     while the reader is at/near the bottom; readers scrolled up are never
//     yanked
//   - preserveScrollOnPrepend      → loading older pages at the top doesn't
//     jump the viewport
//   - a `pinSignal` bump re-settles the tail after the initial page's dynamic
//     heights finish laying out.
//
// It does NOT virtualize; we keep tail-first pagination underneath (see
// SessionChatPage.loadOlder) so only the loaded window is in the DOM.

import { memo, useEffect, type ReactNode } from 'react';
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
  /** bumped by the page to request a settle-to-bottom (e.g. after initial load) */
  pinSignal: number;
  header?: ReactNode;
  footer?: ReactNode;
}

function ScrollController({ pinSignal }: { pinSignal: number }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (pinSignal <= 0) return;
    const raf = requestAnimationFrame(() => scrollToEnd({ behavior: 'auto' }));
    // Second pass catches late layout (syntax highlight / image decode).
    const t = setTimeout(() => scrollToEnd({ behavior: 'auto' }), 160);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [pinSignal, scrollToEnd]);
  return null;
}

export const Transcript = memo(function Transcript({
  blocks,
  live,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  pinSignal,
  header,
  footer,
}: Props) {
  const last = blocks.length - 1;
  return (
    <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={140}>
      <ScrollController pinSignal={pinSignal} />
      <MessageScroller.Root className="relative flex h-full min-h-0 flex-col">
        <MessageScroller.Viewport
          className="min-h-0 flex-1 overflow-y-auto scroll-thin"
          preserveScrollOnPrepend
          onScroll={e => {
            const el = e.currentTarget;
            if (el.scrollTop < 280 && hasOlder && !loadingOlder) onLoadOlder();
          }}
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

        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <MessageScroller.Button
            direction="end"
            behavior="smooth"
            render={(props, state) =>
              state.active ? (
                <button
                  {...props}
                  className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-accent-border bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg shadow-md transition hover:bg-accent-strong"
                >
                  <ArrowDown size={13} /> Jump to latest
                </button>
              ) : (
                <span />
              )
            }
          />
        </div>
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
});
