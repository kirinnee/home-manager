// Chat composer — ONE input surface.
//
// It used to be a bordered box containing a second bordered box (the textarea)
// with a button row beneath it: a form, not a place to talk. This is a single
// surface — a borderless auto-growing textarea, then context, hint and actions
// on ONE compact line inside the box. The whole thing takes the focus ring as
// one object, the way Telegram and claude.ai do it.
//
// SAFETY SEMANTICS ARE EXPLICIT, and they are the reason this file has more
// comments than markup:
//   - Enter (no Shift, not composing) takes the SAFE path only with positive
//     fine-pointer + hover hardware-desktop confidence: send when idle, QUEUE
//     when busy. In every touch/ambiguous context it inserts a newline, as does
//     Shift+Enter. Interrupting is an explicit click and can never be reached
//     by a keystroke.
//   - An IME composition Enter is ignored entirely (`isComposing`), so
//     Japanese/Chinese/Korean input can't send.
//   - `sending` locks the whole surface: Enter is a no-op and every rendered
//     action disables, so a second keystroke or click cannot launch a duplicate.
//     The page holds a synchronous ref guard as well, and every mutation carries
//     an idempotency id (the server-side backstop).
//   - `disabled` is the structured-question path: when the daemon is waiting on
//     a QuestionForm answer, that form IS the input and this is inert.
//
// HEIGHT STABILITY. On desktop the context/hint/action line is fixed-height,
// single-line and never wrapping; unknown context values render as "—". The
// transcript's follow behaviour keys off viewport height, so model or status
// arriving cannot grow the composer mid-stream. The textarea grows only in
// response to typing — a deliberate, user-driven change — and stops at
// MAX_TEXTAREA_PX.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { CornerDownLeft, Send, Clock, ZapOff, Paperclip } from 'lucide-react';
import { Button } from './Primitives';
import { cn, type Tone } from '../lib/utils';
import { useKeyboardOpen } from '../hooks/useAppViewport';
import { useDebouncedEffect } from '../hooks/useDebounce';
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts';
import { readInputModality, useInputModality } from '../hooks/useInputModality';
import { useDictationBundle } from './DictationControl';
import { useDictationShortcut } from '../lib/stt/use-dictation-shortcut';
import { ComposerAutocompletePopover } from './ComposerAutocomplete';
import { useComposerAutocomplete, type ComposerAutocompleteController } from './composer-autocomplete-engine';
import { createComposerAutocompleteProviders } from './composer-autocomplete-providers';
import { COMPOSER_TEXT_METRICS, ComposerHighlight, syncComposerHighlightViewport } from './ComposerHighlight';
import { useMdComposePref } from '../lib/md-compose';

/** Quiet window before a non-empty draft is written to storage. Debounced so a
 *  fast typist does not hit localStorage on every keystroke; short enough that a
 *  draft is durable within a breath of the reader pausing. */
const DRAFT_SAVE_DEBOUNCE_MS = 400;

/** Facts the compact context line accepts. Every one is optional — its height
 *  does not depend on any of them being known. */
export interface ComposerContext {
  model?: string;
  /** Accepted for the frozen page contract, but intentionally never rendered:
   *  turn belongs in session metadata. */
  turn?: number;
  contextPercent?: number;
  status?: string;
  statusTone?: Tone;
  liveStatus?: 'connecting' | 'open' | 'closed';
}

interface Props {
  draft: string;
  onDraftChange(value: string): void;
  /** Session this composer belongs to. When present, the TEXT draft is
   *  persisted per session (localStorage, see lib/drafts.ts) so it survives a
   *  reload. Optional on purpose: without it — the SSR/test render, or a mount
   *  site that has not opted in yet — persistence is simply inert, never a
   *  crash. Pending attachments are never persisted. */
  sessionId?: string;
  onSubmit(): void;
  onInterruptAndSend?(): void;
  disabled?: boolean;
  busy?: boolean;
  sending?: boolean;
  placeholder?: string;
  context?: ComposerContext;
  /** Phone chrome. The same single context/action line gets denser and NOTHING
   *  about the safety semantics moves:
   *
   *    - context becomes a socket dot plus `ctx N%` in the action row's left
   *      slot. Model is one tap away in session details and is not a fact you
   *      steer by while typing. Turn is metadata and never enters this surface.
   *    - the keyboard hint stops being VISIBLE. "Shift+Enter newline" is not a
   *      thing a phone keyboard can do, so on touch it was a line of type that
   *      cost 20px to say nothing. It is moved to `sr-only`, NOT removed: the
   *      `aria-live` status words ("sending…", the send/queue change) are inside
   *      it, and dropping them would regress a11y S-4.
   *
   *  Enter/Shift+Enter/IME handling, the send lock, the disabled path and the
   *  44px/16px floors are untouched — they are not chrome. */
  compact?: boolean;
  /** Capture only. The page owns validation, eager upload, retry and removal. */
  onFiles?(files: File[]): void;
  /** Page-owned pending upload chips, placed inside the single composer surface. */
  attachmentSlot?: ReactNode;
  /** The model/reasoning switch, placed on the phone status line as a tap target
   *  (see ComposerRuntime). Page-owned because it needs the live SessionView and
   *  the Terminal-tab callback; the composer only gives it a home on the meta
   *  line. Rest-only chrome, so it rides the same `data-kb-hide` collapse. */
  runtimeControl?: ReactNode;
  /** Ready attachments make an otherwise empty draft submittable. */
  hasAttachments?: boolean;
  /** Uploads may continue while the reader types, but sending waits for them. */
  attachmentsPending?: boolean;
}

/** ~6 lines. Past this the composer scrolls internally instead of eating the
 *  transcript — the shell is exactly 100dvh and has nowhere to give. */
const MAX_TEXTAREA_PX = 148;
/** ~6 lines. A phone AT REST has ~844px and the transcript can spare it; the old
 *  ~4-line cap made the reader scroll a draft they were still writing. */
const COMPACT_MAX_TEXTAREA_PX = 160;
/** ~5 lines. The dock ALREADY stands 92px tall — two stacked 44px touch targets
 *  (attach/mic) on the left, interrupt/send on the right — so the first ~3 lines
 *  of the textarea cost NOTHING: they fill height the dock is already paying for
 *  (the textarea is top-aligned into that column, see the dock markup). The old
 *  64px cap parked the reader at ~2 visible lines INSIDE a 92px box — it capped
 *  the text well below the height already on screen, which is precisely the "I
 *  can't see more than two rows" report. 140px shows ~5 lines before it scrolls
 *  internally, and with a 336px keyboard up (visible app ~508px) a 140px textarea
 *  is a ~150px composer — reached only once the reader has typed five lines, which
 *  is exactly when they want to see them. A percentage of `--app-h` was the
 *  obvious form and the wrong one: it caps a two-line draft as hard as a ten-line
 *  one. */
const COMPACT_KEYBOARD_MAX_TEXTAREA_PX = 140;
const MIN_TEXTAREA_PX = 38;

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  pend: 'text-pend',
  accent: 'text-accent',
};

export function composerCanSubmit({
  draft,
  disabled,
  sending,
  hasAttachments,
  attachmentsPending,
}: {
  draft: string;
  disabled?: boolean;
  sending?: boolean;
  hasAttachments?: boolean;
  attachmentsPending?: boolean;
}): boolean {
  return !disabled && !sending && !attachmentsPending && (draft.trim().length > 0 || hasAttachments === true);
}

/** Pure keyboard policy used by the real handler and its exhaustive matrix. */
export function composerEnterDecision({
  key,
  shiftKey,
  isComposing,
  enterSends,
  canSubmit,
}: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  enterSends: boolean;
  canSubmit: boolean;
}): { preventDefault: boolean; submit: boolean } {
  if (key !== 'Enter' || shiftKey || isComposing || !enterSends) {
    return { preventDefault: false, submit: false };
  }
  return { preventDefault: true, submit: canSubmit };
}

export function handleComposerKeyDown({
  event,
  canSubmit,
  readEnterSends,
  onSubmit,
}: {
  event: {
    key: string;
    shiftKey: boolean;
    isComposing: boolean;
    preventDefault(): void;
  };
  canSubmit: boolean;
  readEnterSends(): boolean;
  onSubmit(): void;
}): void {
  // `readEnterSends` is invoked inside every event, never captured from a
  // render. This is the safety edge that makes touch -> next Enter immediate.
  const decision = composerEnterDecision({
    key: event.key,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
    enterSends: readEnterSends(),
    canSubmit,
  });
  if (decision.preventDefault) event.preventDefault();
  if (decision.submit) onSubmit();
}

export function composerStatusCopy({
  sending,
  busy,
  enterSends,
}: {
  sending?: boolean;
  busy?: boolean;
  enterSends: boolean;
}): { liveText: string; keyboardHint: string } {
  const liveText = sending
    ? 'Sending…'
    : busy
      ? enterSends
        ? 'Enter queues for the next turn'
        : 'Queue sends at the next turn boundary'
      : enterSends
        ? 'Enter sends'
        : 'Send button sends';
  return {
    liveText,
    keyboardHint: enterSends && !sending ? ' · Shift+Enter newline' : '',
  };
}

/** MAY THE COMPOSER PULL FOCUS BACK TO ITSELF RIGHT NOW?
 *
 *  `activeElementIsBody` means "focus fell off something", which is the case
 *  this exists to repair — but it is ALSO exactly what a reader selecting
 *  transcript prose looks like, because prose is not focusable. Focusing a text
 *  field discards the document selection, so refocusing on that signal alone
 *  silently deletes the reader's highlight.
 *
 *  Measured against the deployed build (A/B, desktop viewport, a session with
 *  nothing running): as shipped, a held selection died within 1s to a single
 *  `focus()` call, with ZERO DOM mutations anywhere in the transcript — which is
 *  why three rounds of mutation-hunting never found it. Vetoing the refocus on a
 *  held selection kept the same selection alive for 20s across 46 suppressed
 *  attempts.
 *
 *  Nothing else changes: a selection is released the moment the reader clicks or
 *  types, and the very next render restores focus exactly as before. */
export function shouldRefocusComposer({
  touchAffected,
  activeElementIsBody,
  disabled,
  sending,
  selectionHeld,
}: {
  touchAffected: boolean;
  activeElementIsBody: boolean;
  disabled?: boolean;
  sending?: boolean;
  /** Is the reader holding a text selection in the document (i.e. outside this
   *  textarea — a textarea's own selection is not part of the document
   *  Selection, so typing and dictation are unaffected)? */
  selectionHeld?: boolean;
}): boolean {
  return !touchAffected && activeElementIsBody && !disabled && !sending && !selectionHeld;
}

/** Is a document text selection currently held? Mirrors the transcript's own
 *  test (Transcript.pinBlockedBySelection, TranscriptRow.isPlainBlockTap): a
 *  non-collapsed selection with at least one range. A bare caret is no
 *  obstacle. */
function documentSelectionHeld(): boolean {
  const s = typeof window === 'undefined' ? null : window.getSelection();
  return !!s && !s.isCollapsed && s.rangeCount > 0;
}

/** Restore the caret after a dictated transcript has rendered into the
 * controlled textarea. Deliberately does not focus: on touch, focus would raise
 * the keyboard under the reader's thumb just because transcription finished. */
export function restoreComposerSelection(
  input: Pick<HTMLTextAreaElement, 'value' | 'setSelectionRange'> | null,
  expectedText: string,
  caret: number,
): boolean {
  if (!input || input.value !== expectedText) return false;
  const finiteCaret = Number.isFinite(caret) ? Math.trunc(caret) : expectedText.length;
  const boundedCaret = Math.max(0, Math.min(expectedText.length, finiteCaret));
  input.setSelectionRange(boundedCaret, boundedCaret);
  return true;
}

/**
 * Keyboard delivery never selects the destructive action. `busy` changes the
 * safe callback's meaning to queue and changes the visible label, but the
 * callback identity remains `onSubmit`; interrupt is click-only in every state.
 */
export function selectComposerKeyboardSubmit(actions: {
  busy?: boolean;
  onSubmit(): void;
  onInterruptAndSend?(): void;
}): () => void {
  return actions.onSubmit;
}

export function clipboardImageFiles(
  items: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>,
): File[] {
  return Array.from(items)
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/**
 * Hook-free so the exact native-event wiring can be exercised without adding a
 * DOM implementation to this package's test stack. The live reader defaults to
 * the singleton and is called inside each key event, never at render time.
 */
export function ComposerTextarea({
  inputRef,
  draft,
  onDraftChange,
  onSubmit,
  canSubmit,
  disabled,
  sending,
  placeholder,
  autocomplete,
  highlighted,
  syncHighlight,
  readModality = readInputModality,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  canSubmit: boolean;
  disabled?: boolean;
  sending?: boolean;
  placeholder?: string;
  /** The trigger engine, when this composer has one. Optional so an SSR or
   *  test render stays a plain textarea with no behaviour change. */
  autocomplete?: Pick<ComposerAutocompleteController, 'handleKeyDown' | 'syncSelection' | 'textareaAria'>;
  /** Paint comes from an aria-hidden sibling; this remains the native input. */
  highlighted?: boolean;
  /** Scroll/input callback for the paint-only sibling. Selection is untouched. */
  syncHighlight?(input: HTMLTextAreaElement): void;
  readModality?: typeof readInputModality;
}) {
  // The engine detects from `value` + caret, and the caret only moves in the
  // DOM. Every event that can move it has to report, or the engine decides
  // against a stale offset — the classic symptom being a list that opens one
  // keystroke late.
  const syncSelection = (target: HTMLTextAreaElement) =>
    autocomplete?.syncSelection({ start: target.selectionStart ?? 0, end: target.selectionEnd ?? 0 });
  return (
    <textarea
      ref={inputRef}
      value={draft}
      {...(autocomplete?.textareaAria ?? {})}
      onChange={e => {
        onDraftChange(e.target.value);
        syncSelection(e.target);
        syncHighlight?.(e.target);
      }}
      onInput={e => syncHighlight?.(e.currentTarget)}
      onScroll={e => syncHighlight?.(e.currentTarget)}
      onSelect={e => syncSelection(e.currentTarget)}
      onClick={e => syncSelection(e.currentTarget)}
      onKeyUp={e => syncSelection(e.currentTarget)}
      placeholder={placeholder ?? 'Message this teammate…'}
      rows={1}
      disabled={disabled || sending}
      aria-label="Message"
      className={cn(
        COMPOSER_TEXT_METRICS,
        'relative z-[1] resize-none bg-transparent',
        highlighted ? 'text-transparent [caret-color:var(--fg)]' : 'text-fg',
        'placeholder:text-faint focus:border-0 focus:shadow-none focus:outline-none focus-visible:outline-none',
        'disabled:cursor-not-allowed',
      )}
      onKeyDown={e => {
        // THE ENGINE GETS FIRST REFUSAL, and the early return is load-bearing.
        // It returns true only when it consumed the key (Enter/Tab accepting a
        // candidate, arrows moving the highlight, Escape closing). Without the
        // return, Enter would accept a candidate AND send the message in the
        // same keystroke.
        if (autocomplete?.handleKeyDown(e)) return;
        handleComposerKeyDown({
          event: {
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
            preventDefault: () => e.preventDefault(),
          },
          canSubmit,
          readEnterSends: () => readModality().enterSends,
          onSubmit,
        });
      }}
    />
  );
}

export function Composer({
  draft,
  onDraftChange,
  sessionId,
  onSubmit,
  onInterruptAndSend,
  disabled,
  busy,
  sending,
  placeholder,
  context,
  compact,
  onFiles,
  attachmentSlot,
  runtimeControl,
  hasAttachments,
  attachmentsPending,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const disabledReasonId = useId();
  const keyboardOpen = useKeyboardOpen();
  const { touchAffected, enterSends } = useInputModality();
  const markdownHighlight = useMdComposePref() === 'on';
  const syncHighlight = useCallback((input: HTMLTextAreaElement) => {
    syncComposerHighlightViewport(input, highlightRef.current);
  }, []);
  const pendingDictationSelection = useRef<{ text: string; caret: number } | null>(null);
  const dictation = useDictationBundle({
    sessionId,
    draft,
    selectionRef: ref,
    disabled: disabled || sending,
    layout: 'compact',
    onDraftChange: result => {
      pendingDictationSelection.current = result;
      onDraftChange(result.text);
    },
  });
  useDictationShortcut({
    binding: dictation.shortcut,
    handle: dictation.handle,
    composerRef: ref,
    disabled: disabled || sending,
  });
  // The growth cap is a property of the box the reader can see, so it follows
  // the viewport rather than the device. Desktop is unchanged at 148px.
  const maxTextareaPx = !compact
    ? MAX_TEXTAREA_PX
    : keyboardOpen
      ? COMPACT_KEYBOARD_MAX_TEXTAREA_PX
      : COMPACT_MAX_TEXTAREA_PX;

  // HARD REQUIREMENT: memoised on [sessionId], never built inline.
  //
  // The load effect in useComposerAutocomplete has `provider` in its dependency
  // array. Passing a freshly-built array would give it new provider IDENTITIES
  // on every render, so the effect would re-run, setState, re-render, and
  // refetch — a network request per keystroke, with the skills and directory
  // caches thrown away each time. That is the same shape as the per-render
  // work that produced this session's worst bug.
  //
  // No sessionId (SSR, tests, a mount site that has not opted in) means no
  // providers, and the engine is inert rather than broken.
  const autocompleteProviders = useMemo(
    () => (sessionId ? createComposerAutocompleteProviders({ sessionId }) : []),
    [sessionId],
  );
  const autocomplete = useComposerAutocomplete({
    value: draft,
    onValueChange: onDraftChange,
    inputRef: ref,
    providers: autocompleteProviders,
    // A disabled/sending composer is inert; a question form owns the input.
    disabled: disabled || sending,
  });

  // Keep focus on the composer across re-renders (the user types → state
  // updates → React re-renders → focus would otherwise jump to <body>).
  //
  // NO DEPENDENCY ARRAY, so this runs after EVERY render — and the store
  // re-renders SessionChatPage on every fleet notification, ~2-3 times a second
  // whenever ANY session in the fleet is doing something, whether or not this
  // one is. That cadence is harmless now that a held selection vetoes the
  // refocus (see shouldRefocusComposer), but it is what turned this effect into
  // "the highlight vanishes about a second after I make it", on a session that
  // was itself completely idle.
  useEffect(() => {
    if (
      ref.current &&
      shouldRefocusComposer({
        touchAffected,
        activeElementIsBody: document.activeElement === document.body,
        disabled,
        sending,
        // An open suggestion list is a held interaction just like a held text
        // selection: this effect runs after EVERY render (no dep array, ~2-3×
        // a second from fleet notifications), and refocusing mid-list is how
        // the composer used to eat the reader's selection.
        selectionHeld: documentSelectionHeld() || autocomplete.blocksRefocus,
      })
    ) {
      ref.current.focus();
    }
  });

  // Auto-grow. Measured BEFORE paint so the box never flashes at the wrong
  // height, and capped so a pasted essay cannot swallow the conversation. The
  // cap is a dependency: opening the keyboard has to re-run this, or a draft
  // that grew to four lines at rest keeps its 96px through a 508px viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(maxTextareaPx, Math.max(MIN_TEXTAREA_PX, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxTextareaPx ? 'auto' : 'hidden';
    syncHighlight(el);
  }, [draft, markdownHighlight, maxTextareaPx, syncHighlight]);

  // Dictation updates a controlled value, so the browser cannot place the caret
  // until React has committed that value. Restore only the selection here;
  // never call focus(), and discard a stale selection if the parent changed the
  // draft to something other than the transcript result in the meantime.
  useLayoutEffect(() => {
    const pending = pendingDictationSelection.current;
    if (!pending) return;
    pendingDictationSelection.current = null;
    if (pending.text !== draft) return;
    restoreComposerSelection(ref.current, pending.text, pending.caret);
  }, [draft]);

  // ---- per-session draft persistence ---------------------------------------
  //
  // HYDRATE ONCE, THEN persist. `draftsReady` gates the save/clear effects so
  // the restore below can never be clobbered by the empty-draft clear: the
  // clear effect is inert until hydration has read storage and flipped the gate.
  // The Composer is remounted per page (sessionId stable for its lifetime), so
  // this runs a single time per open session.
  const [draftsReady, setDraftsReady] = useState(false);
  useEffect(() => {
    if (!sessionId) {
      setDraftsReady(true);
      return;
    }
    const saved = loadDraft(sessionId);
    // Only restore into an empty buffer — never clobber text the reader is
    // already carrying (a retained pane navigated back into with content).
    if (saved && draft.trim().length === 0) onDraftChange(saved);
    setDraftsReady(true);
    // Deliberately keyed on sessionId alone: a once-per-session hydration that
    // must not re-fire when the draft it just restored re-renders the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Debounced write of a non-empty draft. An empty/whitespace draft is handled
  // by the immediate clear below, so this never writes one.
  useDebouncedEffect(
    () => {
      if (!draftsReady || !sessionId) return;
      if (draft.trim().length > 0) saveDraft(sessionId, draft);
    },
    [draftsReady, sessionId, draft],
    DRAFT_SAVE_DEBOUNCE_MS,
  );

  // The clear path — and, crucially, the SEND path. send()/interruptAndSend()
  // set the draft to '' the instant a message is ACCEPTED (verified against
  // SessionChatPage: both the immediate send and the queued-for-next-turn
  // disposition clear the draft synchronously before the network call), so an
  // empty buffer is the signal that the draft was consumed. Cleared immediately,
  // not on the debounce, so a reload right after sending does not resurrect it.
  useEffect(() => {
    if (!draftsReady || !sessionId) return;
    if (draft.trim().length === 0) clearDraft(sessionId);
  }, [draftsReady, sessionId, draft]);

  const canSubmit = composerCanSubmit({ draft, disabled, sending, hasAttachments, attachmentsPending });
  const showInterrupt = Boolean(busy && !disabled && onInterruptAndSend);
  // The agent writes files during the turn the reader just triggered, so the
  // directory listings cached for `@` are stale the moment a message goes out.
  const submitAndRefreshSuggestions = useCallback(() => {
    for (const provider of autocompleteProviders) provider.reset?.();
    onSubmit();
  }, [autocompleteProviders, onSubmit]);
  const keyboardSubmit = selectComposerKeyboardSubmit({
    busy,
    onSubmit: submitAndRefreshSuggestions,
    onInterruptAndSend,
  });
  const disabledReason = disabled
    ? 'Answer the question above first.'
    : sending
      ? 'Sending…'
      : attachmentsPending
        ? 'Wait for images to finish uploading.'
        : draft.trim().length === 0 && !hasAttachments
          ? 'Message is empty.'
          : undefined;
  const statusCopy = composerStatusCopy({ sending, busy, enterSends });

  // The three controls, extracted so both layouts place the SAME markup: desktop
  // groups them on the right of the action line, the phone dock flanks the
  // textarea with attach on the left and send/queue on the right (Telegram). The
  // attributes are the batch-1 invariant (44px, labelled, disabled-not-hidden)
  // and must not diverge between layouts — Composer.test.tsx asserts them.
  const attachControl = onFiles ? (
    <>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        disabled={disabled || sending}
        tabIndex={-1}
        aria-hidden="true"
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <Button
        className="min-h-[44px] min-w-[44px] px-2"
        variant="ghost"
        size="sm"
        disabled={disabled || sending}
        aria-label="Attach images"
        title="Attach PNG, JPEG, GIF or WebP images"
        onClick={() => fileInputRef.current?.click()}
      >
        <Paperclip size={15} aria-hidden="true" />
        <span className="sr-only">Attach images</span>
      </Button>
    </>
  ) : null;

  // The interrupt is destructive and click-only — keyboard delivery can never
  // reach it. `reserved` builds the SAME button in an inert, invisible form:
  // the phone dock renders it that way when the session is NOT interruptible so
  // the interrupt's ROW is always present and the composer height never jumps as
  // a turn starts or ends (the user asked for the box to "always include the
  // interrupt"). `visibility:hidden` (Tailwind `invisible`) reserves the button's
  // exact layout box in every theme — no magic pixel value, no separate spacer —
  // while `aria-hidden` + `tabIndex=-1` + `disabled` keep it out of the a11y tree
  // and unreachable, because there is nothing to interrupt yet. The visible-when-
  // active attributes (44px, labelled, glyph+danger tone, sr-only word) are the
  // batch-1 invariant and must stay identical to the active form — one builder,
  // so they cannot diverge.
  const buildInterrupt = (reserved: boolean) => (
    <Button
      className={cn(touchAffected && 'min-h-[44px] min-w-[44px]', reserved && 'invisible')}
      variant="danger"
      size="sm"
      disabled={reserved || !canSubmit}
      aria-disabled={reserved || !canSubmit}
      aria-hidden={reserved || undefined}
      tabIndex={reserved ? -1 : undefined}
      aria-label="Interrupt the current turn and send this message now"
      aria-describedby={!reserved && disabledReason ? disabledReasonId : undefined}
      title="Stop the current turn safely, then deliver this message now"
      onClick={reserved ? undefined : () => onInterruptAndSend?.()}
    >
      <ZapOff size={12} aria-hidden="true" />
      {/* ICON-ONLY ON TOUCH, like Send/Queue (the user asked for interrupt and
          queue to both be icons and to stack vertically). It stays visually
          DISTINCT from the safe Queue in two ways a phone can read without a
          tooltip: a different glyph (ZapOff vs Clock) and the danger tone. The
          word is moved to `sr-only`, never dropped, so `aria-label` + the hidden
          word keep it named in every state. Desktop keeps the visible word. */}
      <span className={cn(touchAffected && 'sr-only')}>Interrupt &amp; send</span>
    </Button>
  );
  // Active interrupt: rendered only when the session can actually be interrupted.
  // Desktop uses this directly (its single action row has no jump to fix, so it
  // simply omits the control when idle); the phone dock swaps in the reserved
  // form to hold the height.
  const interruptControl = showInterrupt ? buildInterrupt(false) : null;

  const sendControl = busy ? (
    <Button
      className={cn(touchAffected && 'min-h-[44px] min-w-[44px]')}
      variant="primary"
      size="sm"
      disabled={!canSubmit}
      aria-disabled={!canSubmit}
      aria-label="Queue this message for the next turn"
      aria-describedby={disabledReason ? disabledReasonId : undefined}
      title="Deliver at the next turn boundary (safe)"
      onClick={() => submitAndRefreshSuggestions()}
    >
      <Clock size={12} aria-hidden="true" />
      {/* Icon-only on touch (the word eats the row on a phone); desktop
          keeps the label. The accessible name lives in `aria-label`, so
          the button is never nameless — the word is hidden visually,
          present for assistive tech, in every state. */}
      <span className={cn(touchAffected && 'sr-only')}>Queue</span>
    </Button>
  ) : touchAffected ? (
    // An explicit control is the mandatory path whenever Enter is
    // conservative. It remains visible and labelled even while empty,
    // disabled, or sending; native disabled plus the described reason
    // explains why it is momentarily unavailable.
    <Button
      className="kt-composer__tap-send min-h-[44px] min-w-[44px]"
      variant="primary"
      size="sm"
      disabled={!canSubmit}
      aria-disabled={!canSubmit}
      aria-label="Send this message"
      aria-describedby={disabledReason ? disabledReasonId : undefined}
      title="Send now"
      onClick={() => submitAndRefreshSuggestions()}
    >
      <Send size={12} aria-hidden="true" />
      {/* Touch-only branch, so always icon-only: the glyph carries the
          meaning and `aria-label` carries the name. Kept as `sr-only`
          rather than dropped so the button has visible-to-AT text too. */}
      <span className="sr-only">Send</span>
    </Button>
  ) : null;

  // The wrapper follows the textarea's real, measured height; the overlay is
  // absolute and therefore cannot contribute a pixel to composer growth. The
  // same element is placed in the compact and desktop layouts below, keeping
  // their textarea event/API contracts identical.
  const inputLayer = (
    <div data-composer-input-layer="" className="relative min-w-0 w-full">
      <ComposerHighlight text={draft} overlayRef={highlightRef} enabled={markdownHighlight} />
      <ComposerTextarea
        inputRef={ref}
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={keyboardSubmit}
        canSubmit={canSubmit}
        disabled={disabled}
        sending={sending}
        placeholder={placeholder}
        autocomplete={autocomplete}
        highlighted={markdownHighlight}
        syncHighlight={syncHighlight}
      />
    </div>
  );

  return (
    <div
      data-density-region="composer"
      className={cn(
        // `relative` is what lets the suggestion list anchor to the TOP edge of
        // the composer. It opens upward, over the transcript, so it can never
        // be covered by a software keyboard — the placement requirement the
        // whole feature is judged on.
        'kt-composer relative transition-colors motion-reduce:transition-none',
        compact && 'kt-composer--compact',
        disabled && 'opacity-60',
      )}
      onPaste={event => {
        if (!onFiles || disabled || sending) return;
        const files = clipboardImageFiles(event.clipboardData.items);
        if (!files.length) return;
        event.preventDefault();
        onFiles(files);
      }}
      onDragOver={event => {
        if (!onFiles || disabled || sending) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={event => {
        if (!onFiles || disabled || sending) return;
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        onFiles(files);
      }}
    >
      {/* Rendered ONCE for both layouts: it is positioned against the composer
          root, not against either textarea, so the phone dock and the desktop
          form share it. */}
      <ComposerAutocompletePopover controller={autocomplete} />
      {attachmentSlot}
      {/* The dictation mini panel is fixed outside the composer flow, so it
          renders once regardless of layout and paints nothing while hidden. */}
      {dictation.sheet}
      {compact ? (
        // PHONE DOCK (Telegram). Attach TOP-left, send/queue BOTTOM-right, and
        // the text TOP-ALIGNED between them — the controls flank the input
        // instead of sitting in their own row beneath it, so they cost NO
        // vertical band.
        //
        // ALIGNMENT IS THE FIX FOR "the text sits low with empty space above it".
        // The stacked icon columns are 92px tall (two 44px targets + a gap) and a
        // one-line textarea is ~38px. The old row was `items-end`, which pinned
        // that short textarea to the BOTTOM of the 92px column and left 65px of
        // dead air above the first line — the reader typed into the middle of the
        // box. Now the row is `items-stretch`: the textarea's flex cell stretches
        // to the full dock height and the text sits at its TOP, so line one is at
        // the top edge and new lines grow DOWNWARD from a fixed first line (the
        // box grows down, the first line never moves). The icon columns own their
        // own vertical placement instead of riding the row's baseline — attach
        // pinned to the top (`justify-start`), interrupt/send pinned to the bottom
        // (`justify-end`, nearest the thumb) — so the arrangement the reader asked
        // for holds at every height. `min-w-0 flex-1` still lets the textarea take
        // the width the edge-hugging controls leave and shrink so a busy row
        // (attach + Interrupt & send + Queue) never overflows.
        <>
          <div className="kt-composer__dock flex items-stretch gap-xs">
            {(attachControl || dictation.control) && (
              // STACKED VERTICAL ICONS, the same move as Interrupt/Queue on the
              // right (the user asked "can the attach and mic be stacked?"). A
              // column of two 44px icons costs one icon's WIDTH instead of two,
              // which is the scarce axis at 360px — it buys the textarea back the
              // width a side-by-side row spent, at the cost of height the dock is
              // already paying for the interrupt column opposite it. `justify-start`
              // pins the pair to the TOP of the stretched column so attach stays
              // top-left no matter how tall the textarea grows.
              <div className="flex shrink-0 flex-col items-end justify-start gap-xs">
                {attachControl}
                {dictation.control}
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Borderless + transparent: the composer WRAPPER is the input as
                  far as the eye and the focus ring are concerned. The wrapper
                  stretches to the dock height (items-stretch on the row) and the
                  textarea sits at its top, so the first line is at the top edge. */}
              {inputLayer}
            </div>
            {(interruptControl || sendControl) && (
              // STACKED VERTICAL ICONS on touch. Interrupt (destructive) sits on
              // TOP and Queue/Send (the safe default) on the BOTTOM, nearest the
              // thumb, so the reachable target is the non-destructive one. Two
              // 44px icons in a column instead of a row leaves the textarea the
              // full width it needs at 360px.
              //
              // THE INTERRUPT ROW IS ALWAYS RESERVED. When the session is not
              // interruptible the top slot holds the inert, invisible interrupt
              // (see buildInterrupt) instead of collapsing, so Send/Queue stays
              // pinned to the bottom and the composer height is identical whether
              // or not a turn is running — the height no longer jumps under the
              // reader as a session flips busy/idle. Reserved only when an
              // interrupt is wired at all (`onInterruptAndSend`); a composer that
              // can never interrupt reserves nothing. `justify-end` pins the pair
              // to the BOTTOM of the stretched column so Send stays bottom-right,
              // nearest the thumb, however tall the textarea grows.
              <div className="flex shrink-0 flex-col items-end justify-end gap-xs">
                {interruptControl ?? (onInterruptAndSend ? buildInterrupt(true) : null)}
                {sendControl}
              </div>
            )}
          </div>

          {disabledReason && (
            <span id={disabledReasonId} className="sr-only">
              {disabledReason}
            </span>
          )}

          {/* Status + context live UNDER the dock, not on it — a single thin line
              carrying the spoken live region (always) and the rest-visible socket
              dot + ctx% (`data-kb-hide`, so it is display:none while the keyboard
              is up). When typing, this line has no in-flow content and collapses
              to 0px, which is what returns the reclaimed band to the transcript. */}
          <div className="kt-composer__meta flex items-center gap-xs text-meta text-muted">
            {/* SPOKEN, NEVER SHOWN. `sr-only` and not `hidden`: display:none would
                take the live region straight out of the accessibility tree and a
                screen-reader would stop hearing "sending…" and the send↔queue
                change entirely. */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {statusCopy.liveText}
            </span>
            {/* Dictation status lives in its own non-modal panel, not on this line. */}
            {/* The model, now a tap target — one tap from where the reader is to
                switch it (ComposerRuntime owns the sheet). It carries its own
                `data-kb-hide`, so it collapses with the rest of the meta line
                while typing. */}
            {runtimeControl}
            {context && <CompactContext context={context} sending={sending} />}
          </div>
        </>
      ) : (
        // DESKTOP. The textarea sits above a single non-wrapping action line that
        // carries the full context strip, the Shift+Enter hint and the controls —
        // width is not scarce here, so this layout is unchanged.
        <>
          {/* The textarea is borderless and transparent: the WRAPPER is the input
              as far as the eye (and the focus ring) is concerned. */}
          {inputLayer}

          {disabledReason && (
            <span id={disabledReasonId} className="sr-only">
              {disabledReason}
            </span>
          )}

          <div className="kt-composer__actions min-h-control flex flex-nowrap items-center gap-x-sm gap-y-xs">
            <div className="mr-auto flex min-w-0 items-center gap-sm overflow-hidden">
              {context && <ContextStrip context={context} />}
              {context && enterSends && <Sep />}
              {/* Deliberately NOT `.kt-chrome`: this tells the reader how the
                  keyboard behaves and whether a message is in flight. The line is
                  not itself live: only the changing STATUS words are, so the
                  static Shift+Enter hint is never re-announced (a11y report S-4). */}
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-xs text-meta text-muted',
                  !enterSends && 'sr-only',
                )}
              >
                {sending ? (
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <CornerDownLeft size={11} aria-hidden="true" />
                )}
                <span>
                  {/* Persistent, atomic region: only these status words announce
                      on a send/queue/busy transition. */}
                  <span aria-live="polite" aria-atomic="true">
                    {statusCopy.liveText}
                  </span>
                  {/* Static hint — outside the live region so it is never
                      re-announced. */}
                  {statusCopy.keyboardHint}
                </span>
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-xs">
              {attachControl}
              {dictation.control}
              {interruptControl}
              {sendControl}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Desktop context shares the action line, yields width to the keyboard contract
 *  and busy controls, and never wraps — see the height note at the top. */
function ContextStrip({ context }: { context: ComposerContext }) {
  const { model, contextPercent: rawContextPercent, status, statusTone, liveStatus } = context;
  // Clamp to [0,100] for display: the stored value is honest (can momentarily
  // exceed 100% pre-compaction), but an impossible readout must never render.
  const contextPercent =
    rawContextPercent == null ? rawContextPercent : Math.max(0, Math.min(100, Math.round(rawContextPercent)));
  const ctxTone =
    contextPercent == null ? 'text-faint' : contextPercent >= 90 ? 'text-err' : contextPercent >= 75 ? 'text-warn' : '';
  const socketTone = liveStatus === 'open' ? 'bg-ok' : liveStatus === 'connecting' ? 'bg-warn' : 'bg-err';

  return (
    <div
      data-density-region="composer-context"
      className="mono flex min-w-0 flex-1 items-center gap-x-sm overflow-hidden whitespace-nowrap text-chrome text-muted"
    >
      {liveStatus && (
        <span className="inline-flex shrink-0 items-center text-faint" title={`live event stream ${liveStatus}`}>
          <span className={cn('kt-dot', socketTone)} aria-hidden="true" />
          <span className="sr-only">live event stream {liveStatus}</span>
        </span>
      )}
      {liveStatus && <Sep />}
      <Field className="min-w-0 flex-1 truncate text-fg-soft" title={model ? `model: ${model}` : 'model unknown'}>
        {model || '—'}
      </Field>
      <Sep />
      <Field className={cn('shrink-0', ctxTone)} title="context window used">
        ctx {contextPercent == null ? '—' : `${contextPercent}%`}
      </Field>
      <Sep />
      <Field
        className={cn('min-w-0 max-w-[34%] truncate', statusTone ? TONE_TEXT[statusTone] : '')}
        title={`session status: ${status ?? 'unknown'}`}
      >
        {status ?? '—'}
      </Field>
    </div>
  );
}

/** The phone form of the strip: what is left after asking which of these four
 *  facts you would act on mid-conversation.
 *
 *  `ctx %` survives because it is the one that changes what you do next (a
 *  session at 92% is about to compact), and the socket dot survives because the
 *  app bar that used to carry it is not on screen on a phone — it is the only
 *  rest-visible connection signal WHILE NOT TYPING. It carries `data-kb-hide`,
 *  so a drop that happens mid-draft is not shown here; it surfaces through the
 *  send path instead, which is where it would change what you do. Model and turn
 *  are in the details drawer. It sits INSIDE the action row, so it costs no
 *  height. */
function CompactContext({
  context,
  sending,
  dense,
}: {
  context: ComposerContext;
  sending?: boolean;
  /** Interrupt & send is on the row. THE BUTTONS WIN.
   *
   *  Two full-word buttons plus `ctx 69%` is ~350px of a 346px row at 390px, and
   *  a flex row breaks BEFORE it shrinks — so the readout was pushing Queue onto
   *  a second line and paying 44px for four characters. The dot stays (it is the
   *  only rest-visible connection signal once the app bar is gone on a phone) and
   *  the number moves into the tooltip and the spoken text, both of which it was
   *  already in. */
  dense?: boolean;
}) {
  const { contextPercent: rawContextPercent, liveStatus } = context;
  const contextPercent =
    rawContextPercent == null ? rawContextPercent : Math.max(0, Math.min(100, Math.round(rawContextPercent)));
  const ctxTone =
    contextPercent == null ? 'text-faint' : contextPercent >= 90 ? 'text-err' : contextPercent >= 75 ? 'text-warn' : '';
  const socketTone = liveStatus === 'open' ? 'bg-ok' : liveStatus === 'connecting' ? 'bg-warn' : 'bg-err';

  return (
    <span
      data-kb-hide
      className="mono inline-flex min-w-0 shrink-0 items-center gap-xs truncate"
      title={`context window used: ${contextPercent == null ? 'unknown' : `${contextPercent}%`}${
        liveStatus ? ` · live event stream ${liveStatus}` : ''
      }`}
    >
      {sending ? (
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <span className={cn('kt-dot shrink-0', socketTone)} aria-hidden="true" />
      )}
      {/* The dot is a shape without a word, so the word is spoken instead — and
          the context number is spoken in both variants, seen in only one. */}
      <span className="sr-only">
        live event stream {liveStatus ?? 'unknown'}, context window{' '}
        {contextPercent == null ? 'unknown' : `${contextPercent}% used`}
      </span>
      {!dense && (
        <span className={cn('truncate', ctxTone)} aria-hidden="true">
          ctx {contextPercent == null ? '—' : `${contextPercent}%`}
        </span>
      )}
    </span>
  );
}

function Field({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

function Sep() {
  return (
    <span className="shrink-0 text-border" aria-hidden="true">
      ·
    </span>
  );
}
