import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHAT_WIDTH_OPTIONS, ChatWidthControl } from './ChatWidthControl';

describe('ChatWidthControl', () => {
  test('names the two choices and tells the reader that full-bleed is the default', () => {
    expect(CHAT_WIDTH_OPTIONS.map(option => option.id)).toEqual(['full', 'readable']);

    const html = renderToStaticMarkup(<ChatWidthControl value="full" onChange={() => undefined} />);
    expect(html).toContain('aria-label="Conversation width"');
    expect(html).toContain('>Full-bleed<');
    expect(html).toContain('>Readable column<');
    expect(html).toContain('Full-bleed · default');
    expect(html).toContain('Full-bleed is already active. Choosing it again will not change the conversation.');
  });

  test('previews the selected width even when the real pane is too narrow to change', () => {
    const full = renderToStaticMarkup(<ChatWidthControl value="full" onChange={() => undefined} />);
    const readable = renderToStaticMarkup(<ChatWidthControl value="readable" onChange={() => undefined} />);

    expect(full).toContain('data-chat-width-preview="full"');
    expect(full).toContain('w-full');
    expect(readable).toContain('data-chat-width-preview="readable"');
    expect(readable).toContain('w-2/3');
    expect(readable).toContain(
      'Readable column is active. Full-bleed will use the extra width in a wider conversation.',
    );
    for (const html of [full, readable]) {
      expect(html).toContain('When the conversation pane is 768px wide or narrower, both choices look the same.');
    }
  });

  test('keeps both choices at the 44px direct-action floor', () => {
    const html = renderToStaticMarkup(<ChatWidthControl value="full" onChange={() => undefined} />);
    const radioButtons = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map(match => match[0]);

    expect(radioButtons).toHaveLength(2);
    for (const button of radioButtons) expect(button).toContain('min-h-[44px]');
  });

  test('lets full mode reach transcript content while readable mode keeps its cap', async () => {
    const css = await Bun.file(new URL('../index.css', import.meta.url).pathname).text();
    const transcript = await Bun.file(new URL('./Transcript.tsx', import.meta.url).pathname).text();

    expect(css).toContain('max-width: var(--chat-measure-content, 880px);');
    expect(css).toContain(".kt-chat-surface[data-chat-width='readable'] {");
    expect(css).toContain('max-width: var(--chat-measure-readable, 768px);');
    expect(css).toContain(".kt-chat-surface[data-chat-width='full'] .kt-content {");
    expect(css).toMatch(/\[data-chat-width='full'\] \.kt-content \{\s*max-width: none;/);
    expect(transcript.match(/className="kt-content[^"]+"/)?.[0]).not.toContain('max-w-[');
  });
});
