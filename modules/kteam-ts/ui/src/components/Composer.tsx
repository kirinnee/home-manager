// Chat composer — multiline input, Enter-to-send, Shift+Enter newline.
// Disables itself when the session is awaiting a structured question (the
// question form is the input then). Caller surfaces a "queued" notice when
// the session is busy; we show that ourselves via a prop from the page.

import { useEffect, useRef } from 'react';
import { Button, Textarea } from './Primitives';

interface Props {
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
}

export function Composer({ draft, onDraftChange, onSubmit, disabled, busy, placeholder }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Keep focus on the composer across re-renders (the user types → state
  // updates → React re-renders → focus would otherwise jump to <body>).
  useEffect(() => {
    if (ref.current && document.activeElement === document.body) {
      ref.current.focus();
    }
  });

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
            if (!disabled && draft.trim()) onSubmit();
          }
        }}
      />
      {busy && !disabled && (
        <div className="rounded border border-warn-border bg-warn-bg px-2 py-1 text-[12px] text-warn">
          Session is busy — message will be queued for the next turn boundary.
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="primary" size="sm" disabled={disabled || !draft.trim()} onClick={() => onSubmit()}>
          Send
        </Button>
      </div>
    </div>
  );
}
