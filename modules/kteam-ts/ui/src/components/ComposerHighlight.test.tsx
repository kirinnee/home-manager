import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer, ComposerTextarea } from './Composer';
import {
  COMPOSER_TEXT_METRICS,
  ComposerHighlight,
  MARKDOWN_TOKEN_CLASS,
  syncComposerHighlightViewport,
} from './ComposerHighlight';

const nullOverlayRef = { current: null };

describe('ComposerHighlight', () => {
  test('the composer keeps one native textarea beside an always-mounted overlay', () => {
    const html = renderToStaticMarkup(<Composer draft="plain" onDraftChange={() => {}} onSubmit={() => {}} compact />);
    expect(html.match(/<textarea\b/gu)?.length).toBe(1);
    expect(html.match(/data-composer-highlight=/gu)?.length).toBe(1);
    expect(html.indexOf('data-composer-highlight=')).toBeLessThan(html.indexOf('<textarea'));
    const overlayTag = html.match(/<div[^>]*data-composer-highlight=""[^>]*>/u)?.[0] ?? '';
    expect(overlayTag).toContain('hidden=""');
  });

  test('is paint-only, inaccessible, and keeps Markdown source markers visible', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlight text={'# Heading\n**bold** and `code`'} overlayRef={nullOverlayRef} />,
    );
    expect(html).toContain('data-composer-highlight=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('select-none');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('contenteditable');
    expect(html).toContain('**');
    expect(html).toContain('data-md-token="heading"');
    expect(html).toContain('data-md-token="bold"');
    expect(html).toContain('data-md-token="inlineCode"');
  });

  test('renders untrusted draft text as escaped React children, never HTML', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlight text={'<img src=x onerror="boom"> **safe**'} overlayRef={nullOverlayRef} />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;boom&quot;&gt;');
    expect(html).toContain('data-md-token="bold"');
  });

  test('stays mounted but hidden while disabled, preserving the textarea sibling', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlight text="**not painted**" overlayRef={nullOverlayRef} enabled={false} />,
    );
    expect(html).toContain('data-composer-highlight=""');
    expect(html).toContain('hidden=""');
    expect(html).not.toContain('data-md-token');
  });

  test('prioritises terminated and unterminated fenced code while preserving the typed source', () => {
    const source = '```ts\nconst done = true\n```\n```py\nstill typing';
    const html = renderToStaticMarkup(<ComposerHighlight text={source} overlayRef={nullOverlayRef} />);
    expect(html.match(/data-md-token="fence"/gu)?.length).toBe(3);
    expect(html.match(/data-md-token="codeBlock"/gu)?.length).toBe(2);
    expect(html).toContain('```ts');
    expect(html).toContain('```py');
    expect(html).toContain('still typing');
  });

  test('token paint never changes typography metrics', () => {
    for (const classes of Object.values(MARKDOWN_TOKEN_CLASS)) {
      expect(classes).not.toMatch(/font-|italic|leading-|tracking-|\[font|\[line-height|\[letter-spacing/u);
    }
  });

  test('the overlay carries the complete explicit box/text metric contract', () => {
    const overlay = renderToStaticMarkup(<ComposerHighlight text="text" overlayRef={nullOverlayRef} />);
    const textarea = ComposerTextarea({
      inputRef: { current: null },
      draft: 'text',
      onDraftChange: () => {},
      onSubmit: () => {},
      canSubmit: true,
      highlighted: true,
    });
    const textareaClass = (textarea.props as { className: string }).className;
    for (const metric of COMPOSER_TEXT_METRICS.split(' ')) {
      expect(overlay).toContain(metric);
      expect(textareaClass).toContain(metric);
    }
    expect(textareaClass).toContain('text-transparent');
    expect(textareaClass).toContain('[caret-color:var(--fg)]');
  });

  test('a trailing newline gets a zero-width mirror row', () => {
    const withNewline = renderToStaticMarkup(<ComposerHighlight text={'a\n'} overlayRef={nullOverlayRef} />);
    const without = renderToStaticMarkup(<ComposerHighlight text="a" overlayRef={nullOverlayRef} />);
    expect(withNewline).toContain('data-composer-trailing-line="true"');
    expect(without).not.toContain('data-composer-trailing-line');
  });
});

describe('highlight viewport synchronization', () => {
  test('copies vertical and horizontal scroll plus overflow geometry', () => {
    const input = { scrollTop: 71, scrollLeft: 13, style: { overflowX: 'auto', overflowY: 'auto' } };
    const overlay = { scrollTop: 0, scrollLeft: 0, style: { overflowX: '', overflowY: '' } };
    syncComposerHighlightViewport(input as never, overlay as never);
    expect(overlay).toEqual({
      scrollTop: 71,
      scrollLeft: 13,
      style: { overflowX: 'auto', overflowY: 'auto' },
    });
  });

  test('defaults horizontal overflow to auto when the native inline style is empty', () => {
    const input = { scrollTop: 0, scrollLeft: 8, style: { overflowX: '', overflowY: 'hidden' } };
    const overlay = { scrollTop: 0, scrollLeft: 0, style: { overflowX: '', overflowY: '' } };
    syncComposerHighlightViewport(input as never, overlay as never);
    expect(overlay.style.overflowX).toBe('auto');
    expect(overlay.scrollLeft).toBe(8);
  });

  test('the native input syncs on input, change, and scroll without adding composition handlers', () => {
    const synced: HTMLTextAreaElement[] = [];
    const drafts: string[] = [];
    const textarea = ComposerTextarea({
      inputRef: { current: null },
      draft: 'before',
      onDraftChange: value => drafts.push(value),
      onSubmit: () => {},
      canSubmit: true,
      highlighted: true,
      syncHighlight: input => synced.push(input),
    });
    const props = textarea.props as {
      onInput(event: { currentTarget: HTMLTextAreaElement }): void;
      onChange(event: { target: HTMLTextAreaElement }): void;
      onScroll(event: { currentTarget: HTMLTextAreaElement }): void;
      onCompositionStart?: unknown;
      onCompositionEnd?: unknown;
    };
    const input = { value: 'after' } as HTMLTextAreaElement;
    props.onInput({ currentTarget: input });
    props.onChange({ target: input });
    props.onScroll({ currentTarget: input });
    expect(synced).toEqual([input, input, input]);
    expect(drafts).toEqual(['after']);
    expect(props.onCompositionStart).toBeUndefined();
    expect(props.onCompositionEnd).toBeUndefined();
  });
});
