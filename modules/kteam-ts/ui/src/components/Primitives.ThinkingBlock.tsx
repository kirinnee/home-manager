// Collapsible thinking/reasoning block — default collapsed (the brief).
// Renders both Claude (thinking) and Codex (reasoning) shapes identically.

import { useState } from 'react';
import { ChevronDown, ChevronRight, BrainCircuit } from 'lucide-react';

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text || !text.trim()) {
    return null; // Claude often emits empty thinking records as a heartbeat
  }
  return (
    <div className="my-1.5 rounded-md border border-border-soft bg-surface-2/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] text-muted hover:bg-surface"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <BrainCircuit size={12} className="text-muted" />
        thinking
      </button>
      {open && (
        <pre className="m-0 px-2.5 pb-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-72 overflow-auto">
          {text}
        </pre>
      )}
    </div>
  );
}
