// Memoized markdown renderer for assistant prose. Heavy to parse, so it is
// wrapped in React.memo keyed on the raw text — a live append elsewhere in the
// transcript never re-parses existing assistant blocks.
//
// FENCES ARE HIGHLIGHTED BY THE SHARED REGISTRY, not by `rehype-highlight`.
// That plugin brings lowlight and its own copy of Highlight.js's common set —
// a second full parser bundle next to the one CodeBlock already loaded, for a
// set of languages this app enumerates exactly (lib/highlight.ts). A `code`
// renderer does the same job against the shared registry, so the parsers are
// downloaded once and only the ones we can actually use.
//
// Unknown or absent fence language ⇒ react-markdown's own escaped text, exactly
// as before. Nothing is auto-detected.

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fenceLanguage, highlightToHtml } from '../lib/highlight';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md min-w-0 max-w-full">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...rest }) => <a {...rest} target="_blank" rel="noreferrer" />,
          // A table's min-content width is allowed to exceed prose width. Give
          // that width one local, reachable scroller instead of making the
          // entire transcript the horizontal scroll container.
          table: ({ node: _node, ...rest }) => (
            <div className="md-table-scroll scroll-thin">
              <table {...rest} />
            </div>
          ),
          code: ({ node: _node, className, children, ...rest }) => {
            const lang = fenceLanguage(className);
            const source = lang ? String(children).replace(/\n$/, '') : '';
            const html = lang ? highlightToHtml(source, lang) : null;
            // No language (inline code, bare fence) or an unknown one: hand it
            // back to react-markdown, which escapes it. Never raw HTML.
            if (html === null) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className={`hljs language-${lang}`}
                // Safe: Highlight.js output over text it escaped itself, and the
                // branch above covers every input it refused.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
