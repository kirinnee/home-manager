// Syntax-highlighted code block for tool-result file contents. Language is
// chosen by the caller from the filename extension (never auto-detected — slow
// and wrong on logs). Falls back to escaped plain text. Highlight output is
// memoized on (code, lang) so re-renders don't re-tokenize. Themed by the
// shared .hljs rules in highlight.css.

import { memo, useMemo, useState } from 'react';
import { escapeHtml, highlightToHtml } from '../lib/highlight';
import { cn } from '../lib/utils';

const PREVIEW_LINES = 16;

export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  tone = 'default',
}: {
  code: string;
  lang?: string;
  tone?: 'default' | 'err';
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');
  const tooMany = lines.length > PREVIEW_LINES;
  const shown = expanded ? code : lines.slice(0, PREVIEW_LINES).join('\n');

  // The shared registry decides (lib/highlight.ts): a null result means "this
  // one is not highlightable" — no language, an unknown one, too big, or a
  // parser that threw — and the answer for all four is the same escaped text
  // this file always fell back to.
  const html = useMemo(() => {
    if (tone === 'err') return escapeHtml(shown);
    return highlightToHtml(shown, lang) ?? escapeHtml(shown);
  }, [shown, lang, tone]);

  return (
    <div>
      <pre
        className={cn(
          'hljs m-0 max-h-[380px] overflow-auto rounded-md border px-2.5 py-2 text-[11.75px] leading-[1.5] mono whitespace-pre-wrap break-words scroll-thin',
          tone === 'err' ? 'border-err-border !bg-err-bg text-err' : 'border-border-soft',
        )}
      >
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {tooMany && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="mt-0.5 px-1 text-[11px] text-accent hover:underline"
        >
          {expanded ? 'show less' : `show ${lines.length - PREVIEW_LINES} more lines`}
        </button>
      )}
    </div>
  );
});
