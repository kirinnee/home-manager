// Chat composer — ONE input surface.
//
// It used to be a bordered box containing a second bordered box (the textarea)
// with a button row beneath it: a form, not a place to talk. This is a single
// surface — a slim context strip, a borderless auto-growing textarea, and the
// actions INSIDE the box on the same line as the hint. The whole thing takes the
// focus ring as one object, the way Telegram and claude.ai do it.
//
// SAFETY SEMANTICS ARE UNCHANGED, and they are the reason this file has more
// comments than markup:
//   - Enter (no Shift, not composing) always takes the SAFE path: send when
//     idle, QUEUE when busy. Interrupting is an explicit click and can never be
//     reached by a keystroke.
//   - Shift+Enter inserts a newline; an IME composition Enter is ignored
//     entirely (`isComposing`), so Japanese/Chinese/Korean input can't send.
//   - `sending` locks the whole surface: Enter is a no-op and both buttons
//     disable, so a second keystroke or click cannot launch a duplicate. The
//     page holds a synchronous ref guard as well, and every mutation carries an
//     idempotency id (the server-side backstop).
//   - `disabled` is the structured-question path: when the daemon is waiting on
//     a QuestionForm answer, that form IS the input and this is inert.
//
// HEIGHT STABILITY. The strip is a fixed-height, single-line, never-wrapping row
// and always renders every field (an unknown value renders as "—"), because the
// transcript's follow behaviour keys off viewport height: a strip that grew a
// line when the model name arrived would resize the scroller mid-stream. The
// textarea grows only in response to typing — a deliberate, user-driven change —
// and stops at MAX_TEXTAREA_PX.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { CornerDownLeft, Send, Clock, ZapOff } from 'lucide-react';
import { Button } from './Primitives';
import { cn, type Tone } from '../lib/utils';
import { useKeyboardOpen } from '../hooks/useAppViewport';

/** Facts the strip states. Every one is optional — the strip's height does not
 *  depend on any of them being known. */
export interface ComposerContext {
  model?: string;
  turn?: number;
  contextPercent?: number;
  status?: string;
  statusTone?: Tone;
  liveStatus?: 'connecting' | 'open' | 'closed';
}

interface Props {
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  onInterruptAndSend?(): void;
  disabled?: boolean;
  busy?: boolean;
  sending?: boolean;
  placeholder?: string;
  context?: ComposerContext;
  /** Phone chrome. Two rows of the four disappear and NOTHING about the safety
   *  semantics moves:
   *
   *    - the context strip stops being a row of its own and becomes a socket dot
   *      plus `ctx N%` in the action row's left slot. Model and turn are one tap
   *      away in the session details drawer, and neither is a fact you steer by
   *      while typing.
   *    - the keyboard hint stops being VISIBLE. "Shift+Enter newline" is not a
   *      thing a phone keyboard can do, so on touch it was a line of type that
   *      cost 20px to say nothing. It is moved to `sr-only`, NOT removed: the
   *      `aria-live` status words ("sending…", the send/queue change) are inside
   *      it, and dropping them would regress a11y S-4.
   *
   *  Enter/Shift+Enter/IME handling, the send lock, the disabled path and the
   *  44px/16px floors are untouched — they are not chrome. */
  compact?: boolean;
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

export function Composer({
  draft,
  onDraftChange,
  onSubmit,
  onInterruptAndSend,
  disabled,
  busy,
  sending,
  placeholder,
  context,
  compact,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const keyboardOpen = useKeyboardOpen();
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
    if (ref.current && document.activeElement === document.body && !disabled && !sending) {
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

  const canSubmit = !disabled && !sending && draft.trim().length > 0;
  const showInterrupt = Boolean(busy && !disabled && onInterruptAndSend);

  return (
    <div
      data-density-region="composer"
      className={cn(
        'kt-composer transition-colors motion-reduce:transition-none',
        compact && 'kt-composer--compact',
        disabled && 'opacity-60',
      )}
    >
      {context && !compact && <ContextStrip context={context} />}

      {/* The textarea is borderless and transparent: the WRAPPER is the input as
          far as the eye (and the focus ring) is concerned. */}
      <textarea
        ref={ref}
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
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            // Enter ALWAYS takes the safe path (send when idle, queue when
            // busy); interrupting is an explicit click, never an accidental
            // keystroke. canSubmit is false while a send is in flight, so a
            // second Enter cannot double-fire.
            if (canSubmit) onSubmit();
          }
        }}
      />

      {/* Action cluster, inside the box. Wraps to its own line under ~380px
          instead of pushing the send button off the edge. */}
      <div className="kt-composer__actions flex min-h-control flex-wrap items-center gap-x-sm gap-y-xs">
        {/* Deliberately NOT `.kt-chrome`: that class rests at 78% opacity, which
            is right for transcript metadata and wrong for the line that tells
            you what Enter will do and whether your message is in flight.

            The line is NOT itself a live region (a11y report S-4): when it was,
            the static "· Shift+Enter newline" hint was re-announced on every
            busy/sending transition. Only the STATUS words below sit in the
            live region, so a screen reader hears "sending…" or the send/queue
            change without the keyboard hint being read back every time. */}
        {compact ? (
          <span className="mr-auto inline-flex min-w-0 items-center gap-xs truncate text-meta text-muted">
            {/* SPOKEN, NEVER SHOWN. `sr-only` and not `hidden`: display:none
                would take the live region straight out of the accessibility
                tree and a screen-reader reader would stop hearing "sending…"
                and the send↔queue change entirely. */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {sending ? 'sending…' : busy ? 'Enter queues for the next turn' : 'Enter sends'}
            </span>
            {context && <CompactContext context={context} sending={sending} dense={showInterrupt} />}
          </span>
        ) : (
          <span className="mr-auto inline-flex min-w-0 items-center gap-xs truncate text-meta text-muted">
            {sending ? (
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <CornerDownLeft size={11} aria-hidden="true" />
            )}
            <span className="truncate">
              {/* Persistent, atomic region: only these status words announce on a
                  send/queue/busy transition. */}
              <span aria-live="polite" aria-atomic="true">
                {sending ? 'sending…' : busy ? 'Enter queues for the next turn' : 'Enter sends'}
              </span>
              {/* Static hint — outside the live region so it is never re-announced. */}
              {!sending && ' · Shift+Enter newline'}
            </span>
          </span>
        )}

        {showInterrupt && (
          <Button
            variant="danger"
            size="sm"
            disabled={!canSubmit}
            aria-label="Interrupt the current turn and send this message now"
            title="Stop the current turn safely, then deliver this message now"
            onClick={() => onInterruptAndSend?.()}
          >
            <ZapOff size={12} aria-hidden="true" />
            <span>Interrupt &amp; send</span>
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          aria-label={busy ? 'Queue this message for the next turn' : 'Send this message'}
          title={busy ? 'Deliver at the next turn boundary (safe)' : 'Send now'}
          onClick={() => onSubmit()}
        >
          {busy ? <Clock size={12} aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
          <span>{busy ? 'Queue' : 'Send'}</span>
        </Button>
      </div>
    </div>
  );
}

/** Fixed-height single line. Never wraps, never changes height — see the height
 *  note at the top of this file. */
function ContextStrip({ context }: { context: ComposerContext }) {
  const { model, turn, contextPercent, status, statusTone, liveStatus } = context;
  const ctxTone =
    contextPercent == null ? 'text-faint' : contextPercent >= 90 ? 'text-err' : contextPercent >= 75 ? 'text-warn' : '';
  const socketTone = liveStatus === 'open' ? 'bg-ok' : liveStatus === 'connecting' ? 'bg-warn' : 'bg-err';

  return (
    <div
      data-density-region="composer-context"
      className="mono flex h-control-sm w-full items-center gap-x-sm overflow-hidden whitespace-nowrap border-b border-border-soft text-chrome text-muted"
    >
      <Field className="min-w-0 flex-1 truncate text-fg-soft" title={model ? `model: ${model}` : 'model unknown'}>
        {model || '—'}
      </Field>
      <Sep />
      <Field title="turn number">turn {turn ?? '—'}</Field>
      <Sep />
      <Field className={ctxTone} title="context window used">
        ctx {contextPercent == null ? '—' : `${contextPercent}%`}
      </Field>
      <Sep />
      <Field
        className={cn('min-w-0 max-w-[34%] truncate', statusTone ? TONE_TEXT[statusTone] : '')}
        title={`session status: ${status ?? 'unknown'}`}
      >
        {status ?? '—'}
      </Field>
      {liveStatus && (
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-xs text-faint"
          title={`live event stream ${liveStatus}`}
        >
          <span className={cn('kt-dot', socketTone)} aria-hidden="true" />
          <span className="hidden sm:inline">{liveStatus}</span>
        </span>
      )}
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
    <span className={cn('shrink-0', className)} title={title}>
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
