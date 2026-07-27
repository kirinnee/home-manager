import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionView } from '../types';
import { ApiError } from '../lib/api';
import {
  BottomSheet,
  ClaudeRuntimeChoices,
  RuntimeModelControls,
  SessionDetails,
  isRuntimeEndpointUnavailable,
  modelObservationChanged,
  observedModelPresentation,
  resolveClaudeRuntimeModels,
} from './SessionDetails';
import { primeDetailsTab, resetDetailsTabMemory } from '../hooks/useDetailsTab';

function view(harness: SessionView['config']['harness'] = 'codex'): SessionView {
  return {
    config: {
      id: 'runtime-probe',
      name: 'Runtime Probe',
      binary: `${harness}-auto-probe`,
      harness,
      modelHint: 'configured-model',
      model: 'configured-model',
      mode: 'auto',
      cwd: '/tmp/probe',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      turn: 1,
      harnessSessionId: 'harness',
      tmuxSession: 'kteam-runtime-probe',
      watcherSession: 'watcher',
      intervalSeconds: 2,
      stallSeconds: 300,
      timeoutSeconds: 3600,
      maxSnapshots: 8,
      systemPromptFile: '/tmp/system.md',
      originalPromptFile: '/tmp/prompt.md',
    },
    state: {
      id: 'runtime-probe',
      status: 'awaiting_user',
      turn: 1,
      observedModel: 'actual-runtime-model',
      observedReasoningEffort: 'high',
    },
    directory: '/tmp/session',
  };
}

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

describe('in-session runtime model controls', () => {
  test('treats only an unknown runtime route as a daemon-restart requirement', () => {
    expect(
      isRuntimeEndpointUnavailable(new ApiError(404, 'no route POST /v1/sessions/s1/runtime', 'unknown_route')),
    ).toBe(true);
    expect(isRuntimeEndpointUnavailable(new ApiError(404, 'unknown kteam session s1'))).toBe(false);
    expect(isRuntimeEndpointUnavailable(new ApiError(409, 'runtime controls require an idle prompt'))).toBe(false);
  });

  test('distinguishes an old wrapper inventory from an explicitly unsupported Claude account', () => {
    const wrapper = {
      name: 'claude-auto-probe',
      harness: 'claude' as const,
      mode: 'auto' as const,
      launchable: true,
      modelHint: 'probe',
    };

    expect(resolveClaudeRuntimeModels([wrapper], wrapper.name)).toEqual({ kind: 'restart-required' });
    expect(resolveClaudeRuntimeModels([{ ...wrapper, runtimeModels: [] }], wrapper.name)).toEqual({
      kind: 'available',
      choices: [],
    });
    expect(resolveClaudeRuntimeModels([], wrapper.name)).toEqual({ kind: 'missing-wrapper' });
  });

  test('shows a Claude inventory failure instead of leaving the choices loader visible', () => {
    const html = renderToStaticMarkup(
      <ClaudeRuntimeChoices
        choices={null}
        error="wrapper inventory failed"
        submitting={false}
        disabled={false}
        onChoose={() => undefined}
      />,
    );

    expect(html).toContain('Account-aware model choices are unavailable: wrapper inventory failed');
    expect(html).not.toContain('Loading account-aware model choices');
  });

  test('uses the harness-observed fact and calls stale data last observed rather than falling back to config', () => {
    expect(observedModelPresentation('actual-runtime-model')).toEqual({
      label: 'Model (observed)',
      value: 'actual-runtime-model',
    });
    expect(observedModelPresentation('actual-runtime-model', true)).toEqual({
      label: 'Last observed model',
      value: 'actual-runtime-model',
    });
    expect(observedModelPresentation(undefined)).toEqual({ label: 'Model (observed)', value: undefined });
  });

  test('clears stale model copy only for fresh model evidence, including a same-model confirmation', () => {
    const before = { model: 'claude-sonnet-5', observedAt: '2026-07-27T00:37:00.000Z' };

    expect(modelObservationChanged(before, before)).toBe(false);
    expect(
      modelObservationChanged(before, {
        model: 'claude-sonnet-5',
        observedAt: '2026-07-27T00:38:00.000Z',
      }),
    ).toBe(true);
    expect(
      modelObservationChanged(before, {
        model: 'claude-opus-5',
        observedAt: before.observedAt,
      }),
    ).toBe(true);
  });

  test('gives Codex one labelled 44px native model-and-reasoning picker, with no independent effort control', () => {
    const html = renderToStaticMarkup(
      <RuntimeModelControls
        view={view('codex')}
        open
        canControl
        onModelSwitch={() => undefined}
        onOpenTerminal={() => true}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('Switch model in place');
    expect(html).toContain('Open model + reasoning picker in Terminal');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('account-aware native picker');
    expect(html).not.toContain('autofocus');
  });

  test('leaves unsupported harnesses with explanatory copy and no dead control', () => {
    const unsupported = view('claude');
    (unsupported.config as { harness: string }).harness = 'unsupported';
    const html = renderToStaticMarkup(
      <RuntimeModelControls
        view={unsupported}
        open
        canControl
        onModelSwitch={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('not available for this harness');
    expect(html).not.toContain('<button');
  });

  test('keeps terminal sessions honest and refuses to render a model control', () => {
    const terminal = view('codex');
    terminal.state.status = 'completed';
    const html = renderToStaticMarkup(
      <RuntimeModelControls
        view={terminal}
        open
        canControl
        onModelSwitch={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('requires a running session');
    expect(html).not.toContain('<button');
  });

  test('explains the idle-prompt requirement before allowing a runtime command', () => {
    const busy = view('codex');
    busy.state.promptReady = false;
    const html = renderToStaticMarkup(
      <RuntimeModelControls view={busy} open canControl onModelSwitch={() => undefined} onClose={() => undefined} />,
    );

    expect(html).toContain('Wait for an idle prompt before switching model');
    expect(html).toContain('disabled=""');
  });

  test('shows Codex’s reported reasoning as an observation, never as a Claude effort control', () => {
    const details = (harness: SessionView['config']['harness']) => {
      // The reasoning row lives on the Runtime tab; force it so the static
      // render (which cannot click a tab) exercises that panel.
      resetDetailsTabMemory();
      primeDetailsTab('runtime-probe', 'runtime');
      return renderToStaticMarkup(
        <SessionDetails
          id={`details-${harness}`}
          view={view(harness)}
          quota={null}
          liveStatus="open"
          open
          onClose={() => undefined}
          canControlRuntime
        />,
      );
    };

    expect(details('codex')).toContain('Last observed reasoning');
    expect(details('codex')).toContain('high');
    expect(details('claude')).not.toContain('Last observed reasoning');
  });
});

describe('details sheet tabs', () => {
  test('renders one tablist, four tabs, and only the selected panel', () => {
    resetDetailsTabMemory();
    const html = renderToStaticMarkup(
      <SessionDetails
        id="details-tabs"
        view={view('codex')}
        quota={null}
        liveStatus="open"
        open
        onClose={() => undefined}
        canControlRuntime
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)?.length).toBe(4);
    // Exactly one tabpanel is in the DOM; unselected panels never render.
    expect(html.match(/role="tabpanel"/g)?.length).toBe(1);
    // Default is Identity: its rows are present, Budget's are not.
    expect(html).toContain('Session id');
    expect(html).not.toContain('5-hour window');
    // The selected tab points at the rendered panel by id.
    expect(html).toContain('id="details-tabs-tab-identity"');
    expect(html).toContain('id="details-tabs-tabpanel-identity"');
    expect(html).toContain('aria-controls="details-tabs-tabpanel-identity"');
  });

  test('two retained instances never collide on tab or panel ids', () => {
    resetDetailsTabMemory();
    const render = (id: string) =>
      renderToStaticMarkup(
        <SessionDetails
          id={id}
          view={view('codex')}
          quota={null}
          liveStatus="open"
          open
          onClose={() => undefined}
          canControlRuntime
        />,
      );
    const combined = render('paneA') + render('paneB');
    const ids = [...combined.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('pins the view switch and controls above the tablist so Stop needs no tab', () => {
    resetDetailsTabMemory();
    const html = renderToStaticMarkup(
      <SessionDetails
        id="details-pinned"
        view={view('codex')}
        quota={null}
        liveStatus="open"
        open
        onClose={() => undefined}
        canControlRuntime
        actions={<button type="button">Stop</button>}
        viewSwitcher={<div>view-switch</div>}
      />,
    );
    // Both pinned sections appear before the tablist in source order.
    expect(html.indexOf('view-switch')).toBeGreaterThan(-1);
    expect(html.indexOf('>Stop<')).toBeGreaterThan(-1);
    expect(html.indexOf('view-switch')).toBeLessThan(html.indexOf('role="tablist"'));
    expect(html.indexOf('>Stop<')).toBeLessThan(html.indexOf('role="tablist"'));
  });
});
