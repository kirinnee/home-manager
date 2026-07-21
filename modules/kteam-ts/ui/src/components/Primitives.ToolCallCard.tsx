// Render one tool call (a tool.use + optional paired tool.result) as a compact,
// collapsible card. Falls back gracefully when no matching result was observed.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { ChatRecordToolUse, ChatRecordToolResult } from '../types';

export function ToolCallCard({
  use,
  result,
}: {
  use: ChatRecordToolUse['data'];
  result?: ChatRecordToolResult['data'];
}) {
  const [openInput, setOpenInput] = useState(false);
  const [openResult, setOpenResult] = useState(false);
  const name = (use?.name ?? use?.id ?? 'tool') as string;
  return (
    <div className="my-1.5 rounded-md border border-border bg-surface-2 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
        <Wrench size={13} className="text-muted shrink-0" />
        <span className="font-mono text-fg">{name}</span>
        {result?.isError && (
          <span className="ml-auto rounded border border-err-border bg-err-bg px-1.5 py-0 text-[10.5px] font-semibold text-err">
            error
          </span>
        )}
        {use?.toolUseId && <span className="ml-auto mono text-[10.5px] text-muted">{use.toolUseId}</span>}
      </div>
      <div className="border-t border-border-soft">
        <button
          type="button"
          onClick={() => setOpenInput(v => !v)}
          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] text-muted hover:bg-surface"
        >
          {openInput ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          input
        </button>
        {openInput && (
          <pre className="m-0 px-2.5 pb-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-72 overflow-auto">
            {tryStringify(use?.input)}
          </pre>
        )}
      </div>
      <div className="border-t border-border-soft">
        <button
          type="button"
          onClick={() => setOpenResult(v => !v)}
          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11.5px] text-muted hover:bg-surface"
        >
          {openResult ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {result ? 'result' : 'result (no pair yet)'}
        </button>
        {openResult && (
          <pre className="m-0 px-2.5 pb-2 text-[12px] leading-relaxed mono whitespace-pre-wrap break-words text-fg-soft max-h-72 overflow-auto">
            {resultText(result)}
          </pre>
        )}
      </div>
    </div>
  );
}

function tryStringify(value: unknown): string {
  if (value == null) return '(empty)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resultText(result: ChatRecordToolResult['data'] | undefined): string {
  if (!result) return '(awaiting harness output)';
  if (typeof result.text === 'string') return result.text;
  if (Array.isArray(result.content)) {
    return result.content
      .map((part: { text?: string; type?: string }) => part?.text ?? `[${part?.type ?? 'unknown'}]`)
      .join('\n');
  }
  if (result.content != null) return tryStringify(result.content);
  return tryStringify(result);
}
