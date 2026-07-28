// WHAT SPACE ASSISTANT PROSE IS ALLOWED TO GIVE AWAY.
//
// The rule this file guards is not cosmetic: on a 390px phone the assistant
// message reserved 68px on the right for a hover timestamp and 12px on the left
// for a 1px hover rail — 80px, 20.5% of the screen, for two affordances that
// hover can never reveal on touch. Measured result: 268px of prose on a 390px
// screen. So the contract is "space may only be reserved for an affordance that
// can appear at that width", and every reserve below `sm` has to be zero.
//
// Asserted on the class strings rather than on rendered geometry because
// `TranscriptRow` renders Markdown and this package has no DOM implementation;
// the pixel gates live in the browser matrix. What is checkable here — and what
// actually regressed before — is whether a reserve is unconditional or
// breakpoint-scoped, which is exactly what a `sm:` prefix says.

import { describe, expect, test } from 'bun:test';
import {
  ASSISTANT_LAYOUT,
  createBlockTapPointerHandlers,
  isPinnable,
  isPlainBlockTap,
  pinPreviewOf,
  SYSTEM_DIVIDER_LAYOUT,
  transcriptImagesEqual,
  type BlockTapPointerEventLike,
} from './TranscriptRow';
import type { TranscriptBlock } from '../lib/transcript';
import { TOUCH_SELECTION_DWELL_MS } from '../hooks/useLiveTick';

/** Utilities that shrink the content box horizontally. A bare one of these
 *  (no variant prefix) is a reserve every viewport pays for. */
const HORIZONTAL_RESERVE = /^-?(p|m)(l|r|x|s|e)?-/;

const classes = (s: string) => s.split(/\s+/).filter(Boolean);
const unprefixed = (s: string) => classes(s).filter(c => !c.includes(':'));

describe('the assistant prose wrap', () => {
  test('reserves nothing horizontally at any width', () => {
    const reserves = unprefixed(ASSISTANT_LAYOUT.wrap).filter(c => HORIZONTAL_RESERVE.test(c));
    expect(reserves).toEqual([]);
  });

  test('carries no hover rail to indent for', () => {
    // The rail was a `w-px` absolutely-positioned rule; `pl-3` existed only to
    // hold it. Neither may come back without paying for phone width again.
    const all = `${ASSISTANT_LAYOUT.wrap} ${ASSISTANT_LAYOUT.gutter}`;
    expect(all).not.toContain('w-px');
    expect(unprefixed(all)).not.toContain('pl-3');
  });

  test('keeps the group + positioning context the stamp needs', () => {
    // The stamp is `absolute right-0`; without these it would escape to the
    // scroller and stop tracking its own message.
    expect(classes(ASSISTANT_LAYOUT.wrap)).toContain('group');
    expect(classes(ASSISTANT_LAYOUT.wrap)).toContain('relative');
    // Long unbroken tokens must be allowed to shrink the flex/grid child
    // instead of widening the transcript.
    expect(classes(ASSISTANT_LAYOUT.wrap)).toContain('min-w-0');
  });
});

describe('the timestamp gutter', () => {
  test('is reserved only where hover can reveal the stamp', () => {
    for (const c of classes(ASSISTANT_LAYOUT.gutter)) expect(c.startsWith('sm:')).toBe(true);
    expect(unprefixed(ASSISTANT_LAYOUT.gutter)).toEqual([]);
  });

  test('retains the established desktop measure', () => {
    expect(ASSISTANT_LAYOUT.gutter).toContain('sm:pr-[54px]');
  });
});

describe('the hover timestamp', () => {
  test('is not displayed below sm, where hover cannot fire', () => {
    expect(classes(ASSISTANT_LAYOUT.stamp)).toContain('hidden');
    expect(classes(ASSISTANT_LAYOUT.stamp)).toContain('sm:block');
  });

  test('fits inside the gutter it is positioned in', () => {
    // 50px stamp inside 54px of padding: the 4px remainder is the gap between
    // prose and clock. A stamp wider than its gutter would overlap the text it
    // is supposed to sit beside.
    const width = /(?:^|\s)w-\[(\d+)px\]/.exec(ASSISTANT_LAYOUT.stamp);
    const gutter = /sm:pr-\[(\d+)px\]/.exec(ASSISTANT_LAYOUT.gutter);
    expect(width).not.toBeNull();
    expect(gutter).not.toBeNull();
    expect(Number(width![1])).toBeLessThanOrEqual(Number(gutter![1]));
  });

  test('never intercepts taps or drags over the prose', () => {
    expect(classes(ASSISTANT_LAYOUT.stamp)).toContain('pointer-events-none');
  });

  test('stays a hover reveal rather than permanent chrome', () => {
    expect(classes(ASSISTANT_LAYOUT.stamp)).toContain('opacity-0');
    expect(classes(ASSISTANT_LAYOUT.stamp)).toContain('group-hover:opacity-100');
  });
});

describe('context boundary chrome', () => {
  test('draws a full-width rule around a bounded disclosure', () => {
    expect(classes(SYSTEM_DIVIDER_LAYOUT.track)).toContain('min-w-0');
    expect(classes(SYSTEM_DIVIDER_LAYOUT.track)).toContain('items-center');
    expect(classes(SYSTEM_DIVIDER_LAYOUT.rule)).toEqual(
      expect.arrayContaining(['h-px', 'min-w-3', 'flex-1', 'bg-border-soft']),
    );
    expect(classes(SYSTEM_DIVIDER_LAYOUT.button)).toEqual(
      expect.arrayContaining(['max-w-[88%]', 'border', 'bg-surface-2']),
    );
  });

  test('keeps the divider labelled and the raw summary keyboard-expandable', async () => {
    const source = await Bun.file(new URL('./TranscriptRow.tsx', import.meta.url)).text();
    expect(source).toContain('role="separator"');
    expect(source).toContain('aria-orientation="horizontal"');
    expect(source).toContain('aria-expanded={open}');
    expect(source).toContain('data-divider={info.divider}');
  });
});

describe('pin affordance — tap gating', () => {
  // A minimal Element stand-in: `closest` returns truthy iff the target sits
  // inside one of the interactive selectors isPlainBlockTap guards against.
  const el = (insideInteractive: boolean): Element =>
    ({ closest: () => (insideInteractive ? ({} as Element) : null) }) as unknown as Element;
  const tap = { durationMs: 90, distancePx: 2, primary: true, pointerType: 'touch' };

  test('a plain tap on inert block content reveals the bar', () => {
    expect(isPlainBlockTap(el(false), false, tap)).toBe(true);
  });
  test('a tap that lands on a link/button/disclosure is left alone', () => {
    expect(isPlainBlockTap(el(true), false, tap)).toBe(false);
  });
  test('a tap while a selection is active never reveals the bar', () => {
    expect(isPlainBlockTap(el(false), true, tap)).toBe(false);
  });
  test('a long-press never mutates the row even when the native range is still collapsed at release', () => {
    expect(isPlainBlockTap(el(false), false, { ...tap, durationMs: 600 })).toBe(false);
  });
  test('a selection-handle drag or scroll gesture never reveals the bar', () => {
    expect(isPlainBlockTap(el(false), false, { ...tap, distancePx: 24 })).toBe(false);
  });
  test('a secondary pointer never reveals the bar', () => {
    expect(isPlainBlockTap(el(false), false, { ...tap, primary: false })).toBe(false);
  });
  test('a slow stationary mouse click still works on a hybrid touch device', () => {
    expect(isPlainBlockTap(el(false), false, { ...tap, durationMs: 600, pointerType: 'mouse' })).toBe(true);
  });
  test('a null target (no element) counts as a plain tap', () => {
    expect(isPlainBlockTap(null, false, tap)).toBe(true);
  });
});

const pointer = (over: Partial<BlockTapPointerEventLike> = {}): BlockTapPointerEventLike => ({
  pointerId: 7,
  pointerType: 'touch',
  clientX: 100,
  clientY: 200,
  timeStamp: 0,
  isPrimary: true,
  button: 0,
  target: { closest: () => null } as unknown as Element,
  ...over,
});

describe('pin affordance — production pointer handlers', () => {
  const setup = (hasSelection = false) => {
    let barOpen = false;
    const handlers = createBlockTapPointerHandlers({
      hasSelection: () => hasSelection,
      onPlainTap: () => {
        barOpen = !barOpen;
      },
    });
    return { handlers, isBarOpen: () => barOpen };
  };

  test('pointerdown → pointerup quick tap opens Pin', () => {
    const row = setup();
    row.handlers.onPointerDown(pointer());
    row.handlers.onPointerUp(pointer({ timeStamp: 90 }));
    expect(row.isBarOpen()).toBe(true);
  });

  test('pointerdown → long-press release does not open Pin', () => {
    const row = setup();
    row.handlers.onPointerDown(pointer());
    row.handlers.onPointerUp(pointer({ timeStamp: TOUCH_SELECTION_DWELL_MS }));
    expect(row.isBarOpen()).toBe(false);
  });

  test('pointerdown → drag → pointerup does not open Pin', () => {
    const row = setup();
    row.handlers.onPointerDown(pointer());
    row.handlers.onPointerMove(pointer({ clientX: 124, timeStamp: 40 }));
    row.handlers.onPointerUp(pointer({ clientX: 124, timeStamp: 80 }));
    expect(row.isBarOpen()).toBe(false);
  });

  test('pointercancel clears the pending tap', () => {
    const row = setup();
    row.handlers.onPointerDown(pointer());
    row.handlers.onPointerCancel();
    row.handlers.onPointerUp(pointer({ timeStamp: 90 }));
    expect(row.isBarOpen()).toBe(false);
  });

  test('the tested handlers are spread onto every touch-pinnable row', async () => {
    const source = await Bun.file(new URL('./TranscriptRow.tsx', import.meta.url)).text();
    expect(source).toContain('const rowPointerHandlers = touch && pinnable ? blockTapHandlers : {};');
    expect(source).toContain('{...rowPointerHandlers}');
  });
});

describe('pinnability + preview', () => {
  test('every block is pinnable except a turn boundary', () => {
    expect(isPinnable({ kind: 'turn' } as TranscriptBlock)).toBe(false);
    expect(isPinnable({ kind: 'assistant' } as TranscriptBlock)).toBe(true);
    expect(isPinnable({ kind: 'user' } as TranscriptBlock)).toBe(true);
  });
  test('preview reads the visible text of each kind', () => {
    expect(pinPreviewOf({ kind: 'assistant', text: 'hello there' } as TranscriptBlock)).toBe('hello there');
    expect(
      pinPreviewOf({ kind: 'tools', calls: [{ use: { name: 'Bash' } }, { use: {}, key: 'k2' }] } as TranscriptBlock),
    ).toBe('Bash, k2');
    expect(pinPreviewOf({ kind: 'system', info: { label: 'turn prompt' } } as TranscriptBlock)).toBe('turn prompt');
    expect(pinPreviewOf({ kind: 'notice', label: 'reconnected' } as TranscriptBlock)).toBe('reconnected');
  });
});

describe('transcript image memo equality', () => {
  test('compares the complete inline source rather than a shared prefix and length', () => {
    const prefix = 'data:image/png;base64,' + 'a'.repeat(64);
    const left = [{ kind: 'inline' as const, src: `${prefix}x`, alt: 'tool image' }];
    const right = [{ kind: 'inline' as const, src: `${prefix}y`, alt: 'tool image' }];

    expect(left[0]!.src.length).toBe(right[0]!.src.length);
    expect(left[0]!.src.slice(0, 48)).toBe(right[0]!.src.slice(0, 48));
    expect(transcriptImagesEqual(left, right)).toBe(false);
    expect(transcriptImagesEqual(left, left)).toBe(true);
  });
});
