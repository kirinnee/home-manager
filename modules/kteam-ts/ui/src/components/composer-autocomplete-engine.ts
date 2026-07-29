// One composer trigger engine: `/` does something (commands and skills), while
// a LEADING RUN of `@` selects one reference family. Trigger recognition,
// query tracking, fuzzy ranking, keyboard navigation, and token replacement
// live here. Providers deliberately do less: they receive the active query and
// return candidate data.
//
// `!` shell mode is NOT here and is not coming back without a decision. It
// needs a new `tmux.inject()` send path, which is the mechanism behind this
// session's measured triple-execution bug, and a SHELL COMMAND running three
// times is materially worse than a prompt running three times. There is
// deliberately no dormant `!` branch to re-enable: adding one is a design
// decision that has to be made again, with an exactly-once daemon action, not a
// flag someone flips.
//
// FOCUS IS A HARD INVARIANT. Nothing in this module calls focus(), schedules a
// timer, or moves DOM focus into the popover. Accepting a candidate restores
// only the textarea selection after the controlled value commits. That keeps a
// phone keyboard open without reviving the Composer focus regression that
// destroyed a reader's held transcript selection.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { fieldScore } from '../lib/fuzzy';

export type ComposerTrigger = '/' | '@';
export type ComposerReferenceTier = 1 | 2 | 3 | 4 | 5;
export type ComposerAutocompleteKind =
  | 'command'
  | 'skill'
  | 'agent'
  | 'file'
  | 'directory'
  | 'task'
  | 'attention'
  | 'pin';

export interface ComposerReferenceTierLegendItem {
  tier: ComposerReferenceTier;
  trigger: string;
  label: string;
}

/** Frequency order, not alphabetical order. Files and source locations are
 * typed most; people are next; durable fleet records follow. Kept as data so
 * provider routing, UI teaching, and tests cannot drift independently. */
export const COMPOSER_REFERENCE_TIERS: readonly ComposerReferenceTierLegendItem[] = [
  { tier: 1, trigger: '@', label: 'Files' },
  { tier: 2, trigger: '@@', label: 'Agents' },
  { tier: 3, trigger: '@@@', label: 'Tasks' },
  { tier: 4, trigger: '@@@@', label: 'Attention' },
  { tier: 5, trigger: '@@@@@', label: 'Pins' },
];

export interface ComposerSelection {
  start: number;
  end: number;
}

export interface ComposerTriggerMatch {
  trigger: ComposerTrigger;
  /** Exact sigil bytes at the start of this token (`/`, `@`, `@@`, ...).
   * Optional for manually constructed host/test matches; detector output always
   * supplies it and consumers fall back to the legacy single trigger. */
  triggerText?: string;
  /** Present for @ runs. Counts beyond the known five stay detectable so the
   * picker can teach the valid tiers instead of silently breaking the token. */
  referenceTier?: number;
  /** Text after the trigger and before the caret. */
  query: string;
  /** Inclusive trigger offset. */
  start: number;
  /** Exclusive end of the whole trigger token, including text after the caret. */
  end: number;
  caret: number;
}

export interface ComposerAutocompleteCandidate {
  id: string;
  kind: ComposerAutocompleteKind;
  label: string;
  /** Secondary line shown in the row. Also participates in fuzzy matching. */
  detail?: string;
  /** Extra search terms that do not need to be rendered. */
  keywords?: string;
  /** Visual section inside a provider's merged result list. */
  group?: string;
  /** Coarse source priority before fuzzy score. The unified reference picker
   * keeps its small named sets ahead of the thousands-deep filesystem. */
  rankPriority?: number;
  /** Compact state/action word shown at the row's trailing edge. */
  badge?: string;
  /** Complete replacement for the active token, including its sigil. */
  replacement: string;
  /** Final selections close with a separating space; directories stay open. */
  append?: 'space' | 'none';
  disabled?: boolean;
  disabledReason?: string;
}

export interface ComposerProviderContext {
  query: string;
  match: ComposerTriggerMatch;
  signal: AbortSignal;
}

export interface ComposerProviderResult {
  candidates: readonly ComposerAutocompleteCandidate[];
  /** Files search only the final path segment; all other providers omit this. */
  filterQuery?: string;
  /** Compact context for the popover header, such as a relative directory. */
  contextLabel?: string;
  /** Honest bounded-list notice supplied by the backing endpoint. */
  notice?: string;
}

export interface ComposerAutocompleteProvider {
  id: string;
  trigger: ComposerTrigger;
  label: string;
  /** Always-visible teaching rail for repetition-selected reference families. */
  readonly legend?: readonly ComposerReferenceTierLegendItem[];
  /** Identity of an already-live backing snapshot. Store-backed providers use
   * this to refresh an open list when the store changes, without recreating
   * network-backed providers and throwing away their caches. */
  readonly snapshotKey?: unknown;
  /** Immediately available subset while an asynchronous source warms. This is
   * used by the merged slash provider so native commands never wait on (or
   * disappear with) skills discovery. The full `candidates` result replaces it
   * when ready. */
  initialCandidates?(context: ComposerProviderContext): ComposerProviderResult | undefined;
  /** Providers can suppress a popover for a syntactically valid token. */
  shouldOpen?(match: ComposerTriggerMatch): boolean;
  /** Drop whatever this provider has cached. The composer calls it on send, so
   *  a file the agent writes during a turn is visible on the next `@`. */
  reset?(): void;
  candidates(context: ComposerProviderContext): Promise<ComposerProviderResult> | ComposerProviderResult;
}

export type ComposerAutocompleteStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ComposerAutocompleteSnapshot {
  open: boolean;
  status: ComposerAutocompleteStatus;
  provider: ComposerAutocompleteProvider | null;
  match: ComposerTriggerMatch | null;
  candidates: readonly ComposerAutocompleteCandidate[];
  activeIndex: number;
  activeId?: string;
  contextLabel?: string;
  notice?: string;
  error?: string;
}

export interface ComposerAutocompleteController extends ComposerAutocompleteSnapshot {
  listboxId: string;
  /** Composer's every-render recovery effect must treat an open popover as a
   * refocus veto. Provider completion can otherwise focus the textarea during
   * the pointer-down phase of a transcript selection, before the document
   * Selection has become non-collapsed. */
  blocksRefocus: boolean;
  syncSelection(selection: ComposerSelection): void;
  handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  accept(index: number): void;
  close(): void;
  textareaAria: {
    'aria-autocomplete'?: 'list';
    'aria-controls'?: string;
    'aria-expanded'?: boolean;
    'aria-activedescendant'?: string;
    'aria-haspopup'?: 'listbox';
  };
}

const TOKEN_SPACE = /\s/u;
/** A bare `@` in a large directory should offer a list, not a file manager. At
 *  44px a row, 20 is already ~880px of content behind a ~220px window; 60 was a
 *  2,600px scroller nobody reaches the bottom of, and refining the query is
 *  faster than flicking past it. */
export const MAX_AUTOCOMPLETE_RESULTS = 20;

function clampSelection(value: string, selection: ComposerSelection): ComposerSelection {
  const start = Math.max(0, Math.min(value.length, Math.trunc(selection.start)));
  const end = Math.max(start, Math.min(value.length, Math.trunc(selection.end)));
  return { start, end };
}

/** An input event reports the caret for its NEW value before the controlled
 * parent has rendered that value back into this hook. Do not clamp to the old
 * value here or `/` typed into an empty draft becomes caret 0 and every query
 * remains one character behind. The next render's detector performs the real
 * value-bounded clamp. */
export function pendingComposerInputSelection(selection: ComposerSelection): ComposerSelection {
  const start = Math.max(0, Math.trunc(selection.start));
  const end = Math.max(start, Math.trunc(selection.end));
  return { start, end };
}

function tokenEnd(value: string, caret: number): number {
  let end = caret;
  while (end < value.length && !TOKEN_SPACE.test(value[end]!)) end++;
  return end;
}

function slashTrigger(value: string, caret: number): ComposerTriggerMatch | null {
  const first = value.search(/\S/u);
  if (first < 0 || value[first] !== '/' || caret < first + 1) return null;
  const query = value.slice(first + 1, caret);
  if (TOKEN_SPACE.test(query)) return null;
  return {
    trigger: '/',
    triggerText: '/',
    query,
    start: first,
    end: tokenEnd(value, caret),
    caret,
  };
}

/** Characters that make the thing before an `@` a WORD rather than a boundary.
 *
 *  The mention sigil has to BEGIN its token. `bob@example.com` is an address and
 *  `a@b` is a word; neither is a file reference, and matching there is not just
 *  a cosmetic false positive — `match.start` is the sigil, so accepting a
 *  candidate would replace `@example.com` and leave `bob` welded to a path.
 *  Dots and slashes are included because they are the interior of the very
 *  things that produce false positives (`a.b@c`, `dir/x@y`).
 *
 *  Anything else — whitespace, or opening punctuation like `(`, `"`, `:` — is a
 *  real boundary, so `see:@src` and `(@src` still open the list. */
const WORD_BEFORE_MENTION = /[\p{L}\p{N}_\-.\\/@]/u;

function atTrigger(value: string, caret: number): ComposerTriggerMatch | null {
  const before = value.slice(0, caret);
  let candidate = before.lastIndexOf('@');
  while (candidate >= 0) {
    // `lastIndexOf` lands on the FINAL sigil in `@@@`; walk to the start of the
    // contiguous run so repetition is the tier rather than a word-boundary
    // failure on the second character.
    let start = candidate;
    while (start > 0 && value[start - 1] === '@') start -= 1;
    let runEnd = start;
    while (runEnd < caret && value[runEnd] === '@') runEnd += 1;

    if (start === 0 || !WORD_BEFORE_MENTION.test(value[start - 1]!)) {
      const query = value.slice(runEnd, caret);
      if (!TOKEN_SPACE.test(query)) {
        const triggerText = value.slice(start, runEnd);
        return {
          trigger: '@',
          triggerText,
          referenceTier: triggerText.length,
          query,
          start,
          end: tokenEnd(value, caret),
          caret,
        };
      }
    }

    candidate = before.lastIndexOf('@', start - 1);
  }
  return null;
}

/** Detect the trigger at a collapsed textarea caret.
 *
 * `/` is limited to the first non-whitespace byte and `@` is valid at a token
 * boundary. `&`, `?`, and `#` are ordinary Markdown/prose: tasks and attention
 * are browsed through `@`, while their canonical inserted forms remain `#F12`
 * and `?A3`. A non-collapsed textarea selection never opens a list. */
export function detectComposerTrigger(value: string, selection: ComposerSelection): ComposerTriggerMatch | null {
  const safe = clampSelection(value, selection);
  if (safe.start !== safe.end) return null;
  const caret = safe.end;
  const mention = atTrigger(value, caret);
  if (mention) return mention;
  return slashTrigger(value, caret);
}

export interface TokenReplacement {
  value: string;
  selection: ComposerSelection;
}

/** Replace exactly the active token and return the caret to its new end.
 * Existing whitespace after a final token is reused rather than doubled. */
export function replaceComposerTrigger(
  value: string,
  match: Pick<ComposerTriggerMatch, 'start' | 'end'>,
  replacement: string,
  append: 'space' | 'none' = 'space',
): TokenReplacement {
  const before = value.slice(0, match.start);
  let after = value.slice(match.end);
  let separator = '';
  if (append === 'space') {
    if (!after || !TOKEN_SPACE.test(after[0]!)) separator = ' ';
    else if (after[0] === ' ') {
      // Reuse one existing ASCII separator and leave any additional whitespace
      // exactly as the reader typed it.
      separator = ' ';
      after = after.slice(1);
    }
  }
  const next = `${before}${replacement}${separator}${after}`;
  const caret = before.length + replacement.length + separator.length;
  return { value: next, selection: { start: caret, end: caret } };
}

function candidateScore(candidate: ComposerAutocompleteCandidate, query: string): number {
  if (!query) return 1;
  const label = fieldScore(candidate.label, query);
  const supporting = Math.max(fieldScore(candidate.detail ?? '', query), fieldScore(candidate.keywords ?? '', query));
  if (!label && !supporting) return 0;
  // Names dominate descriptions, while a supporting hit still admits a skill
  // whose human description contains the term the reader remembers.
  return label * 3 + supporting;
}

/** Engine-owned filtering/ranking. Providers return facts; they never choose
 * what fuzzy matching means. Disabled filesystem rows remain in the result so
 * the UI can honestly explain why a visible path cannot be inserted. */
export function rankComposerCandidates(
  candidates: readonly ComposerAutocompleteCandidate[],
  query: string,
  limit = MAX_AUTOCOMPLETE_RESULTS,
): ComposerAutocompleteCandidate[] {
  if (!query) return candidates.slice(0, limit);
  return candidates
    .map((candidate, index) => ({ candidate, index, score: candidateScore(candidate, query) }))
    .filter(item => item.score > 0)
    .sort(
      (a, b) =>
        (b.candidate.rankPriority ?? 0) - (a.candidate.rankPriority ?? 0) || b.score - a.score || a.index - b.index,
    )
    .slice(0, limit)
    .map(item => item.candidate);
}

/** Find the next selectable row, wrapping and skipping refused filesystem
 * entries. Returns -1 when the result contains information only. */
export function nextComposerCandidateIndex(
  candidates: readonly ComposerAutocompleteCandidate[],
  current: number,
  direction: 1 | -1,
): number {
  if (!candidates.length || candidates.every(candidate => candidate.disabled)) return -1;
  // From "nothing selected", ArrowDown means the FIRST row and ArrowUp means the
  // LAST one. Falling through to the modulo below would answer `length - 2` for
  // ArrowUp, which is the second to last — a quietly wrong answer that only
  // shows up once a caller reaches this with no active row.
  if (current < 0) {
    const from = direction === 1 ? candidates.length - 1 : 0;
    current = from;
  }
  let index = current;
  for (let seen = 0; seen < candidates.length; seen++) {
    index = (index + direction + candidates.length) % candidates.length;
    if (!candidates[index]!.disabled) return index;
  }
  return -1;
}

function firstEnabled(candidates: readonly ComposerAutocompleteCandidate[]): number {
  return candidates.findIndex(candidate => !candidate.disabled);
}

interface LoadState {
  key: string;
  status: ComposerAutocompleteStatus;
  candidates: readonly ComposerAutocompleteCandidate[];
  contextLabel?: string;
  notice?: string;
  error?: string;
}

const IDLE_LOAD: LoadState = { key: '', status: 'idle', candidates: [] };

export function useComposerAutocomplete({
  value,
  onValueChange,
  inputRef,
  providers,
  disabled,
  listboxId,
}: {
  value: string;
  onValueChange(value: string): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  providers: readonly ComposerAutocompleteProvider[];
  disabled?: boolean;
  listboxId?: string;
}): ComposerAutocompleteController {
  const generatedId = useId();
  // Several retained session panes can keep composers mounted simultaneously.
  // A per-hook id prevents one textarea's active-descendant from naming an
  // option in a hidden sibling pane.
  const resolvedListboxId = listboxId ?? `composer-autocomplete-${generatedId.replace(/:/g, '')}`;
  const [selection, setSelection] = useState<ComposerSelection>({ start: value.length, end: value.length });
  const [dismissed, setDismissed] = useState<{
    trigger: ComposerTrigger;
    triggerText: string;
    start: number;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [load, setLoad] = useState<LoadState>(IDLE_LOAD);
  // Pinned to the EXACT string the caret was computed against. A bare selection
  // is not enough: if the parent transforms or ignores the value we handed it,
  // or if the replacement happens to leave the value identical, the pending
  // caret survives and later lands on a document it was never measured for.
  const pendingSelection = useRef<{ expectedValue: string; selection: ComposerSelection } | null>(null);

  const match = useMemo(() => detectComposerTrigger(value, selection), [selection, value]);
  const provider = match ? (providers.find(item => item.trigger === match.trigger) ?? null) : null;
  const matchTriggerText = match?.triggerText ?? match?.trigger;
  const tokenDismissed =
    !!match &&
    dismissed?.trigger === match.trigger &&
    dismissed.triggerText === matchTriggerText &&
    dismissed.start === match.start;
  const open = !!match && !!provider && !disabled && !tokenDismissed && (provider.shouldOpen?.(match) ?? true);
  const requestKey =
    open && match && provider ? `${provider.id}:${match.start}:${matchTriggerText}:${match.query}` : '';

  useEffect(() => {
    if (match || !dismissed) return;
    setDismissed(null);
  }, [dismissed, match]);

  useEffect(() => {
    if (!open || !match || !provider) {
      setLoad(previous => (previous.status === 'idle' ? previous : IDLE_LOAD));
      setActiveIndex(-1);
      return;
    }
    const abort = new AbortController();
    const ready = (result: ComposerProviderResult) => {
      if (abort.signal.aborted) return;
      const candidates = rankComposerCandidates(result.candidates, result.filterQuery ?? match.query);
      setLoad({
        key: requestKey,
        status: 'ready',
        candidates,
        contextLabel: result.contextLabel,
        notice: result.notice,
      });
      setActiveIndex(firstEnabled(candidates));
    };
    const failed = (error: unknown) => {
      if (abort.signal.aborted || (error as { name?: string })?.name === 'AbortError') return;
      setLoad({
        key: requestKey,
        status: 'error',
        candidates: [],
        error: error instanceof Error ? error.message : String(error),
      });
      setActiveIndex(-1);
    };
    const context: ComposerProviderContext = { query: match.query, match, signal: abort.signal };
    try {
      const initial = provider.initialCandidates?.(context);
      if (initial) ready(initial);
      else {
        setLoad({ key: requestKey, status: 'loading', candidates: [] });
        setActiveIndex(-1);
      }
      const result = provider.candidates(context);
      if (result && typeof (result as PromiseLike<ComposerProviderResult>).then === 'function') {
        void Promise.resolve(result).then(ready, failed);
      } else {
        // Store-backed reference snapshots are already in memory. Settle in this
        // effect turn instead of manufacturing a promise/microtask and a
        // visible loading frame for data the browser already has.
        ready(result as ComposerProviderResult);
      }
    } catch (error) {
      failed(error);
    }
    return () => abort.abort();
  }, [match?.query, match?.start, open, provider, provider?.snapshotKey, requestKey]);

  // Candidate insertion updates a controlled value. Restore the caret only
  // after React has committed that exact value; never focus the textarea.
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    const input = inputRef.current;
    if (!pending) return;
    if (pending.expectedValue !== value) {
      // The parent settled on something other than what we proposed. The offsets
      // were measured against a string that no longer exists, so drop them
      // rather than apply them to a different document.
      if (input && input.value === value) pendingSelection.current = null;
      return;
    }
    if (!input || input.value !== value) return;
    pendingSelection.current = null;
    input.setSelectionRange(pending.selection.start, pending.selection.end);
  }, [inputRef, value]);

  const currentLoad: LoadState = load.key === requestKey ? load : { ...IDLE_LOAD, status: open ? 'loading' : 'idle' };
  const candidates = currentLoad.candidates;
  const boundedActive = activeIndex >= 0 && activeIndex < candidates.length ? activeIndex : firstEnabled(candidates);

  const commit = useCallback(
    (replacement: TokenReplacement) => {
      pendingSelection.current = { expectedValue: replacement.value, selection: replacement.selection };
      setSelection(replacement.selection);
      onValueChange(replacement.value);
    },
    [onValueChange],
  );

  const close = useCallback(() => {
    if (match && matchTriggerText) {
      setDismissed({ trigger: match.trigger, triggerText: matchTriggerText, start: match.start });
    }
  }, [match, matchTriggerText]);

  // Dismiss outside only at CLICK, after a pointer drag has had time to become
  // a real document Selection. Closing on textarea blur/pointerdown recreates
  // the dangerous interval where Composer sees body focus + a collapsed
  // selection and pulls focus back, destroying the highlight in progress.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const dismissOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (inputRef.current?.contains(target)) return;
      if (document.getElementById(resolvedListboxId)?.contains(target)) return;
      close();
    };
    document.addEventListener('click', dismissOutside);
    return () => document.removeEventListener('click', dismissOutside);
  }, [close, inputRef, open, resolvedListboxId]);

  const accept = useCallback(
    (index: number) => {
      if (!match) return;
      const candidate = candidates[index];
      if (!candidate || candidate.disabled) return;
      commit(replaceComposerTrigger(value, match, candidate.replacement, candidate.append ?? 'space'));
    },
    [candidates, commit, match, value],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      // The IME owns its entire candidate-navigation sequence, not only Enter.
      // Stealing arrows while a Japanese/Chinese/Korean composition is open
      // would move this list instead of the language candidate highlight.
      if (event.nativeEvent.isComposing) return false;
      if (open) {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return true;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          setActiveIndex(nextComposerCandidateIndex(candidates, boundedActive, direction));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          if (boundedActive >= 0) accept(boundedActive);
          return true;
        }
      }
      return false;
    },
    [accept, boundedActive, candidates, close, open],
  );

  // Index-based DOM ids stay valid for paths containing spaces or punctuation;
  // the candidate's durable id remains data, never an aria token.
  const activeId = boundedActive >= 0 ? `${resolvedListboxId}-option-${boundedActive}` : undefined;
  return {
    open,
    status: currentLoad.status,
    provider,
    match,
    candidates,
    activeIndex: boundedActive,
    activeId,
    contextLabel: currentLoad.contextLabel,
    notice: currentLoad.notice,
    error: currentLoad.error,
    listboxId: resolvedListboxId,
    blocksRefocus: open,
    syncSelection: next => setSelection(pendingComposerInputSelection(next)),
    handleKeyDown,
    accept,
    close,
    textareaAria: open
      ? {
          'aria-autocomplete': 'list',
          'aria-controls': resolvedListboxId,
          'aria-expanded': true,
          'aria-activedescendant': activeId,
          'aria-haspopup': 'listbox',
        }
      : {},
  };
}
