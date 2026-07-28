// The analytics query box, with grammar-aware completion.
//
// A STANDALONE combobox on purpose. The composer's engine is a textarea trigger
// model (`/` and `@` open a list inside prose); an analytics query is a whole
// small language where every caret position means something. What this file DOES
// borrow — deliberately, because they were paid for in regressions — are the
// composer's interaction invariants:
//
//   - The input keeps DOM focus at all times. Nothing here calls focus(), and
//     accepting a suggestion restores only the input's selection after the
//     controlled value has committed. A phone keyboard never closes.
//   - Pointer acceptance is `pointerdown`-preventDefault + `pointerup`, reusing
//     ComposerAutocomplete's row contract verbatim, so a thumb can still scroll
//     the list and an accept can never fire twice.
//   - Arrows navigate, Escape closes, Enter accepts ONLY while the list is open
//     and otherwise runs the query — a reader who has dismissed the popover must
//     never have their Enter swallowed.
//   - The listbox owns options only; loading, empty and error states are its
//     siblings, so a screen reader is told about them.
//
// Value suggestions come from one cached `count by (<label>)` call per label per
// mount. Unbounded labels (`id`, `cwd`, `repo`, `parent`) are never fetched.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Loader2, Search, SearchX, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import {
  analyticsCompletions,
  type AnalyticsCompletion,
  type AnalyticsCompletionResult,
  type AnalyticsCompletionSources,
} from '../lib/analytics-query-complete';
import { cn } from '../lib/utils';
import { createRowPointerHandlers } from './ComposerAutocomplete';

export type AnalyticsAutocompleteStatus = 'ready' | 'loading' | 'error';

export interface AnalyticsAutocompleteKeyState {
  open: boolean;
  count: number;
  activeIndex: number;
  /** An IME owns its whole candidate-navigation sequence, not only Enter. */
  composing?: boolean;
}

export type AnalyticsAutocompleteAction =
  | { type: 'ignore' }
  | { type: 'navigate'; index: number }
  | { type: 'accept'; index: number }
  | { type: 'close' }
  | { type: 'run' };

/** Wrapping movement over a plain list. -1 means "nothing selectable". */
export function nextAnalyticsCompletionIndex(count: number, current: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** The complete keyboard contract, as a pure function so the invariants are
 *  table-tested rather than asserted by eye in a browser. */
export function analyticsAutocompleteKeyAction(
  key: string,
  state: AnalyticsAutocompleteKeyState,
): AnalyticsAutocompleteAction {
  if (state.composing) return { type: 'ignore' };
  const usable = state.open && state.count > 0;
  if (key === 'Escape') return state.open ? { type: 'close' } : { type: 'ignore' };
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!usable) return { type: 'ignore' };
    return {
      type: 'navigate',
      index: nextAnalyticsCompletionIndex(state.count, state.activeIndex, key === 'ArrowDown' ? 1 : -1),
    };
  }
  if (key === 'Tab') {
    if (!usable || state.activeIndex < 0) return { type: 'ignore' };
    return { type: 'accept', index: state.activeIndex };
  }
  if (key === 'Enter') {
    // Enter is the run key first and the accept key only while a list is open
    // with something selected. Anything else would eat the primary action.
    if (!usable || state.activeIndex < 0) return { type: 'run' };
    return { type: 'accept', index: state.activeIndex };
  }
  return { type: 'ignore' };
}

/** Replace exactly the completion's range and put the caret after it. */
export function applyAnalyticsCompletion(
  value: string,
  range: { start: number; end: number },
  replacement: string,
): { value: string; selection: { start: number; end: number } } {
  const start = Math.max(0, Math.min(value.length, range.start));
  const end = Math.max(start, Math.min(value.length, range.end));
  const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  const caret = start + replacement.length;
  return { value: next, selection: { start: caret, end: caret } };
}

export interface AnalyticsCompletionGroup {
  label: string;
  rows: Array<{ candidate: AnalyticsCompletion; index: number }>;
}

/** Section adjacent rows only. Ranking may interleave sources, and renumbering
 *  the DOM while the active index stays in ranked order makes ArrowDown appear
 *  to jump backwards. */
export function groupAnalyticsCompletions(candidates: readonly AnalyticsCompletion[]): AnalyticsCompletionGroup[] {
  const groups: AnalyticsCompletionGroup[] = [];
  for (const [index, candidate] of candidates.entries()) {
    let group = groups.at(-1);
    if (!group || group.label !== candidate.group) groups.push((group = { label: candidate.group, rows: [] }));
    group.rows.push({ candidate, index });
  }
  return groups;
}

const CONTEXT_LABEL: Record<AnalyticsCompletionResult['context'], string> = {
  aggregation: 'Aggregation',
  clause: 'Next clause',
  'grouping-label': 'Group by label',
  'matcher-label': 'Filter label',
  'matcher-value': 'Filter value',
};

/** Presentation only, so every state can be rendered and asserted directly. */
export function AnalyticsCompletionList({
  open,
  status,
  candidates,
  activeIndex,
  listboxId,
  contextLabel,
  notice,
  error,
  onAccept,
}: {
  open: boolean;
  status: AnalyticsAutocompleteStatus;
  candidates: readonly AnalyticsCompletion[];
  activeIndex: number;
  listboxId: string;
  contextLabel: string;
  notice?: string;
  error?: string;
  onAccept(index: number): void;
}) {
  if (!open) return null;
  const copy =
    status === 'loading'
      ? 'Loading label values'
      : status === 'error'
        ? 'Label values unavailable'
        : candidates.length === 0
          ? 'No matching analytics suggestions'
          : `${candidates.length} analytics ${candidates.length === 1 ? 'suggestion' : 'suggestions'}`;
  return (
    <div
      className="absolute inset-x-0 top-[calc(100%+var(--gap-xs))] z-40 overflow-hidden rounded-panel border-panel border-border-strong bg-surface shadow-popover"
      data-analytics-autocomplete={contextLabel}
    >
      <div className="flex min-h-[34px] items-center gap-sm border-b border-border-soft bg-surface-2 px-control-x py-1">
        <span className="min-w-0 flex-1 truncate text-meta font-semibold uppercase tracking-label text-fg-soft">
          {contextLabel}
        </span>
      </div>
      <div className="relative max-h-[min(240px,max(88px,calc(var(--app-h,100dvh)*0.3)))] overflow-y-auto overscroll-contain scroll-thin [touch-action:pan-y]">
        {status === 'loading' ? (
          <div
            className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
            role="status"
          >
            <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading values…
          </div>
        ) : status === 'error' ? (
          <div className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-err" role="alert">
            <ShieldAlert size={15} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0">{error ?? 'Label values unavailable'}</span>
          </div>
        ) : candidates.length === 0 ? (
          <div
            className="flex min-h-[44px] items-center gap-sm px-control-x py-row-y text-meta text-muted"
            role="status"
          >
            <SearchX size={15} className="shrink-0" aria-hidden="true" />
            {notice ?? 'No matching analytics suggestions'}
          </div>
        ) : (
          <div id={listboxId} role="listbox" aria-label="Analytics query suggestions">
            {groupAnalyticsCompletions(candidates).map((group, groupIndex) => (
              <div
                key={`${group.label}-${groupIndex}`}
                role="group"
                aria-labelledby={`${listboxId}-group-${groupIndex}`}
              >
                <div
                  id={`${listboxId}-group-${groupIndex}`}
                  role="presentation"
                  className="sticky top-0 z-10 border-y border-border-soft bg-surface-2 px-control-x py-1 text-2xs font-semibold uppercase tracking-label text-faint first:border-t-0"
                >
                  {group.label}
                </div>
                {group.rows.map(({ candidate, index }) => (
                  <CompletionRow
                    key={candidate.id}
                    candidate={candidate}
                    index={index}
                    active={index === activeIndex}
                    optionId={`${listboxId}-option-${index}`}
                    onAccept={onAccept}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {notice && candidates.length > 0 && (
        <div
          className="border-t border-border-soft bg-warn-bg px-control-x py-1 text-2xs leading-base text-warn"
          role="status"
        >
          {notice}
        </div>
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {copy}
      </span>
    </div>
  );
}

function CompletionRow({
  candidate,
  index,
  active,
  optionId,
  onAccept,
}: {
  candidate: AnalyticsCompletion;
  index: number;
  active: boolean;
  optionId: string;
  onAccept(index: number): void;
}) {
  // Pointer contract borrowed verbatim from the composer: down holds focus, up
  // accepts only if the finger stayed put, cancel accepts nothing.
  const pointer = useMemo(() => createRowPointerHandlers(index, onAccept), [index, onAccept]);
  return (
    <div
      id={optionId}
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      data-index={index}
      data-kind={candidate.kind}
      className={cn(
        'group flex min-h-[44px] w-full cursor-pointer select-none items-center gap-sm border-l-[3px] border-l-transparent px-control-x py-row-y text-left text-fg outline-none hover:bg-surface-2',
        active && 'border-l-accent bg-accent-soft shadow-active',
      )}
      onPointerDown={pointer.onPointerDown}
      onPointerUp={pointer.onPointerUp}
      onPointerCancel={pointer.onPointerCancel}
    >
      <span className="min-w-0 flex-1 leading-tight">
        <span className="mono block truncate font-medium text-current">{candidate.label}</span>
        {candidate.detail && <span className="block truncate text-meta text-muted">{candidate.detail}</span>}
      </span>
      <span className="mono shrink-0 rounded-badge border border-border-soft bg-surface px-badge-x py-px text-2xs text-faint">
        {candidate.kind}
      </span>
    </div>
  );
}

/** One cached `count by (<label>)` per label. Low-cardinality labels only; the
 * caller's completion library decides which those are. */
async function fetchLabelValues(label: string): Promise<readonly string[]> {
  const response = await api.analytics(`count by (${label})`);
  if (response.kind !== 'aggregate') return [];
  const values = response.results
    .map(result => result.labels[label])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set(values)].sort();
}

export type ValueCacheEntry =
  | { status: 'loading' }
  | { status: 'ready'; values: readonly string[] }
  | { status: 'error'; error: string };

export interface LabelValueCache {
  entry(label: string): ValueCacheEntry | undefined;
  /** Fetch a label's values at most once. Returns the in-flight promise so a
   *  test can await the transition; callers ignore it. */
  request(label: string): Promise<void>;
}

/** The value cache lives OUTSIDE React state on purpose.
 *
 * Keeping the in-flight set in a state-derived effect is a trap that already
 * bit this file: the effect writes `loading` into state, the resulting render
 * re-runs the effect's cleanup, the re-run exits early because the entry now
 * exists, and the original promise's result is discarded — a label that loads
 * forever. The map here is the single source of truth for "already asked", and
 * React state only mirrors it so renders happen. */
export function createLabelValueCache(
  load: (label: string) => Promise<readonly string[]>,
  notify: (snapshot: ReadonlyMap<string, ValueCacheEntry>) => void,
): LabelValueCache {
  const entries = new Map<string, ValueCacheEntry>();
  const publish = (label: string, entry: ValueCacheEntry) => {
    entries.set(label, entry);
    notify(new Map(entries));
  };
  return {
    entry: label => entries.get(label),
    async request(label) {
      if (entries.has(label)) return;
      publish(label, { status: 'loading' });
      try {
        publish(label, { status: 'ready', values: await load(label) });
      } catch (reason) {
        publish(label, { status: 'error', error: reason instanceof Error ? reason.message : String(reason) });
      }
    },
  };
}

export function AnalyticsQueryAutocomplete({
  value,
  onValueChange,
  onRun,
  inputId,
  placeholder = 'sum by (model)',
  disabled,
  sources,
  loadValues = fetchLabelValues,
}: {
  value: string;
  onValueChange(value: string): void;
  onRun(): void;
  inputId?: string;
  placeholder?: string;
  disabled?: boolean;
  sources?: Pick<AnalyticsCompletionSources, 'treeIds'>;
  loadValues?(label: string): Promise<readonly string[]>;
}) {
  const generatedId = useId();
  const listboxId = `analytics-completions-${generatedId.replace(/:/g, '')}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [cache, setCache] = useState<ReadonlyMap<string, ValueCacheEntry>>(new Map());
  const pending = useRef<{ expectedValue: string; selection: { start: number; end: number } } | null>(null);
  const values = useMemo(() => createLabelValueCache(loadValues, setCache), [loadValues]);

  const valuesFor = useCallback(
    (label: string) => {
      const entry = cache.get(label);
      return entry?.status === 'ready' ? entry.values : undefined;
    },
    [cache],
  );

  const result = useMemo(
    () => analyticsCompletions(value, caret, { valuesFor, treeIds: sources?.treeIds }),
    [caret, sources?.treeIds, value, valuesFor],
  );

  const pendingLabel = result.pendingValueLabel;
  const pendingEntry = pendingLabel ? cache.get(pendingLabel) : undefined;
  const status: AnalyticsAutocompleteStatus =
    pendingEntry?.status === 'error' ? 'error' : pendingLabel ? 'loading' : 'ready';

  // Deliberately NOT dependent on `cache`: the request writes into the cache,
  // and depending on it here would cancel the very fetch this effect started.
  useEffect(() => {
    if (pendingLabel) void values.request(pendingLabel);
  }, [pendingLabel, values]);

  // Dismissal is pinned to the caret it was made at, so typing on reopens the
  // list without the reader having to click away and back.
  const open = focused && !disabled && dismissedAt !== caret;
  const candidates = result.candidates;
  const boundedActive = candidates.length ? Math.min(Math.max(activeIndex, 0), candidates.length - 1) : -1;

  // Restore the caret only after React has committed the exact value we
  // proposed. NEVER focus: the input already has focus and must keep it.
  useLayoutEffect(() => {
    const next = pending.current;
    const input = inputRef.current;
    if (!next) return;
    if (next.expectedValue !== value) {
      if (input && input.value === value) pending.current = null;
      return;
    }
    if (!input || input.value !== value) return;
    pending.current = null;
    input.setSelectionRange(next.selection.start, next.selection.end);
    setCaret(next.selection.end);
  }, [value]);

  const accept = useCallback(
    (index: number) => {
      const candidate = candidates[index];
      if (!candidate) return;
      const next = applyAnalyticsCompletion(value, result.replaceRange, candidate.replacement);
      pending.current = { expectedValue: next.value, selection: next.selection };
      setActiveIndex(0);
      setDismissedAt(null);
      onValueChange(next.value);
    },
    [candidates, onValueChange, result.replaceRange, value],
  );

  function syncCaret(target: HTMLInputElement) {
    setCaret(target.selectionStart ?? target.value.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const action = analyticsAutocompleteKeyAction(event.key, {
      open,
      count: candidates.length,
      activeIndex: boundedActive,
      composing: event.nativeEvent.isComposing,
    });
    if (action.type === 'ignore') return;
    if (action.type === 'run') {
      event.preventDefault();
      setDismissedAt(caret);
      onRun();
      return;
    }
    event.preventDefault();
    if (action.type === 'close') setDismissedAt(caret);
    else if (action.type === 'navigate') setActiveIndex(action.index);
    else accept(action.index);
  }

  return (
    <span className="relative min-w-0 flex-1">
      <Search
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-[22px] -translate-y-1/2 text-faint"
      />
      <input
        id={inputId}
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open && candidates.length ? listboxId : undefined}
        aria-activedescendant={open && boundedActive >= 0 ? `${listboxId}-option-${boundedActive}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="kt-input mono min-h-[44px] w-full pl-9 pr-3"
        value={value}
        placeholder={placeholder}
        onChange={event => {
          setActiveIndex(0);
          setDismissedAt(null);
          onValueChange(event.currentTarget.value);
          syncCaret(event.currentTarget);
        }}
        onSelect={event => syncCaret(event.currentTarget)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
      />
      <AnalyticsCompletionList
        open={open}
        status={status}
        candidates={candidates}
        activeIndex={boundedActive}
        listboxId={listboxId}
        contextLabel={CONTEXT_LABEL[result.context]}
        notice={result.notice}
        error={pendingEntry?.status === 'error' ? pendingEntry.error : undefined}
        onAccept={accept}
      />
    </span>
  );
}
