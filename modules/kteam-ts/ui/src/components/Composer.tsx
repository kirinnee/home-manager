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
}

/** ~6 lines. Past this the composer scrolls internally instead of eating the
 *  transcript — the shell is exactly 100dvh and has nowhere to give. */
const MAX_TEXTAREA_PX = 148;
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
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Keep focus on the composer across re-renders (the user types → state
  // updates → React re-renders → focus would otherwise jump to <body>).
  useEffect(() => {
    if (ref.current && document.activeElement === document.body && !disabled && !sending) {
      ref.current.focus();
    }
  });

  // Auto-grow. Measured BEFORE paint so the box never flashes at the wrong
  // height, and capped so a pasted essay cannot swallow the conversation.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(MAX_TEXTAREA_PX, Math.max(MIN_TEXTAREA_PX, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? 'auto' : 'hidden';
  }, [draft]);

  const canSubmit = !disabled && !sending && draft.trim().length > 0;
  const showInterrupt = Boolean(busy && !disabled && onInterruptAndSend);

  return (
    <div className={cn('kt-composer transition-colors motion-reduce:transition-none', disabled && 'opacity-60')}>
      {context && <ContextStrip context={context} />}

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
      <div className="flex min-h-control flex-wrap items-center gap-x-sm gap-y-xs">
        {/* Deliberately NOT `.kt-chrome`: that class rests at 78% opacity, which
            is right for transcript metadata and wrong for the line that tells
            you what Enter will do and whether your message is in flight. */}
        <span
          className="mr-auto inline-flex min-w-0 items-center gap-xs truncate text-meta text-muted"
          aria-live="polite"
        >
          {sending ? (
            <>
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
                aria-hidden="true"
              />
              sending…
            </>
          ) : (
            <>
              <CornerDownLeft size={11} aria-hidden="true" />
              <span className="truncate">
                {busy ? 'Enter queues for the next turn' : 'Enter sends'} · Shift+Enter newline
              </span>
            </>
          )}
        </span>

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
    <div className="mono flex h-control-sm w-full items-center gap-x-sm overflow-hidden whitespace-nowrap border-b border-border-soft text-chrome text-muted">
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
