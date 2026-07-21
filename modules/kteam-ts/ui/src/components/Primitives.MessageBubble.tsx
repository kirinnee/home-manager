// One chat bubble — markdown body + thinking + (paired or standalone) tool
// cards. The pairing is done by `pairRecordsToBubbles`; this component is
// purely presentational. It also handles the "turn prompt" first-user card
// and the "long user message" collapse, plus the thin turn divider.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ReactNode } from 'react';
import { ThinkingBlock } from './Primitives.ThinkingBlock';
import { ToolCard } from './ToolCard';
import { LongUserCard, TurnPromptCard, isTurnProtocolWall } from './TurnPromptCard';
import type { ChatRecord } from '../types';
import type { Bubble } from '../lib/pairing';
import { cn, fmtClock, fmtRelative } from '../lib/utils';

interface Props {
  bubble: Bubble;
  density?: 'comfortable' | 'compact';
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

const LONG_USER_LINE_THRESHOLD = 15;

export function MessageBubble({ bubble, density = 'comfortable' }: Props) {
  const primary = bubble.primary;

  // The "thin labeled divider" case for turn.started/completed/aborted.
  if (primary.type === 'turn.started' || primary.type === 'turn.completed' || primary.type === 'turn.aborted') {
    return (
      <div className="my-4 flex items-center gap-2 text-[11px] text-muted">
        <span className="h-px flex-1 bg-border" />
        <span className="uppercase tracking-wider font-semibold">
          {primary.type.replace('turn.', '')}
          {primary.timestamp && (
            <>
              {' · '}
              <span className="mono normal-case tracking-normal">{fmtClock(primary.timestamp)}</span>
            </>
          )}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // Unknown / system records → one-line muted row.
  if (
    primary.type !== 'chat.user' &&
    primary.type !== 'chat.assistant.text' &&
    primary.type !== 'tool.use' &&
    primary.type !== 'tool.result' &&
    primary.type !== 'chat.assistant.thinking' &&
    primary.type !== 'chat.assistant.reasoning'
  ) {
    const label = primary.type === 'unknown' ? 'system' : primary.type;
    return (
      <div className="my-1 px-2 text-[11.5px] text-muted truncate" title={JSON.stringify(primary.data)}>
        <span className="mono">{label}</span>
      </div>
    );
  }

  const text = extractText(primary);

  // Turn prompt / long user message collapse: for chat.user only.
  if (primary.type === 'chat.user' && text) {
    const lines = text.split('\n');
    if (isTurnProtocolWall(text)) {
      return (
        <div className="flex justify-end">
          <div className="max-w-[min(720px,85%)]">
            <TurnPromptCard text={text} />
          </div>
        </div>
      );
    }
    if (lines.length > LONG_USER_LINE_THRESHOLD) {
      return (
        <div className="flex justify-end">
          <div className="max-w-[min(720px,85%)]">
            <LongUserCard text={text} />
          </div>
        </div>
      );
    }
  }

  const isUser = bubble.isUser;
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[min(720px,85%)] rounded-lg border px-3 py-2 shadow-sm',
          isUser ? 'bg-accent-soft border-accent-border text-fg' : 'bg-surface border-border text-fg',
        )}
      >
        <HeaderLine primary={primary} />
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
        {primary.type === 'tool.use' && bubble.pairedResult && (
          <ToolCard
            use={primary.data as ToolUseData}
            result={bubble.pairedResult.data as ToolResultData}
            compact={density === 'compact'}
          />
        )}
        {primary.type === 'tool.use' && !bubble.pairedResult && (
          <ToolCard use={primary.data as ToolUseData} compact={density === 'compact'} />
        )}
        {bubble.attachments.length > 0 && (
          <div>
            {bubble.attachments.map((rec, i) => {
              if (rec.type === 'chat.assistant.thinking' || rec.type === 'chat.assistant.reasoning') {
                const d = rec.data as { thinking?: string; reasoning?: string };
                const t = rec.type === 'chat.assistant.thinking' ? d.thinking : d.reasoning;
                return <ThinkingBlock key={i} text={t ?? ''} />;
              }
              if (rec.type === 'tool.use') {
                return <ToolCard key={i} use={rec.data as ToolUseData} compact={density === 'compact'} />;
              }
              if (rec.type === 'tool.result') {
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
                // Inside an assistant turn we already drew the divider at the
                // bubble level; ignore the duplicate record.
                return null;
              }
              return null;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderLine({ primary }: { primary: ChatRecord }) {
  const ts = primary.timestamp;
  const absolute = ts ? fmtClock(ts) : '';
  const relative = ts ? fmtRelative(ts) : '';
  return (
    <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
      <span className="font-semibold uppercase tracking-wider opacity-70">{primary.source ?? 'system'}</span>
      {ts && (
        <span className="mono" title={relative}>
          {absolute}
        </span>
      )}
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
