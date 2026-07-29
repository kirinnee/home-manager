import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIDE_PANE_SEARCH_DEBOUNCE_MS, SidePaneSearch } from './SidePaneSearch';

describe('SidePaneSearch', () => {
  test('uses the shared compact, debounced controlled search treatment', () => {
    const html = renderToStaticMarkup(
      <SidePaneSearch
        value="release"
        onChange={() => undefined}
        ariaLabel="Search skills"
        placeholder="Search skills"
      />,
    );

    expect(html).toContain('data-side-pane-search=""');
    expect(html).toContain(`data-debounce-ms="${SIDE_PANE_SEARCH_DEBOUNCE_MS}"`);
    expect(html).toContain('aria-label="Search skills"');
    expect(html).toContain('placeholder="Search skills"');
    expect(html).toContain('aria-label="Clear search"');
    expect(html).toContain('min-w-0');
    expect(html).not.toContain('overflow-x');
  });

  test('omits the clear action for an empty controlled value', () => {
    const html = renderToStaticMarkup(
      <SidePaneSearch value="" onChange={() => undefined} ariaLabel="Search skills" placeholder="Search skills" />,
    );

    expect(html).not.toContain('aria-label="Clear search"');
  });

  test('debounces typing but flushes blur and clear actions immediately', async () => {
    // This is deliberately a source-level contract: the UI test environment is
    // server-render only, while effects and focus events need a browser DOM.
    const source = await Bun.file(new URL('./SidePaneSearch.tsx', import.meta.url)).text();

    expect(source).toContain('setTimeout(() => submit(draft), debounceMs)');
    expect(source).toContain('return () => clearTimeout(timer)');
    expect(source).toContain('flush();\n          onBlur?.(event);');
    expect(source).toContain("setDraft('');\n            submit('');");
  });
});
