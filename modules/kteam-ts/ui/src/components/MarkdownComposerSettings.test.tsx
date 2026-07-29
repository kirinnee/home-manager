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

  test('promises a separate preview without replacing the native editor', () => {
    expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('separate bounded preview');
    expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('markers stay visible');
    expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('proven in-app references');
    expect(html).toContain('real-device mobile Safari pass');
    expect(html).toContain('original textarea still owns input, selection, dictation, autocomplete and drafts');
  });

  test('does not introduce a second editing surface or summon focus', () => {
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('contenteditable');
    expect(html.toLowerCase()).not.toContain('autofocus');
  });
});
