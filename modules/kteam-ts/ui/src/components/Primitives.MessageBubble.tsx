// One chat bubble — markdown body + optional collapsible thinking +
// (paired or standalone) tool call cards. The pairing is done by
// `pairRecordsToBubbles` (see pairing.ts); this component is purely
// presentational. The first record drives the markdown body; the rest
// render in order as attachments.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ReactNode } from 'react';
// Highlight.js uses our own themed CSS (see src/highlight.css) — no CDN import.
import { ThinkingBlock } from './Primitives.ThinkingBlock';
import { ToolCallCard } from './Primitives.ToolCallCard';
import type { ChatRecord } from '../types';
import type { Bubble } from '../lib/pairing';
import { cn, fmtClock } from '../lib/utils';

interface Props {
  bubble: Bubble;
}

type ToolUseData = {
  toolUseId?: string;
  name?: string;
  input?: unknown;
  id?: string;
};
type ToolResultData = {
  toolUseId?: string;
  content?: unknown;
  text?: string;
  isError?: boolean;
  [k: string]: unknown;
};

export function MessageBubble({ bubble }: Props) {
  const primary = bubble.primary;
  const text = extractText(primary);
  const isUser = bubble.isUser;

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[min(720px,85%)] rounded-lg border px-3 py-2 shadow-sm',
          isUser ? 'bg-accent-soft border-accent-border text-fg' : 'bg-surface border-border text-fg',
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[10.5px] text-muted">
          <span className="font-semibold uppercase tracking-wider">{primary.source ?? 'system'}</span>
          {primary.timestamp && <span className="mono">{fmtClock(primary.timestamp)}</span>}
        </div>
        {text && (
          <div className="prose-sm text-[13.5px] leading-relaxed break-words">
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  a: ({ node: _node, ...rest }) => (
                    <a {...rest} target="_blank" rel="noreferrer" className="underline hover:no-underline" />
                  ),
                  code(props) {
                    const { className, children, ...rest } = props as {
                      className?: string;
                      children?: ReactNode;
                    };
                    const isBlock = /language-/.test(className ?? '');
                    if (isBlock) {
                      return (
                        <code className={className} {...rest}>
                          {children}
                        </code>
                      );
                    }
                    return (
                      <code
                        className="px-1 py-0.5 rounded bg-code-bg border border-code-border text-[12.5px] font-mono"
                        {...rest}
                      >
                        {children}
                      </code>
                    );
                  },
                  pre(props) {
                    return (
                      <pre
                        className="rounded-md border border-border bg-code-bg p-3 my-2 text-[12.5px] overflow-auto font-mono"
                        {...props}
                      />
                    );
                  },
                }}
              >
                {text}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {/* Render a paired tool.use + tool.result as ONE ToolCallCard. */}
        {primary.type === 'tool.use' && bubble.pairedResult && (
          <ToolCallCard use={primary.data as ToolUseData} result={bubble.pairedResult.data as ToolResultData} />
        )}
        {primary.type === 'tool.use' && !bubble.pairedResult && <ToolCallCard use={primary.data as ToolUseData} />}
        {/* Attachments under the markdown body. */}
        {bubble.attachments.length > 0 && (
          <div>
            {bubble.attachments.map((rec, i) => {
              if (rec.type === 'chat.assistant.thinking' || rec.type === 'chat.assistant.reasoning') {
                const d = rec.data as { thinking?: string; reasoning?: string };
                const t = rec.type === 'chat.assistant.thinking' ? d.thinking : d.reasoning;
                return <ThinkingBlock key={i} text={t ?? ''} />;
              }
              if (rec.type === 'tool.use') {
                // Inside the same bubble as the assistant text, an unpaired
                // tool.use still renders as a card (no result yet, OR the
                // result lives in the next bubble if the harness interleaved
                // text in between).
                return <ToolCallCard key={i} use={rec.data as ToolUseData} />;
              }
              if (rec.type === 'tool.result') {
                // Bare tool.result (no pair found) — render standalone.
                const d = rec.data as ToolResultData | undefined;
                const txt = typeof d?.text === 'string' ? d.text : 'tool result';
                return (
                  <div
                    key={i}
                    className="my-1.5 rounded border border-border-soft bg-code-bg px-2 py-1 mono text-[12px] text-fg-soft whitespace-pre-wrap break-words"
                  >
                    {txt}
                  </div>
                );
              }
              if (rec.type === 'interaction.answer' || rec.type === 'interaction.question') {
                return null;
              }
              if (rec.type === 'turn.started' || rec.type === 'turn.completed' || rec.type === 'turn.aborted') {
                return (
                  <div key={i} className="my-1 text-[10.5px] uppercase tracking-wider text-muted">
                    {rec.type.replace('turn.', '')}
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function extractText(rec: ChatRecord): string {
  switch (rec.type) {
    case 'chat.user':
    case 'chat.assistant.text':
      return (rec.data as { text?: string }).text ?? '';
    default:
      return '';
  }
}
