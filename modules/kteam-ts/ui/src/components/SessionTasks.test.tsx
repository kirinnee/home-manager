// Session tasks surface: the honest copy per degraded state, and the loading
// shell's structure. The live list/detail behaviour needs a DOM runner and the
// daemon's session routes; both are asserted in the browser matrix.

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTasksSurface, sessionTasksEmptyCopy } from './SessionTasks';

describe('sessionTasksEmptyCopy', () => {
  test('version skew is named, not shown as an empty board', () => {
    expect(sessionTasksEmptyCopy('absent')).toContain('does not serve per-session tasks');
  });
  test('an error carries the daemon message when there is one', () => {
    expect(sessionTasksEmptyCopy('error', 'HTTP 500')).toContain('HTTP 500');
    expect(sessionTasksEmptyCopy('error', null)).toBe("Couldn't load tasks.");
  });
  test('a real empty list tells the reader how records appear', () => {
    expect(sessionTasksEmptyCopy('empty')).toContain('kteam task create');
  });
});

test('the surface opens in its loading state with a labelled refresh control', () => {
  const html = renderToStaticMarkup(<SessionTasksSurface sessionId="session-a" />);
  expect(html).toContain('Loading tasks…');
  expect(html).toContain('aria-label="Refresh tasks"');
  // No autofocus anywhere in this surface — the host contract forbids it.
  expect(html).not.toContain('autofocus');
});
