import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MARKDOWN_COMPOSER_EXPLANATION, MarkdownComposerSettings } from './MarkdownComposerSettings';

const html = renderToStaticMarkup(<MarkdownComposerSettings />);

describe('MarkdownComposerSettings', () => {
  test('is an honest default-off switch with a 44px target', () => {
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/u);
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('Highlight Markdown syntax');
  });

  test('says syntax highlighting, not WYSIWYG', () => {
    expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('Syntax highlighting only');
    expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('markers stay visible');
    expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('**bold** keeps its asterisks');
    expect(html).toContain('real-device mobile Safari pass');
  });

  test('does not introduce a second editing surface or summon focus', () => {
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('contenteditable');
    expect(html.toLowerCase()).not.toContain('autofocus');
  });
});
