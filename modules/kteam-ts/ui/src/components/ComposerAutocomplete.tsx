// Presentation for the composer's shared / and @ trigger engine.
//
// The visual direction is a compact "signal rail": an industrial, information-
// dense strip attached to the composer rather than a floating command-palette
// dialog. It uses the app's theme tokens, occupies no layout space, and opens
// upward over the transcript so the software keyboard can never cover it.
//
// This component NEVER takes focus. Rows are never focusable at all — they are
// `aria-activedescendant` options, so the textarea keeps DOM focus and the
// software keyboard never closes. There is no mount/update focus effect and no
// timer-driven render.
//
// POINTER ACCEPTANCE IS A TWO-PART GESTURE, on purpose. `pointerdown` only
// calls preventDefault(), which is what keeps the textarea's focus AND its
// selection; the accept itself waits for `pointerup` within a small movement
// budget. Both halves matter:
//   - Accepting on pointerdown (the obvious version) makes the list impossible
//     to scroll with a thumb: it is `overflow-y-auto`, so the first touch of a
//     flick lands on a row and selects it. Mobile is this app's priority, and
//     an unscrollable list is worse than the bug that change would fix.
//   - Relying on a later `click` (the other obvious version) is what breaks on
//     phones, because some engines suppress the compatibility click once
//     pointerdown's default is prevented. There is deliberately NO onClick, so
//     an accept can never fire twice.

import { useLayoutEffect, useMemo, useRef } from 'react';
import { BookOpen, File, Folder, LoaderCircle, SearchX, ShieldAlert } from 'lucide-react';
import type {
  ComposerAutocompleteCandidate,
  ComposerAutocompleteController,
  ComposerAutocompleteKind,
} from './composer-autocomplete-engine';
import { cn } from '../lib/utils';

/** Five rows at rest, roughly three with a 390px viewport's keyboard open. The
 * app shell already writes --app-h as the VISUAL viewport, so subtracting
 * --kb-h here would count the keyboard twice on iOS. */
export const AUTOCOMPLETE_LIST_MAX_HEIGHT = 'min(220px, max(88px, calc(var(--app-h, 100dvh) * 0.27)))';

export function preventAutocompletePointerFocus(event: Pick<PointerEvent, 'preventDefault'>): void {
  event.preventDefault();
}

/** How far a pointer may travel between down and up and still count as a tap
 *  rather than the start of a scroll. Roughly a fingertip's jitter. */
export const AUTOCOMPLETE_TAP_SLOP_PX = 10;

interface RowPointer {
  pointerId: number;
  clientX: number;
  clientY: number;
}

/** The row's pointer contract, as a plain closure so it can be unit-tested with
 *  object literals — this package has no DOM implementation in its test stack,
 *  and "does tapping a row steal focus" is exactly the thing that must not be
 *  asserted by eye. Down holds focus; up accepts only if the finger stayed put;
 *  cancel (the browser taking the gesture over for a scroll) accepts nothing. */
export function createRowPointerHandlers(index: number, onAccept: (index: number) => void) {
  let origin: RowPointer | null = null;
  return {
    onPointerDown(event: RowPointer & { preventDefault(): void }) {
      // The single most important line in this file. Without it the browser
      // moves focus on pointerdown, which closes the phone keyboard and
      // destroys any selection the reader was holding.
      event.preventDefault();
      origin = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    },
    onPointerUp(event: RowPointer) {
      const from = origin;
      origin = null;
      if (!from || from.pointerId !== event.pointerId) return;
      if (Math.abs(event.clientX - from.clientX) > AUTOCOMPLETE_TAP_SLOP_PX) return;
      if (Math.abs(event.clientY - from.clientY) > AUTOCOMPLETE_TAP_SLOP_PX) return;
      onAccept(index);
    },
    onPointerCancel() {
      origin = null;
    },
  };
}

function iconFor(kind: ComposerAutocompleteKind) {
  if (kind === 'skill') return BookOpen;
  if (kind === 'directory') return Folder;
  return File;
}

function resultCopy(controller: ComposerAutocompleteController): string {
  if (!controller.open || !controller.provider) return '';
  if (controller.status === 'loading') return `Loading ${controller.provider.label.toLowerCase()}`;
  if (controller.status === 'error') return `${controller.provider.label} unavailable`;
  const count = controller.candidates.length;
  return count === 0
    ? `No matching ${controller.provider.label.toLowerCase()}`
    : `${count} ${controller.provider.label.toLowerCase()} ${count === 1 ? 'result' : 'results'}`;
}

export function autocompleteEmptyCopy(providerLabel: string): string {
  return `No matching ${providerLabel.toLowerCase()}`;
}

function CandidateRow({
  candidate,
  index,
  active,
  optionId,
  onAccept,
}: {
  candidate: ComposerAutocompleteCandidate;
  index: number;
  active: boolean;
  optionId: string;
  onAccept(index: number): void;
}) {
  const Icon = iconFor(candidate.kind);
  const refused = candidate.disabled === true;
  // A refused row is still shown — the path exists and the list has to be honest
  // about that — but it accepts nothing, so it gets no pointer contract at all.
  const pointer = useMemo(
    () => (refused ? null : createRowPointerHandlers(index, onAccept)),
    [index, onAccept, refused],
  );
  return (
    <div
      id={optionId}
      role="option"
      aria-selected={active}
      aria-disabled={refused || undefined}
      data-active={active || undefined}
      data-index={index}
      data-kind={candidate.kind}
      className={cn(
        // 44px is a floor, not padding arithmetic: every theme and every row
        // remains a thumb-sized target at 390px with the keyboard open.
        'group relative flex min-h-[44px] w-full select-none items-center gap-sm border-l-[3px] px-control-x py-row-y text-left',
        'border-l-transparent text-fg outline-none',
        !refused && 'cursor-pointer hover:bg-surface-2',
        active && !refused && 'border-l-accent bg-accent-soft shadow-active',
        refused && 'cursor-not-allowed text-muted opacity-60',
      )}
      title={candidate.disabledReason ?? candidate.detail}
      // No onClick anywhere: pointerup IS the accept, so it can only fire once.
      onPointerDown={pointer?.onPointerDown}
      onPointerUp={pointer?.onPointerUp}
      onPointerCancel={pointer?.onPointerCancel}
    >
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-border-soft bg-surface-2 text-muted',
          active && !refused && 'border-accent-border text-accent',
          refused && 'border-warn-border bg-warn-bg text-warn',
        )}
        aria-hidden="true"
      >
        {refused ? <ShieldAlert size={14} /> : <Icon size={14} />}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium text-current">{candidate.label}</span>
        {(candidate.detail || candidate.disabledReason) && (
          <span className="block truncate text-meta text-muted">{candidate.disabledReason ?? candidate.detail}</span>
        )}
      </span>
      <span
        className={cn(
          'mono shrink-0 rounded-badge border border-border-soft bg-surface px-badge-x py-px text-2xs text-faint',
          active && !refused && 'border-accent-border text-accent',
        )}
        aria-hidden="true"
      >
        {candidate.kind === 'directory' ? 'open' : candidate.kind === 'skill' ? 'use' : 'add'}
      </span>
    </div>
  );
}

export function ComposerAutocompletePopover({
  controller,
  className,
}: {
  controller: ComposerAutocompleteController;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Three rows fit above a keyboard-open phone composer, so arrow navigation
  // leaves the window almost immediately. Keep the active row visible without
  // moving DOM focus and without a timer.
  //
  // Deliberately NOT `scrollIntoView({ block: 'nearest' })`: that walks up and
  // scrolls EVERY scrollable ancestor, so arrowing through suggestions would
  // also drag the transcript behind the popover. Writing `scrollTop` touches
  // this one element and cannot escape it. `useLayoutEffect` because a frame of
  // lag reads as a smear when ArrowDown is held.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || controller.activeIndex < 0) return;
    const row = list.querySelector<HTMLElement>(`[data-index="${controller.activeIndex}"]`);
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [controller.activeIndex, controller.candidates]);

  if (!controller.open || !controller.provider || !controller.match) return null;
  const copy = resultCopy(controller);
  const trigger = controller.match.trigger;

  return (
    <div
      className={cn(
        // Absolute + bottom-full means the composer never grows and the list
        // cannot fall under a software keyboard. z-40 clears transcript cards
        // while remaining below full-screen sheets/dialogs.
        'absolute inset-x-0 bottom-[calc(100%+var(--gap-xs))] z-40 overflow-hidden rounded-panel border-panel border-border-strong bg-surface shadow-popover',
        className,
      )}
      data-composer-autocomplete={trigger === '/' ? 'skills' : 'files'}
    >
      <div className="flex min-h-[34px] items-center gap-sm border-b border-border-soft bg-surface-2 px-control-x py-1">
        <span className="mono inline-flex h-6 min-w-6 items-center justify-center rounded-control border border-accent-border bg-accent-soft px-1.5 font-semibold text-accent">
          {trigger}
        </span>
        <span className="min-w-0 flex-1 truncate text-meta font-semibold uppercase tracking-label text-fg-soft">
          {controller.provider.label}
        </span>
        {controller.contextLabel && (
          <span className="mono max-w-[58%] truncate text-2xs text-faint" title={controller.contextLabel}>
            {controller.contextLabel}
          </span>
        )}
      </div>

      {/* `relative` makes THIS the offsetParent for the rows, so the scroll
          arithmetic above measures from the top of the scroller rather than
          from the popover root (which is `absolute`, and would silently add the
          header's height to every row offset). `touch-action: pan-y` keeps the
          browser owning vertical panning even though rows preventDefault their
          pointerdown — without it a thumb flick over a row does nothing. */}
      <div
        ref={listRef}
        className="relative overflow-y-auto overscroll-contain scroll-thin [touch-action:pan-y]"
        style={{ maxHeight: AUTOCOMPLETE_LIST_MAX_HEIGHT }}
      >
        {/* A listbox may only OWN `option`/`group` children, so the loading,
            error and zero states are siblings of it rather than rows inside it.
            As children they were dropped outright by several screen readers —
            which silenced the one state that exists to be honest about having
            nothing to offer. The listbox element itself only exists when there
            is at least one real option to put in it. */}
        {controller.status === 'loading' ? (
          <div
            className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
            role="status"
          >
            <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading {controller.provider.label.toLowerCase()}…
          </div>
        ) : controller.status === 'error' ? (
          <div className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-err" role="alert">
            <ShieldAlert size={15} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0">{controller.error ?? `${controller.provider.label} unavailable`}</span>
          </div>
        ) : controller.candidates.length === 0 ? (
          // The trigger by itself is never an empty rectangle. This row is the
          // explicit zero state whether the query is empty or over-specific.
          <div
            className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
            role="status"
          >
            <SearchX size={15} className="shrink-0" aria-hidden="true" />
            {autocompleteEmptyCopy(controller.provider.label)}
          </div>
        ) : (
          <div id={controller.listboxId} role="listbox" aria-label={`${controller.provider.label} suggestions`}>
            {controller.candidates.map((candidate, index) => (
              <CandidateRow
                key={candidate.id}
                candidate={candidate}
                index={index}
                active={index === controller.activeIndex}
                optionId={`${controller.listboxId}-option-${index}`}
                onAccept={controller.accept}
              />
            ))}
          </div>
        )}
      </div>

      {controller.notice && (
        <div
          className="border-t border-border-soft bg-warn-bg px-control-x py-1 text-2xs leading-base text-warn"
          role="status"
        >
          {controller.notice}
        </div>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copy}
      </span>
    </div>
  );
}
