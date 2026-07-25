// Chat composer — multiline input, Enter-to-send, Shift+Enter newline.
// Disables itself when the session is awaiting a structured question (the
// question form is the input then). On a BUSY session the send controls split
// into the two real choices at the point of intent: "Queue" (deliver at the
// next turn boundary — the daemon's default) and "Interrupt & send" (stop the
// current turn safely, then deliver now).
//
// The two buttons ARE the explanation — the paragraph that used to appear above
// them on every busy session taught the user their own tool at the cost of ~37px
// of transcript, and its appearing/disappearing was itself a bug: it resized the
// viewport mid-stream, which is what knocked the transcript out of follow (see
// Transcript.tsx). Button titles carry the detail for anyone who wants it.
//
// Round 3 double-send fix: the composer is LOCKED while a send is in flight
// (`sending`) — Enter is a no-op and both buttons disable — so a second
// keystroke/click can't launch a duplicate. The page also holds a synchronous
// ref guard, and every mutation carries an idempotency id (server backstop).

import { useEffect, useRef } from 'react';
import { Button, Textarea } from './Primitives';

interface Props {
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  onInterruptAndSend?(): void;
  disabled?: boolean;
  busy?: boolean;
  sending?: boolean;
  placeholder?: string;
}

export function Composer({
  draft,
  onDraftChange,
  onSubmit,
  onInterruptAndSend,
  disabled,
  busy,
  sending,
  placeholder,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Keep focus on the composer across re-renders (the user types → state
  // updates → React re-renders → focus would otherwise jump to <body>).
  useEffect(() => {
    if (ref.current && document.activeElement === document.body && !disabled && !sending) {
      ref.current.focus();
    }
  });

  const canSubmit = !disabled && !sending && draft.trim().length > 0;

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-surface p-2">
      <Textarea
        ref={ref}
        value={draft}
        onChange={e => onDraftChange(e.target.value)}
        placeholder={placeholder ?? 'Send a message to this teammate…'}
        rows={2}
        disabled={disabled || sending}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            // Enter always takes the safe path (queue); interrupting is an
            // explicit click, never an accidental keystroke. canSubmit is false
            // while a send is in flight, so a second Enter can't double-fire.
            if (canSubmit) onSubmit();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        {sending && <span className="mono mr-auto text-[11.5px] text-muted">sending…</span>}
        {busy && !disabled && onInterruptAndSend && (
          <Button
            variant="danger"
            size="sm"
            disabled={!canSubmit}
            title="Stop the current turn, then deliver this message now"
            onClick={() => onInterruptAndSend()}
          >
            Interrupt &amp; send
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          title={busy ? 'Deliver at the next turn boundary' : 'Send now'}
          onClick={() => onSubmit()}
        >
          {sending && (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
          )}
          {sending ? 'Sending' : busy ? 'Queue' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
