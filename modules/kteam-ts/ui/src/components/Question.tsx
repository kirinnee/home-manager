// Collapsible pane-snapshot drawer. Pinned to the bottom; open by default so
// the user gets immediate context but doesn't dominate the page. While OPEN,
// the page polls /snapshot every 5s. While closed, no polling happens.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { api } from '../lib/api';

export function PaneSnapshotDrawer({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false); // default collapsed — less noise
  const [text, setText] = useState<string>('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const poll = async () => {
      try {
        const t = await api.snapshot(sessionId);
        setText(t);
      } catch {
        /* keep last value */
      }
    };
    void poll();
    timer.current = window.setInterval(poll, 5000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [open, sessionId]);

  return (
    <div className="rounded-md border border-border bg-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-fg-soft hover:bg-surface-2"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Terminal size={13} />
        <span className="font-semibold">Pane snapshot</span>
        {text && <span className="ml-2 text-muted text-[11px] mono">({text.length} chars)</span>}
      </button>
      {open && (
        <pre className="m-0 max-h-[420px] overflow-auto border-t border-border-soft bg-code-bg px-3 py-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft">
          {text || '(no snapshot yet)'}
        </pre>
      )}
    </div>
  );
}
