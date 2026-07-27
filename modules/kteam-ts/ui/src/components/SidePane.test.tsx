// The unified side-pane host's contract, asserted the same way InAppBrowser's
// was: static markup for the structural claims (this package has no DOM
// implementation in tests), pure functions for the policy. What matters here:
//
//   1. The desktop pane is NON-MODAL — role=complementary, no aria-modal, and
//      the conversation stays rendered beside it.
//   2. Nothing autofocuses on open (no autoFocus attribute in pane markup).
//   3. State is remembered PER SESSION and never leaks across ids.
//   4. The mobile presentation advertises a dialog; the desktop one a pane.

import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  readSidePaneState,
  resetSidePaneStates,
  sidePaneAnnouncement,
  SidePaneShell,
  SidePaneWorkspace,
  SIDE_PANE_SURFACES,
  writeSidePaneState,
} from './SidePane';
import { browserDestination } from './InAppBrowser';

afterEach(() => resetSidePaneStates());

describe('per-session memory', () => {
  test('remembers the open surface per session id and never across ids', () => {
    writeSidePaneState('session-a', { surface: 'files', browser: null });
    expect(readSidePaneState('session-a').surface).toBe('files');
    expect(readSidePaneState('session-b').surface).toBeNull();
  });

  test('the browser payload rides with the surface', () => {
    const destination = browserDestination('https://example.com/docs', 'https://app.example.test/')!;
    writeSidePaneState('session-a', { surface: 'browser', browser: destination });
    expect(readSidePaneState('session-a').browser?.href).toBe('https://example.com/docs');
  });
});

describe('announcements', () => {
  test('desktop names the placement, mobile does not claim one', () => {
    expect(sidePaneAnnouncement('pins', 'pane', null)).toBe('Opened Pins beside the conversation');
    expect(sidePaneAnnouncement('pins', 'sheet', null)).toBe('Opened Pins');
  });
  test('the browser surface names its URL', () => {
    const destination = browserDestination('https://example.com/docs', 'https://app.example.test/')!;
    expect(sidePaneAnnouncement('browser', 'pane', destination)).toContain('https://example.com/docs');
  });
  test('every surface has a label and a close label', () => {
    for (const meta of Object.values(SIDE_PANE_SURFACES)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.closeLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('desktop pane shell', () => {
  test('is a bounded non-modal complementary pane', () => {
    const html = renderToStaticMarkup(
      <SidePaneShell id="side-pane" titleId="side-pane-title" onClose={() => undefined}>
        <h2 id="side-pane-title">Pins</h2>
      </SidePaneShell>,
    );
    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-labelledby="side-pane-title"');
    expect(html).toContain('width:clamp(320px, 44%, 680px)');
    expect(html).not.toContain('aria-modal');
  });

  test('hidden retention keeps DOM without layout or a label claim', () => {
    const html = renderToStaticMarkup(
      <SidePaneShell id="side-pane" titleId="side-pane-title" onClose={() => undefined} hidden>
        <div data-retained="yes" />
      </SidePaneShell>,
    );
    expect(html).toContain('data-retained="yes"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('invisible');
    expect(html).not.toContain('aria-labelledby');
  });
});

describe('workspace', () => {
  test('desktop keeps the conversation rendered beside an open surface and steals no focus', () => {
    writeSidePaneState('session-a', { surface: 'tasks', browser: null });
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact={false}>
        <main data-conversation="visible">Conversation</main>
      </SidePaneWorkspace>,
    );
    expect(html).toContain('data-conversation="visible"');
    expect(html).toContain('role="complementary"');
    expect(html).toContain('Opened Tasks beside the conversation');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('autofocus');
  });

  test('closed is genuinely nothing: no pane, no sheet, no announcement', () => {
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact={false}>
        <main data-conversation="visible">Conversation</main>
      </SidePaneWorkspace>,
    );
    expect(html).toContain('data-conversation="visible"');
    expect(html).not.toContain('role="complementary"');
    expect(html).not.toContain('Opened');
  });

  test('compact hosts the surface in the shared focus-trapped sheet', () => {
    writeSidePaneState('session-a', { surface: 'pins', browser: null });
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact>
        <main data-conversation="visible">Conversation</main>
      </SidePaneWorkspace>,
    );
    // The conversation STAYS MOUNTED behind the sheet — draft and scroll survive.
    expect(html).toContain('data-conversation="visible"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(SIDE_PANE_SURFACES.pins.closeLabel);
    expect(html).not.toContain('role="complementary"');
  });

  test('a retained background pane (compact) drops its open sheet instead of trapping from behind', () => {
    writeSidePaneState('session-a', { surface: 'files', browser: null });
    renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact active={false}>
        <main>Conversation</main>
      </SidePaneWorkspace>,
    );
    // Static render runs no effects, so assert the POLICY input is what the
    // effect keys on: state survives the render (the effect, not the render,
    // closes it in a live tree). The real closing behaviour needs a DOM runner;
    // recorded as unverifiable-here in the summary.
    expect(readSidePaneState('session-a').surface).toBe('files');
  });
});
