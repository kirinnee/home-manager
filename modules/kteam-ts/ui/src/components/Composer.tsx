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

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { CornerDownLeft, Send, Clock, ZapOff, Paperclip } from 'lucide-react';
import { Button } from './Primitives';
import { cn, type Tone } from '../lib/utils';
import { useKeyboardOpen } from '../hooks/useAppViewport';
import { useDebouncedEffect } from '../hooks/useDebounce';
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts';
import { readInputModality, useInputModality } from '../hooks/useInputModality';

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
  /** Ready attachments make an otherwise empty draft submittable. */
  hasAttachments?: boolean;
  /** Uploads may continue while the reader types, but sending waits for them. */
  attachmentsPending?: boolean;
}

/** ~6 lines. Past this the composer scrolls internally instead of eating the
 *  transcript — the shell is exactly 100dvh and has nowhere to give. */
const MAX_TEXTAREA_PX = 148;
/** ~4 lines. A phone at rest has 844px, not 900+, and the transcript is already
 *  paying for a 44px touch floor on every control around it. */
const COMPACT_MAX_TEXTAREA_PX = 96;
/** ~2 lines. With a 336px keyboard up the whole visible app is ~508px, and a
 *  composer that can grow to 148px there is a composer that has eaten a third of
 *  what is left to read. Past this it scrolls internally, which is the same
 *  contract the desktop cap has always had — just measured against the box the
 *  reader can actually see. A percentage of `--app-h` was the obvious form and
 *  the wrong one: 30% of 508px is 152px, which is larger than the desktop cap. */
const COMPACT_KEYBOARD_MAX_TEXTAREA_PX = 64;
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

export function shouldRefocusComposer({
  touchAffected,
  activeElementIsBody,
  disabled,
  sending,
}: {
  touchAffected: boolean;
  activeElementIsBody: boolean;
  disabled?: boolean;
  sending?: boolean;
}): boolean {
  return !touchAffected && activeElementIsBody && !disabled && !sending;
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
  readModality?: typeof readInputModality;
}) {
  return (
    <textarea
      ref={inputRef}
      value={draft}
      onChange={e => onDraftChange(e.target.value)}
      placeholder={placeholder ?? 'Message this teammate…'}
      rows={1}
      disabled={disabled || sending}
      aria-label="Message"
      className={cn(
        'block w-full resize-none border-0 bg-transparent py-row-y text-fg',
        'placeholder:text-faint focus:border-0 focus:shadow-none focus:outline-none focus-visible:outline-none',
        'disabled:cursor-not-allowed',
      )}
      onKeyDown={e => {
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
  hasAttachments,
  attachmentsPending,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const disabledReasonId = useId();
  const keyboardOpen = useKeyboardOpen();
  const { touchAffected, enterSends } = useInputModality();
  // The growth cap is a property of the box the reader can see, so it follows
  // the viewport rather than the device. Desktop is unchanged at 148px.
  const maxTextareaPx = !compact
    ? MAX_TEXTAREA_PX
    : keyboardOpen
      ? COMPACT_KEYBOARD_MAX_TEXTAREA_PX
      : COMPACT_MAX_TEXTAREA_PX;

  // Keep focus on the composer across re-renders (the user types → state
  // updates → React re-renders → focus would otherwise jump to <body>).
  useEffect(() => {
    if (
      ref.current &&
      shouldRefocusComposer({
        touchAffected,
        activeElementIsBody: document.activeElement === document.body,
        disabled,
        sending,
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
  }, [draft, maxTextareaPx]);

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
  const keyboardSubmit = selectComposerKeyboardSubmit({ busy, onSubmit, onInterruptAndSend });
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

  const interruptControl = showInterrupt ? (
    <Button
      className={cn(touchAffected && 'min-h-[44px] min-w-[44px]')}
      variant="danger"
      size="sm"
      disabled={!canSubmit}
      aria-disabled={!canSubmit}
      aria-label="Interrupt the current turn and send this message now"
      aria-describedby={disabledReason ? disabledReasonId : undefined}
      title="Stop the current turn safely, then deliver this message now"
      onClick={() => onInterruptAndSend?.()}
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
  ) : null;

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
      onClick={() => onSubmit()}
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
      onClick={() => onSubmit()}
    >
      <Send size={12} aria-hidden="true" />
      {/* Touch-only branch, so always icon-only: the glyph carries the
          meaning and `aria-label` carries the name. Kept as `sr-only`
          rather than dropped so the button has visible-to-AT text too. */}
      <span className="sr-only">Send</span>
    </Button>
  ) : null;

  return (
    <div
      data-density-region="composer"
      className={cn(
        'kt-composer transition-colors motion-reduce:transition-none',
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
      {attachmentSlot}
      {compact ? (
        // PHONE DOCK (Telegram). Attach bottom-LEFT, send/queue bottom-RIGHT, the
        // textarea between them growing UPWARD — the controls flank the input on
        // the same baseline instead of sitting in their own row beneath it, so
        // they cost NO vertical band. `items-end` pins the 44px controls to the
        // bottom while the textarea rises; `min-w-0 flex-1` lets the textarea
        // take all the width the edge-hugging controls leave and still shrink so
        // a busy row (attach + Interrupt & send + Queue) never overflows.
        <>
          <div className="kt-composer__dock flex items-end gap-xs">
            {attachControl && <div className="flex shrink-0 items-end">{attachControl}</div>}
            <div className="min-w-0 flex-1">
              {/* Borderless + transparent: the composer WRAPPER is the input as
                  far as the eye and the focus ring are concerned. */}
              <ComposerTextarea
                inputRef={ref}
                draft={draft}
                onDraftChange={onDraftChange}
                onSubmit={keyboardSubmit}
                canSubmit={canSubmit}
                disabled={disabled}
                sending={sending}
                placeholder={placeholder}
              />
            </div>
            {(interruptControl || sendControl) && (
              // STACKED VERTICAL ICONS on touch. Interrupt (destructive) sits on
              // TOP and Queue/Send (the safe default) on the BOTTOM, nearest the
              // thumb, so the reachable target is the non-destructive one. Two
              // 44px icons in a column instead of a row leaves the textarea the
              // full width it needs at 360px; the column only reaches its ~92px
              // height in the busy state, when both controls are present.
              <div className="flex shrink-0 flex-col items-end gap-xs">
                {interruptControl}
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
          <ComposerTextarea
            inputRef={ref}
            draft={draft}
            onDraftChange={onDraftChange}
            onSubmit={keyboardSubmit}
            canSubmit={canSubmit}
            disabled={disabled}
            sending={sending}
            placeholder={placeholder}
          />

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
  const { model, contextPercent, status, statusTone, liveStatus } = context;
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
  const { contextPercent, liveStatus } = context;
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
