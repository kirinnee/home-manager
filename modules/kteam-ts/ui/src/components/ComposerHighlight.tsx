// Lossless markdown colouring for the native composer textarea.
//
// The textarea remains the only input. This component paints the same text in
// an aria-hidden, pointer-inert layer behind it; it never focuses the input,
// reads or writes its selection, or participates in layout. Markdown markers
// remain visible because this is syntax highlighting, not WYSIWYG rendering.

import { useMemo, type RefObject } from 'react';
import { tokenizeMarkdown, type MdToken, type MdTokenType } from '../lib/composer-markdown';
import { findReferences } from '../lib/references';

/**
 * The metric contract shared VERBATIM by the textarea and its mirror. A colour
 * span may change paint only; typography stays inherited so bold/italic syntax
 * cannot change glyph widths and walk away from the native caret.
 */
export const COMPOSER_TEXT_METRICS = [
  // 10px is the existing global textarea inset (index.css). Keep it explicit
  // on BOTH layers; changing it would change every wrap point in the composer.
  'm-0 block w-full overflow-x-auto border-0 px-[10px] py-row-y',
  '[box-sizing:border-box]',
  '[font-family:inherit] [font-size:inherit] [font-style:inherit] [font-weight:inherit]',
  '[font-variant:inherit] [line-height:inherit] [letter-spacing:inherit]',
  '[tab-size:inherit] [text-align:inherit] [text-indent:inherit] [text-transform:inherit]',
  '[white-space:pre-wrap] [word-break:break-word] [overflow-wrap:break-word]',
].join(' ');

/** Colour only. Font weight/style/size/family are deliberately absent. */
export const MARKDOWN_TOKEN_CLASS: Readonly<Record<MdTokenType, string>> = {
  text: 'text-fg',
  fence: '[color:var(--syn-meta)]',
  codeBlock: '[color:var(--syn-string)]',
  inlineCode: '[color:var(--syn-string)] [background-color:var(--code-bg)]',
  bold: '[color:var(--syn-keyword)]',
  italic: '[color:var(--syn-type)]',
  boldItalic: '[color:var(--syn-meta)]',
  mark: '[color:var(--syn-comment)]',
  heading: '[color:var(--syn-keyword)]',
  linkText: '[color:var(--syn-string)]',
  linkUrl: '[color:var(--syn-comment)]',
  listMarker: '[color:var(--syn-number)]',
  quoteMarker: '[color:var(--syn-comment)]',
  reference: '[color:var(--accent)]',
};

const REFERENCE_ELIGIBLE = new Set<MdTokenType>(['text', 'bold', 'italic', 'boldItalic', 'heading']);

/** Split eligible Markdown paint tokens with the same parser used by preview
 * rendering. The concatenated bytes remain identical, preserving caret metrics. */
export function highlightReferenceTokens(tokens: readonly MdToken[]): MdToken[] {
  return tokens.flatMap(token => {
    if (!REFERENCE_ELIGIBLE.has(token.type)) return [token];
    const matches = findReferences(token.text);
    if (matches.length === 0) return [token];
    const output: MdToken[] = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) output.push({ type: token.type, text: token.text.slice(cursor, match.start) });
      output.push({ type: 'reference', text: match.raw });
      cursor = match.end;
    }
    if (cursor < token.text.length) output.push({ type: token.type, text: token.text.slice(cursor) });
    return output;
  });
}

type ScrollPort = Pick<HTMLElement, 'scrollTop' | 'scrollLeft'> & {
  style: Pick<CSSStyleDeclaration, 'overflowX' | 'overflowY'>;
};

/**
 * Mirror BOTH axes and the textarea's vertical-overflow mode. Matching the
 * latter matters on browsers with non-overlay scrollbars: otherwise the input
 * wraps against a narrower content box than the highlight layer once capped.
 */
export function syncComposerHighlightViewport(input: ScrollPort, overlay: ScrollPort | null): void {
  if (!overlay) return;
  overlay.style.overflowX = input.style.overflowX || 'auto';
  overlay.style.overflowY = input.style.overflowY || 'hidden';
  overlay.scrollTop = input.scrollTop;
  overlay.scrollLeft = input.scrollLeft;
}

export function ComposerHighlight({
  text,
  overlayRef,
  enabled = true,
}: {
  text: string;
  overlayRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}) {
  // The element itself is ALWAYS mounted so enabling the setting cannot shift
  // the sibling textarea's reconciliation slot and remount the real input.
  const paintedText = enabled ? text : '';
  const tokens = useMemo(() => highlightReferenceTokens(tokenizeMarkdown(paintedText)), [paintedText]);
  let offset = 0;

  return (
    <div
      ref={overlayRef}
      data-composer-highlight=""
      aria-hidden="true"
      hidden={!enabled}
      className={`${COMPOSER_TEXT_METRICS} pointer-events-none absolute inset-0 select-none overflow-y-hidden text-fg`}
    >
      {tokens.map(token => {
        const start = offset;
        offset += token.text.length;
        return (
          <span key={`${start}:${token.type}`} data-md-token={token.type} className={MARKDOWN_TOKEN_CLASS[token.type]}>
            {token.text}
          </span>
        );
      })}
      {/* A textarea gives a trailing newline its own caret row. Chromium's
          pre-wrap block needs a zero-width occupant to expose that same row;
          it paints nothing and exists only in this aria-hidden mirror. */}
      {paintedText.endsWith('\n') && <span data-composer-trailing-line>{'\u200b'}</span>}
    </div>
  );
}
