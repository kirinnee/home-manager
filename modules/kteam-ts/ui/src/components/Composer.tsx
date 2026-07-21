// Chat composer — multiline input, Enter-to-send, Shift+Enter newline.
// Disables itself when the session is awaiting a structured question (the
// question form is the input then). On a BUSY session the send controls split
// into the two real choices at the point of intent: "Queue" (deliver at the
// next turn boundary — the daemon's default) and "Interrupt & send" (stop the
// current turn safely, then deliver now).

import { useEffect, useRef } from 'react';
import { Button, Textarea } from './Primitives';

interface Props {
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  onInterruptAndSend?(): void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
}

export function Composer({ draft, onDraftChange, onSubmit, onInterruptAndSend, disabled, busy, placeholder }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Keep focus on the composer across re-renders (the user types → state
  // updates → React re-renders → focus would otherwise jump to <body>).
  useEffect(() => {
    if (ref.current && document.activeElement === document.body) {
      ref.current.focus();
    }
  });

  const canSubmit = !disabled && draft.trim().length > 0;

  return (
    <div className="rounded-md border border-border bg-surface p-3 space-y-2">
      <div className="text-[10.5px] uppercase tracking-wider text-muted font-semibold">Send message</div>
      <Textarea
        ref={ref}
        value={draft}
        onChange={e => onDraftChange(e.target.value)}
        placeholder={placeholder ?? 'Send a message to this teammate…'}
        rows={3}
        disabled={disabled}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            // Enter always takes the safe path (queue); interrupting is an
            // explicit click, never an accidental keystroke.
            if (canSubmit) onSubmit();
          }
        }}
      />
      {busy && !disabled && (
        <div className="rounded border border-warn-border bg-warn-bg px-2 py-1 text-[12px] text-warn">
          Session is busy — <strong>Queue</strong> delivers at the next turn boundary;{' '}
          <strong>Interrupt &amp; send</strong> stops the current turn and delivers now.
        </div>
      )}
      <div className="flex justify-end gap-2">
        {busy && !disabled && onInterruptAndSend && (
          <Button variant="danger" size="sm" disabled={!canSubmit} onClick={() => onInterruptAndSend()}>
            Interrupt &amp; send
          </Button>
        )}
        <Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => onSubmit()}>
          {busy ? 'Queue' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
