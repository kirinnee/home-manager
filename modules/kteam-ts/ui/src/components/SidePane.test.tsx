// The unified side-pane host's contract, asserted the same way InAppBrowser's
// was: static markup for the structural claims (this package has no DOM
// implementation in tests), pure functions for the policy. What matters here:
//
//   1. The desktop pane is NON-MODAL — role=complementary, no aria-modal, and
//      the conversation stays rendered beside it.
//   2. Nothing autofocuses on open (no autoFocus attribute in pane markup).
//   3. State is remembered PER SESSION and never leaks across ids.
//   4. The mobile presentation advertises a dialog; the desktop one a pane.
//   5. Stateful browser and terminal surfaces remain retained across tabs.

import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  readSidePaneState,
  resetSidePaneStates,
  RETAINED_SURFACES,
  sidePaneAnnouncement,
  SidePaneShell,
  SidePaneBento,
  SidePaneWorkspace,
  SIDE_PANE_SURFACES,
  useSidePane,
  writeSidePaneState,
  type SidePaneHost,
} from './SidePane';
import { browserDestination } from './InAppBrowser';

let capturedHost: SidePaneHost | null = null;

function HostProbe() {
  capturedHost = useSidePane();
  return <span data-host-probe="ready" />;
}

afterEach(() => {
  resetSidePaneStates();
  capturedHost = null;
});

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
    expect(Object.keys(SIDE_PANE_SURFACES)).toEqual([
      'browser',
      'files',
      'tasks',
      'pins',
      'terminals',
      'skills',
      'lineage',
      'analytics',
      'attention',
      'mcp',
    ]);
    for (const meta of Object.values(SIDE_PANE_SURFACES)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.closeLabel.length).toBeGreaterThan(0);
    }
    expect(SIDE_PANE_SURFACES.mcp.unavailableReason).toBe('No MCP data source is connected yet.');
  });
});

describe('retention policy', () => {
  test('browser and terminals survive tab switches; transient surfaces remount', () => {
    expect(RETAINED_SURFACES.has('browser')).toBe(true);
    expect(RETAINED_SURFACES.has('terminals')).toBe(true);
    for (const surface of ['files', 'tasks', 'pins', 'skills', 'lineage', 'analytics', 'attention'] as const) {
      expect(RETAINED_SURFACES.has(surface)).toBe(false);
    }
  });
});

test('the host exposes the same cwd used by Files and task/pin prose', async () => {
  const source = await Bun.file(new URL('./SidePane.tsx', import.meta.url)).text();
  expect(source).toContain('surface: state.surface, cwd, open');
  expect(source).toContain('<SessionTasksSurface');
  expect(source).toContain('cwd={cwd}');
  expect(source).toContain('<PinSurface');
  expect(source).toContain('onTaskOpen={onTaskOpen}');
  expect(source).toContain('onCodeReferenceOpen={onCodeReferenceOpen}');
});

describe('tool bento', () => {
  test('renders the exact registry, including an honestly unavailable MCP entry', () => {
    const html = renderToStaticMarkup(
      <SidePaneBento
        host={{
          paneId: 'pane',
          presentation: 'pane',
          surface: null,
          open: () => undefined,
          close: () => undefined,
          toggle: () => undefined,
          openTask: () => undefined,
          openCodeReference: () => undefined,
        }}
        onSelect={() => undefined}
        badges={{ pins: 3, attention: 2 }}
        disabled={{}}
      />,
    );
    expect(html.match(/<button/g)?.length).toBe(Object.keys(SIDE_PANE_SURFACES).length);
    for (const meta of Object.values(SIDE_PANE_SURFACES)) expect(html).toContain(meta.label);
    expect(html).toContain('MCP, unavailable: No MCP data source is connected yet.');
    expect(html).toContain('disabled=""');
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
    expect(html).toContain('width:520px');
    expect(html).toContain('min-width:320px');
    expect(html).toContain('max-width:min(1024px, calc(100% - 288px))');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize session side pane"');
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
  test('publishes task and code-reference openers from the same atomic host', () => {
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact={false}>
        <HostProbe />
      </SidePaneWorkspace>,
    );
    expect(html).toContain('data-host-probe="ready"');
    expect(capturedHost).not.toBeNull();
    expect(typeof capturedHost?.openTask).toBe('function');
    expect(typeof capturedHost?.openCodeReference).toBe('function');
  });

  test('code-reference delivery stays monotonic and clears only the handled sequence', async () => {
    const source = await Bun.file(new URL('./SidePane.tsx', import.meta.url)).text();
    expect(source).toContain('const codeReferenceSequence = useRef(0);');
    expect(source).toContain('sequence: ++codeReferenceSequence.current');
    expect(source).toContain('requestedReference={requestedCodeReference}');
    expect(source).toContain('current?.sequence === sequence ? null : current');
  });

  test('desktop keeps the conversation rendered beside an open surface and steals no focus', () => {
    writeSidePaneState('session-a', { surface: 'tasks', browser: null });
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact={false}>
        <main data-conversation="visible">Conversation</main>
      </SidePaneWorkspace>,
    );
    expect(html).toContain('data-conversation="visible"');
    expect(html).toContain('role="complementary"');
    expect(html).toContain('role="tablist"');
    // Nine side-pane surfaces plus the Task surface's List/Kanban/DAG tabs.
    expect(html.match(/role="tab"/g)?.length).toBe(12);
    expect(html).toContain('role="tabpanel"');
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

  test('the Browser tab has a usable home before any transcript link was opened', () => {
    writeSidePaneState('session-a', { surface: 'browser', browser: null });
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact={false}>
        <main>Conversation</main>
      </SidePaneWorkspace>,
    );
    expect(html).toContain('aria-label="Browser engine"');
    expect(html).toContain('Where to?');
    expect(html).toContain('Nothing opens until you choose where to go.');
    expect(html).not.toContain('autofocus');
  });

  test('the Terminals tab hosts the real retained terminal deck', () => {
    writeSidePaneState('session-a', { surface: 'terminals', browser: null });
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact={false} cwd="/repo/worktree">
        <main>Conversation</main>
      </SidePaneWorkspace>,
    );
    expect(html).toContain('aria-label="Shell terminals"');
    expect(html).toContain('No shell terminals open');
    expect(html).toContain('/repo/worktree');
    expect(html).not.toContain('Terminals are not available in this build.');
    expect(html).not.toContain('autofocus');
  });

  test('the Attention tab hosts the durable attention ledger without taking focus', () => {
    writeSidePaneState('session-a', { surface: 'attention', browser: null });
    const html = renderToStaticMarkup(
      <SidePaneWorkspace sessionId="session-a" compact={false}>
        <main>Conversation</main>
      </SidePaneWorkspace>,
    );
    expect(html).toContain('Nothing needs attention.');
    expect(html).toContain('Close attention');
    expect(html).not.toContain('autofocus');
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
    expect(html).toContain('kt-sheet-tabs');
    expect(html.match(/role="tab"/g)?.length).toBe(9);
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
