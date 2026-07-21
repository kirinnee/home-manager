// Turn prompt card — collapses the AGENTS.md protocol wall on the first
// user message of each turn into a single muted card. The first meaningful
// line after the protocol envelope becomes the card preview.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { cn } from '../lib/utils';

interface Props {
  text: string;
}

const PROTOCOL_HEADER = /#\s*(AGENTS\.md instructions|SYSTEM\s*PROMPT|INSTRUCTIONS)/i;
const ENV_HEADER = /<environment_context>|##\s*environment/i;
const TASK_START = /^(Read the file\s+\/|Continue working|Do not wait|Now\b)/i;

export function isTurnProtocolWall(text: string): boolean {
  return PROTOCOL_HEADER.test(text) && text.length > 2000;
}

export function TurnPromptCard({ text }: Props) {
  const [open, setOpen] = useState(false);

  // Pick a useful preview: the first non-empty line that doesn't look like
  // the protocol envelope or env block.
  const lines = text.split('\n');
  let preview = '';
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (PROTOCOL_HEADER.test(t)) continue;
    if (ENV_HEADER.test(t)) continue;
    if (t.startsWith('<') || t.startsWith('#')) continue;
    if (t.startsWith('-')) continue; // bullet lists from AGENTS.md
    preview = t;
    break;
  }
  if (!preview || preview.length > 200) preview = TASK_START.exec(text)?.[0] ?? `${text.length} chars`;
  if (preview.length > 200) preview = preview.slice(0, 200) + '…';

  const lineCount = lines.length;
  const isCollapsible = lineCount > 8;

  return (
    <div className="my-1.5 rounded-md border border-accent-border bg-accent-soft overflow-hidden">
      <button
        type="button"
        onClick={() => isCollapsible && setOpen(v => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          isCollapsible ? 'hover:bg-surface cursor-pointer' : 'cursor-default',
        )}
      >
        {isCollapsible ? (
          open ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )
        ) : (
          <Terminal size={12} className="text-muted" />
        )}
        <span className="text-[10.5px] uppercase tracking-wider text-accent font-semibold">Turn prompt</span>
        <span className="text-[12px] mono text-fg-soft truncate" title={preview}>
          {preview}
        </span>
        <span className="ml-auto text-[11px] text-muted">{lineCount} lines</span>
      </button>
      {open && isCollapsible && (
        <pre className="m-0 px-3 py-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-[420px] overflow-auto border-t border-accent-border">
          {text}
        </pre>
      )}
    </div>
  );
}

// Generic "long user message" collapse — used when the message doesn't fit
// the turn-prompt pattern but is still > ~15 lines.
export function LongUserCard({ text }: Props) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const preview = lines.find(l => l.trim().length > 0)?.trim() ?? '(empty)';
  return (
    <div className="my-1.5 rounded-md border border-border-soft bg-surface-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-[10.5px] uppercase tracking-wider text-muted font-semibold">long user message</span>
        <span className="text-[12px] mono text-fg-soft truncate" title={preview}>
          {preview}
        </span>
        <span className="ml-auto text-[11px] text-muted">{lines.length} lines</span>
      </button>
      {open && (
        <pre className="m-0 px-3 py-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-[420px] overflow-auto border-t border-border-soft">
          {text}
        </pre>
      )}
    </div>
  );
}
