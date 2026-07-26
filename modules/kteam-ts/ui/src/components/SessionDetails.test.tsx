import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BottomSheet } from './SessionDetails';

describe('shared BottomSheet contract', () => {
  test('keeps the original modal, swipe, focus and keyboard-safe geometry in one shell', () => {
    const html = renderToStaticMarkup(
      <BottomSheet id="test-sheet" open onClose={() => undefined} ariaLabel="Test sheet" closeLabel="Close test sheet">
        <p>Sheet content</p>
      </BottomSheet>,
    );

    expect(html).toContain('data-bottom-sheet="test-sheet"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Test sheet"');
    expect(html.match(/aria-label="Close test sheet"/g)?.length).toBe(2);
    expect(html).toContain('data-sheet-swipe="supported"');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('var(--app-h, 100dvh)');
  });

  test('does not leave a focusable closed sheet in the initial DOM', () => {
    expect(
      renderToStaticMarkup(
        <BottomSheet id="test-sheet" open={false} onClose={() => undefined} closeLabel="Close test sheet">
          <p>Sheet content</p>
        </BottomSheet>,
      ),
    ).toBe('');
  });
});
