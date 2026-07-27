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
import { remarkTableLabels } from '../lib/remark-table-labels';
import { InAppBrowserLink } from './InAppBrowser';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md min-w-0 max-w-full">
      <ReactMarkdown
        // remarkTableLabels stamps each body cell with its column header as
        // `data-label`, which the mobile stacked-card layout prints. It must run
        // after remark-gfm has produced the table nodes.
        remarkPlugins={[remarkGfm, remarkTableLabels]}
        components={{
          a: ({ node: _node, ...rest }) => <InAppBrowserLink {...rest} />,
          // Tables wrap aggressively to fit the pane and may full-bleed past the
          // prose measure (index.css `.md table` / `.md-table-scroll`). The
          // scroller is the last-resort catch for a table that still cannot
          // shrink, so a wide table scrolls INSIDE itself and never the page.
          //
          // On a phone the layout switches cells to `display:block` stacked
          // cards, which strips the implicit ARIA table semantics. The explicit
          // roles here (plus `scope="col"` on headers) preserve the
          // header-to-cell association for a screen reader across that switch;
          // on desktop they are the elements' implicit roles, so they are inert.
          table: ({ node: _node, ...rest }) => (
            <div className="md-table-scroll scroll-thin">
              <table role="table" {...rest} />
            </div>
          ),
          thead: ({ node: _node, ...rest }) => <thead role="rowgroup" {...rest} />,
          tbody: ({ node: _node, ...rest }) => <tbody role="rowgroup" {...rest} />,
          tr: ({ node: _node, ...rest }) => <tr role="row" {...rest} />,
          th: ({ node: _node, ...rest }) => <th role="columnheader" scope="col" {...rest} />,
          td: ({ node: _node, ...rest }) => <td role="cell" {...rest} />,
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
